import Title from '../models/Title.js';
import Genre from '../models/Genre.js';
import AdminActivityLog from '../models/AdminActivityLog.js';
import User from '../models/User.js';
import Episode from '../models/Episode.js';
import Season from '../models/Season.js';
import WatchHistory from '../models/WatchHistory.js';
import { logAdminAction } from '../middleware/activityLog.js';
import { resolveSource, resolveVidplay, VIDPLAY_HOSTS } from './titleDetailController.js';

const slugify = (s) => s.toString().toLowerCase().trim()
  .replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

const daysAgo = (d) => new Date(Date.now() - d * 24 * 60 * 60 * 1000);

const normalizeGenres = (genres = []) => {
  const unique = [];
  const seen = new Set();
  for (const item of Array.isArray(genres) ? genres : []) {
    const id = typeof item === 'string' ? item : (item && item._id ? String(item._id) : '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique.slice(0, 3);
};

const normalizeVideoSource = (videoUrl, declaredType = '') => {
  const url = String(videoUrl || '').trim();
  const type = String(declaredType || '').toLowerCase();
  if (!url) return type || 'mp4';
  if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
  if (/(^|\.)stremio(\.|$)|stremio:/i.test(url) || type === 'stremio') return 'stremio';
  if (/youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|drive\.google\.com|docs\.google\.com|googleusercontent\.com|googledrive\.com/i.test(url)) return 'embed';
  if (type === 'cloudinary') return 'cloudinary';
  if (type === 'hls') return 'hls';
  if (type === 'embed') return 'embed';
  if (type === 'mp4') return 'mp4';
  return 'mp4';
};

// ---------- DASHBOARD (SRS §6.1) ----------
// @route GET /api/admin/dashboard
export const dashboard = async (req, res) => {
  try {
    const [totalMovies, totalSeries, totalEpisodes, totalUsers, totalViewsAgg, logs,
      viewsToday, viewsWeek, viewsMonth, signupsByDay, recentWatches] = await Promise.all([
      Title.countDocuments({ type: 'movie' }),
      Title.countDocuments({ type: 'series' }),
      Episode.countDocuments(),
      User.countDocuments({ role: 'user' }),
      Title.aggregate([{ $group: { _id: null, views: { $sum: '$viewCount' } } }]),
      AdminActivityLog.find().sort({ createdAt: -1 }).limit(10).populate('admin', 'name email'),
      WatchHistory.countDocuments({ lastWatchedAt: { $gte: daysAgo(1) } }),
      WatchHistory.countDocuments({ lastWatchedAt: { $gte: daysAgo(7) } }),
      WatchHistory.countDocuments({ lastWatchedAt: { $gte: daysAgo(30) } }),
      User.aggregate([
        { $match: { createdAt: { $gte: daysAgo(14) } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      WatchHistory.aggregate([
        { $match: { lastWatchedAt: { $gte: daysAgo(7) } } },
        { $group: { _id: '$title', watches: { $sum: 1 } } },
        { $sort: { watches: -1 } }, { $limit: 8 },
        { $lookup: { from: 'titles', localField: '_id', foreignField: '_id', as: 'title' } },
        { $unwind: '$title' },
        { $project: { _id: '$title._id', title: '$title.title', type: '$title.type', posterUrl: '$title.posterUrl', watches: 1 } },
      ]),
    ]);
    const topTitles = await Title.find().sort({ viewCount: -1 }).limit(8).select('title type viewCount posterUrl avgRating');
    const topGenres = await Title.aggregate([
      { $unwind: '$genres' },
      { $group: { _id: '$genres', count: { $sum: 1 }, views: { $sum: '$viewCount' } } },
      { $sort: { views: -1 } }, { $limit: 8 },
      { $lookup: { from: 'genres', localField: '_id', foreignField: '_id', as: 'genre' } },
      { $unwind: '$genre' },
      { $project: { name: '$genre.name', count: 1, views: 1 } },
    ]);
    res.json({
      stats: {
        totalMovies, totalSeries, totalEpisodes, totalUsers,
        totalViews: totalViewsAgg[0]?.views || 0,
        viewsToday, viewsWeek, viewsMonth, // SRS §6.1 today/week/month
      },
      signupsByDay,      // SRS §6.1 new signups over time (last 14 days)
      trendingThisWeek: recentWatches,
      topTitles, topGenres, recentActivity: logs,
    });
  } catch (err) {
    console.error('dashboard:', err);
    res.status(500).json({ message: 'Failed to load dashboard' });
  }
};

// ---------- TITLES CRUD ----------
// @route GET /api/admin/titles?q=&type=&status=&page=
export const adminListTitles = async (req, res) => {
  try {
    const { q, type, status, page = 1, limit = 12 } = req.query;
    const filter = {};
    if (q) filter.title = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (type) filter.type = type;
    if (status) filter.status = status;
    const [items, total] = await Promise.all([
      Title.find(filter).sort({ createdAt: -1 }).skip((Number(page) - 1) * Number(limit)).limit(Number(limit)).populate('genres'),
      Title.countDocuments(filter),
    ]);
    res.json({ items, total, pages: Math.ceil(total / Number(limit)) });
  } catch {
    res.status(500).json({ message: 'Failed to list titles' });
  }
};

// @route POST /api/admin/titles
export const createTitle = async (req, res) => {
  try {
    const body = req.body;
    if (!body.title || !body.type || !body.posterUrl)
      return res.status(400).json({ message: 'title, type and posterUrl are required' });
    const cleanBody = {
      ...body,
      videoUrl: String(body.videoUrl || '').trim(),
      videoSourceType: normalizeVideoSource(body.videoUrl, body.videoSourceType),
      genres: normalizeGenres(body.genres),
    };
    let slug = slugify(cleanBody.title);
    if (await Title.findOne({ slug })) slug = `${slug}-${Date.now().toString(36)}`;
    const title = await Title.create({ ...cleanBody, slug, createdBy: req.user?._id, updatedBy: req.user?._id });
    await logAdminAction(req, 'CREATE_TITLE', 'titles', title._id, title.title);
    res.status(201).json({ title });
  } catch (err) {
    console.error('createTitle:', err);
    res.status(500).json({ message: 'Failed to create title' });
  }
};

// Fields an admin may change from the Title form. Everything else on the document
// (slug, createdAt/updatedAt, viewCount, watchCount, avgRating, ratingCount,
// maturityScore, matchPercentage) is server-managed: the edit form used to post the
// whole loaded document back, so saving an edit silently wrote STALE copies of those
// values over the live document — a title rated 9/10 reverted to the old average and
// view counts went backwards. Only editable keys are accepted now.
const TITLE_EDITABLE = [
  'type', 'title', 'description', 'posterUrl', 'bannerUrl', 'logoUrl', 'tagline',
  'trailerUrl', 'videoUrl',
  'videoSourceType', 'genres', 'cast', 'director', 'releaseYear', 'durationMinutes',
  'ageRating', 'language', 'status', 'seriesStatus', 'isTrending', 'isNewRelease',
  'isFeatured', 'isTop10', 'isKids', 'tags', 'audioLanguages', 'audioTracks', 'subtitleTracks',
];

// Build a $set payload containing only whitelisted, editable keys.
const pickEditable = (body, allowed) => {
  const out = {};
  const src = body || {};
  for (const key of allowed) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out;
};

// @route PUT /api/admin/titles/:id
export const updateTitle = async (req, res) => {
  try {
    const update = pickEditable(req.body, TITLE_EDITABLE);
    if (!Object.keys(update).length) return res.status(400).json({ message: 'No valid fields to update' });
    if (update.videoUrl !== undefined) update.videoUrl = String(update.videoUrl || '').trim();
    if (update.genres !== undefined) update.genres = normalizeGenres(update.genres);
    if (update.videoUrl || update.videoSourceType !== undefined) {
      update.videoSourceType = normalizeVideoSource(update.videoUrl ?? '', update.videoSourceType ?? '');
    }

    const current = await Title.findById(req.params.id).select('title slug');
    if (!current) return res.status(404).json({ message: 'Title not found' });

    // Keep the public slug in sync when the name changes (must stay unique)
    if (update.title && update.title !== current.title) {
      let slug = slugify(update.title);
      if (await Title.findOne({ slug, _id: { $ne: current._id } })) slug = `${slug}-${Date.now().toString(36)}`;
      update.slug = slug;
    }

    update.updatedBy = req.user?._id; // governance: record who last edited this title
    const title = await Title.findByIdAndUpdate(req.params.id, { $set: update }, { new: true, runValidators: true });
    await logAdminAction(req, 'UPDATE_TITLE', 'titles', title._id, title.title);
    res.json({ title });
  } catch (err) {
    console.error('updateTitle:', err);
    if (err.code === 11000) return res.status(409).json({ message: 'Another title already uses that name' });
    res.status(500).json({ message: 'Failed to update title', detail: err.message });
  }
};

// @route GET /api/admin/video/resolve?url=&type=
// Runs the exact same link resolution the user-side player uses, so the admin panel
// can preview a pasted link INSIDE the panel (iframe / native) instead of opening a
// new tab — what you preview is exactly what plays on the site.
export const resolveVideoLink = async (req, res) => {
  const url = String(req.query.url || '').trim();
  const type = String(req.query.type || '').trim();
  if (!url) return res.json({ url: '', type: type || 'mp4', provider: 'none' });
  // VidPlay watch pages load their real player through ajax endpoints (the page
  // itself refuses framing) — resolve to that player so the in-panel preview is
  // exactly what visitors watch.
  try {
    if (VIDPLAY_HOSTS.test(new URL(url).hostname)) {
      const resolved = await resolveVidplay(url);
      return res.json({
        ...resolved,
        provider: resolved.type === 'embed'
          ? 'vidplay (real player resolved)'
          : 'vidplay (could not resolve — opens in new tab)',
      });
    }
  } catch { /* not a parseable URL — generic path below */ }
  const resolved = resolveSource(url, type);
  let provider = 'page';
  if (/\byoutube\.com|\byoutu\.be/i.test(url)) provider = 'youtube';
  else if (/\bbilibili\.com/i.test(url)) provider = 'bilibili';
  else if (/\bdailymotion\.com|\bdai\.ly/i.test(url)) provider = 'dailymotion';
  else if (/\bvimeo\.com/i.test(url)) provider = 'vimeo';
  else if (/\bdrive\.google\.com|\bdocs\.google\.com/i.test(url)) provider = 'google-drive';
  else if (/stremio/i.test(url)) provider = 'stremio';
  else if (/\bnebulawatch\.tech/i.test(url)) provider = 'nebula (videasy player)';
  else if (/\bplayer\.videasy\.(net|to)/i.test(url)) provider = 'videasy';
  else if (/zenox\.(lol|cc)/i.test(url)) provider = 'zenox (blocks embedding — opens in new tab)';
  else if (/\.(mp4|m4v|webm|mov|mkv|m3u8|mpd)(\?.*)?$/i.test(url)) provider = 'file';
  res.json({ ...resolved, provider });
};

// Platforms verified to allow playback inside another site's iframe.
// Everything else gets probed on demand (see checkEmbeddable).
const FRAME_FRIENDLY = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|bilibili\.com|dailymotion\.com|dai\.ly|vimeo\.com|ok\.ru|rutube\.ru|vk\.com|vkvideo\.ru|archive\.org|streamable\.com|loom\.com|drive\.google\.com|facebook\.com|instagram\.com|player\.videasy\.net|player\.videasy\.to|ythd\.org|vidfast\.pro|peachify\.top)$/i;

// @route GET /api/admin/video/embeddable?url=
// Tells the admin panel whether a link can actually play inside our own page.
// DRM/licensed sites (Viki, Netflix, Prime, Disney+ …) send X-Frame-Options or CSP
// frame-ancestors and simply cannot be embedded — better to know before saving.
export const checkEmbeddable = async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) return res.json({ embeddable: 'unknown' });
  let host = '';
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return res.json({ embeddable: 'unknown', reason: 'invalid url' }); }
  if (FRAME_FRIENDLY.test(host)) return res.json({ embeddable: true, trusted: true });

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    const r = await fetch(url, {
      redirect: 'follow', signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: process.env.CLIENT_URL || 'http://localhost:5173/' },
    });
    clearTimeout(timer);
    const xfo = (r.headers.get('x-frame-options') || '').toLowerCase();
    const csp = (r.headers.get('content-security-policy') || '').toLowerCase();
    const fa = (csp.match(/frame-ancestors[^;]*/) || [''])[0];
    const blocked = /deny|sameorigin/.test(xfo) || (/frame-ancestors/.test(fa) && !/frame-ancestors\s+\*/.test(fa));
    return res.json({
      embeddable: !blocked,
      blockedBy: blocked ? (xfo || fa).trim() : '',
    });
  } catch (err) {
    return res.json({ embeddable: 'unknown', reason: err.name === 'AbortError' ? 'timed out' : 'unreachable' });
  }
};

// @route DELETE /api/admin/titles/:id
export const deleteTitle = async (req, res) => {
  try {
    const title = await Title.findByIdAndDelete(req.params.id);
    if (!title) return res.status(404).json({ message: 'Title not found' });
    await Episode.deleteMany({ series: title._id });
    const seasons = await Season.deleteMany({ title: title._id });
    await logAdminAction(req, 'DELETE_TITLE', 'titles', title._id, `${title.title} (+${seasons.deletedCount} seasons)`);
    res.json({ message: 'Title and all its seasons/episodes deleted' });
  } catch {
    res.status(500).json({ message: 'Failed to delete title' });
  }
};

// @route PUT /api/admin/titles/:id/flags
export const toggleFlags = async (req, res) => {
  try {
    const allowed = ['isTrending', 'isFeatured', 'isTop10', 'isNewRelease', 'isKids', 'status'];
    const set = {};
    allowed.forEach((k) => { if (req.body[k] !== undefined) set[k] = req.body[k]; });
    set.updatedBy = req.user?._id; // governance: record who toggled the flags
    const title = await Title.findByIdAndUpdate(req.params.id, { $set: set }, { new: true });
    if (!title) return res.status(404).json({ message: 'Title not found' });
    await logAdminAction(req, 'UPDATE_FLAGS', 'titles', title._id, JSON.stringify(set));
    res.json({ title });
  } catch {
    res.status(500).json({ message: 'Failed to update flags' });
  }
};

// @route POST /api/admin/titles/:id/duplicate (SRS §6.2)
export const duplicateTitle = async (req, res) => {
  try {
    const src = await Title.findById(req.params.id);
    if (!src) return res.status(404).json({ message: 'Title not found' });
    const obj = src.toObject();
    delete obj._id; delete obj.createdAt; delete obj.updatedAt; delete obj.__v;
    obj.title = `${src.title} (Copy)`;
    obj.slug = `${src.slug}-copy-${Date.now().toString(36)}`;
    obj.status = 'draft'; // always import copies as draft so they can't go live half-configured
    obj.viewCount = 0; obj.watchCount = 0;
    obj.createdBy = req.user?._id; obj.updatedBy = req.user?._id; // copy is owned by whoever duplicated it
    const copy = await Title.create(obj);
    await logAdminAction(req, 'DUPLICATE_TITLE', 'titles', copy._id, `from "${src.title}"`);
    res.status(201).json({ title: copy });
  } catch (err) {
    console.error('duplicateTitle:', err);
    res.status(500).json({ message: 'Failed to duplicate title' });
  }
};

// @route POST /api/admin/titles/bulk-csv { csv } (SRS §6.2 bulk upload)
// Columns: title,type,releaseYear,language,ageRating,posterUrl,description
export const bulkImportCsv = async (req, res) => {
  try {
    const csv = (typeof req.body?.csv === 'string' ? req.body.csv : '').trim();
    if (!csv) return res.status(400).json({ message: 'CSV content is required' });
    if (csv.length > 500000) return res.status(413).json({ message: 'CSV too large (max ~500KB)' });

    const parseLine = (line) => {
      const out = []; let cur = ''; let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) {
          if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (c === '"') inQ = false;
          else cur += c;
        } else if (c === '"') inQ = true;
        else if (c === ',') { out.push(cur); cur = ''; }
        else cur += c;
      }
      out.push(cur);
      return out.map((v) => v.trim());
    };

    const lines = csv.split(/\r?\n/).filter((l) => l.trim());
    const header = (lines[0] || '').toLowerCase();
    const start = header.includes('title') && header.includes('poster') ? 1 : 0; // skip header row
    const created = []; const failed = [];
    for (const line of lines.slice(start)) {
      const [title, type = 'movie', releaseYear, language, ageRating, posterUrl, description] = parseLine(line);
      if (!title || !posterUrl) { failed.push({ title: title || line.slice(0, 40), reason: 'title and posterUrl are required' }); continue; }
      let slug = slugify(title);
      if (await Title.findOne({ slug })) slug = `${slug}-${Date.now().toString(36)}`;
      try {
        const t = await Title.create({
          title: title.slice(0, 200),
          type: type === 'series' ? 'series' : 'movie',
          slug,
          releaseYear: Number(releaseYear) || undefined,
          language: language || 'English',
          ageRating: ['ALL', '7+', '13+', '16+', '18+'].includes(ageRating) ? ageRating : '13+',
          posterUrl,
          description: (description || '').slice(0, 3000),
          status: 'draft', // imported rows start as drafts — review then publish
          createdBy: req.user?._id, updatedBy: req.user?._id,
        });
        created.push(t.title);
      } catch (e) { failed.push({ title, reason: e.message }); }
    }
    await logAdminAction(req, 'BULK_IMPORT_CSV', 'titles', '', `${created.length} created, ${failed.length} failed`);
    res.json({ createdCount: created.length, failedCount: failed.length, failed });
  } catch (err) {
    console.error('bulkImportCsv:', err);
    res.status(500).json({ message: 'Bulk import failed' });
  }
};
