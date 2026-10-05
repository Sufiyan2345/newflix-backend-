import Season from '../models/Season.js';
import Episode from '../models/Episode.js';
import Title from '../models/Title.js';
import Notification from '../models/Notification.js';
import Watchlist from '../models/Watchlist.js';
import { logAdminAction } from '../middleware/activityLog.js';

// Editable fields only. The season/episode edit forms used to post the whole loaded
// document back, which wrote stale copies of server-managed keys (_id, season/series
// refs, createdAt/updatedAt, __v) over the live document.
const SEASON_EDITABLE = ['seasonNumber', 'name', 'posterUrl', 'description'];
const EPISODE_EDITABLE = [
  'episodeNumber', 'title', 'description', 'thumbnailUrl', 'videoUrl',
  'videoSourceType', 'durationMinutes', 'releaseDate', 'status',
  'audioTracks', 'subtitleTracks',
  // Skip markers (SRS §10 / Admin 12-13) — edited in Series & Episodes
  'recapStart', 'recapEnd', 'introStart', 'introEnd',
];

const pickEditable = (body, allowed) => {
  const out = {};
  const src = body || {};
  for (const key of allowed) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out;
};

// ---------- SEASONS ----------
// @route GET /api/admin/titles/:id/seasons
export const listSeasons = async (req, res) => {
  const seasons = await Season.find({ title: req.params.id }).sort({ seasonNumber: 1 });
  res.json({ items: seasons });
};

// @route POST /api/admin/titles/:id/seasons { seasonNumber, name, posterUrl, description }
export const createSeason = async (req, res) => {
  try {
    const title = await Title.findById(req.params.id);
    if (!title) return res.status(404).json({ message: 'Title not found' });
    const { seasonNumber, name = '', posterUrl = '', description = '' } = req.body;
    if (!seasonNumber) return res.status(400).json({ message: 'seasonNumber is required' });
    const season = await Season.create({ title: title._id, seasonNumber, name, posterUrl, description, createdBy: req.user?._id, updatedBy: req.user?._id });
    await logAdminAction(req, 'CREATE_SEASON', 'seasons', season._id, `${title.title} S${seasonNumber}`);
    res.status(201).json({ season });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'That season number already exists for this series' });
    res.status(500).json({ message: 'Failed to create season' });
  }
};

// @route PUT /api/admin/seasons/:id
export const updateSeason = async (req, res) => {
  try {
    const update = pickEditable(req.body, SEASON_EDITABLE);
    if (!Object.keys(update).length) return res.status(400).json({ message: 'No valid fields to update' });
    update.updatedBy = req.user?._id; // governance: record who last edited this season
    const season = await Season.findByIdAndUpdate(req.params.id, { $set: update }, { new: true, runValidators: true });
    if (!season) return res.status(404).json({ message: 'Season not found' });
    await logAdminAction(req, 'UPDATE_SEASON', 'seasons', season._id, `S${season.seasonNumber}`);
    res.json({ season });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'That season number already exists for this series' });
    console.error('updateSeason:', err);
    res.status(500).json({ message: 'Failed to update season', detail: err.message });
  }
};

// @route DELETE /api/admin/seasons/:id
export const deleteSeason = async (req, res) => {
  try {
    const season = await Season.findByIdAndDelete(req.params.id);
    if (!season) return res.status(404).json({ message: 'Season not found' });
    await Episode.deleteMany({ season: season._id });
    await logAdminAction(req, 'DELETE_SEASON', 'seasons', season._id, `S${season.seasonNumber}`);
    res.json({ message: 'Season and its episodes deleted' });
  } catch {
    res.status(500).json({ message: 'Failed to delete season' });
  }
};

// ---------- EPISODES ----------
// @route GET /api/admin/seasons/:id/episodes
export const listEpisodes = async (req, res) => {
  const episodes = await Episode.find({ season: req.params.id }).sort({ episodeNumber: 1 });
  res.json({ items: episodes });
};

// @route POST /api/admin/seasons/:id/episodes { episodeNumber, title, description, thumbnailUrl, videoUrl, durationMinutes, releaseDate }
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

const parseM3uDuration = (line = '') => {
  const match = String(line).match(/^#EXTINF:([0-9.]+),?(.*)$/i);
  if (!match) return { durationMinutes: 0, title: '' };
  const durationSeconds = Number(match[1]);
  return {
    durationMinutes: Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.max(1, Math.round(durationSeconds / 60)) : 0,
    title: (match[2] || '').trim(),
  };
};

export const parsePlaylistText = (playlistText, startEpisodeNumber = 1, prefix = 'Episode') => {
  const text = String(playlistText || '').trim();
  if (!text) return [];

  const lines = text
    .replace(/\uFEFF/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const items = [];
  let pending = null;
  let seq = Number(startEpisodeNumber) || 1;

  for (const line of lines) {
    if (!line || line.startsWith('#EXTM3U') || line.startsWith('#EXT-X-')) continue;
    if (line.startsWith('#EXTINF')) {
      const parsed = parseM3uDuration(line);
      pending = { ...pending, durationMinutes: parsed.durationMinutes, title: parsed.title || pending?.title || '' };
      continue;
    }
    if (line.startsWith('#')) continue;

    if (pending) {
      const url = line;
      const title = pending.title || `${prefix} ${seq}`;
      items.push({
        episodeNumber: seq,
        title: title.replace(/\s+/g, ' ').trim() || `${prefix} ${seq}`,
        videoUrl: url,
        durationMinutes: pending.durationMinutes || 0,
        videoSourceType: normalizeVideoSource(url, /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'mp4'),
      });
      seq += 1;
      pending = null;
      continue;
    }

    const url = line;
    items.push({
      episodeNumber: seq,
      title: `${prefix} ${seq}`,
      videoUrl: url,
      durationMinutes: 0,
      videoSourceType: normalizeVideoSource(url, /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'mp4'),
    });
    seq += 1;
  }

  return items;
};

export const parsePlaylistUrlIntoEpisodes = async (playlistUrl, startEpisodeNumber = 1, prefix = 'Episode') => {
  const raw = String(playlistUrl || '').trim();
  if (!raw) return [];

  if (/^data:/i.test(raw)) {
    const commaIndex = raw.indexOf(',');
    if (commaIndex === -1) return [];
    const meta = raw.slice(5, commaIndex);
    const payload = raw.slice(commaIndex + 1);
    const isBase64 = /;base64/i.test(meta);
    const text = isBase64 ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload);
    return parsePlaylistText(text, startEpisodeNumber, prefix);
  }

  if (!/^https?:\/\//i.test(raw)) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(raw, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.apple.mpegurl,application/octet-stream,text/plain,*/*' },
    });
    if (!response.ok) throw new Error(`Playlist fetch failed: ${response.status}`);
    const text = await response.text();
    return parsePlaylistText(text, startEpisodeNumber, prefix);
  } finally {
    clearTimeout(timeout);
  }
};

export const createEpisode = async (req, res) => {
  try {
    const season = await Season.findById(req.params.id);
    if (!season) return res.status(404).json({ message: 'Season not found' });
    const { episodeNumber, title, description = '', thumbnailUrl = '', videoUrl = '', videoSourceType = 'mp4', durationMinutes = 0, releaseDate, status = 'published', recapStart = 0, recapEnd = 0, introStart = 0, introEnd = 0 } = req.body;
    if (!episodeNumber || !title) return res.status(400).json({ message: 'episodeNumber and title are required' });

    const safeVideoUrl = String(videoUrl || '').trim();
    const episode = await Episode.create({
      season: season._id, series: season.title, episodeNumber, title, description,
      thumbnailUrl, videoUrl: safeVideoUrl, videoSourceType: normalizeVideoSource(safeVideoUrl, videoSourceType), durationMinutes, releaseDate, status,
      recapStart: Number(recapStart) || 0, recapEnd: Number(recapEnd) || 0,
      introStart: Number(introStart) || 0, introEnd: Number(introEnd) || 0,
      createdBy: req.user?._id, updatedBy: req.user?._id,
    });

    // Notify users who have this series in their list (SRS §6.3 auto-notify)
    const watchers = await Watchlist.find({ title: season.title }).populate('profile', 'user');
    const userIds = [...new Set(watchers.map((w) => w.profile?.user?.toString()).filter(Boolean))];
    if (userIds.length) {
      const series = await Title.findById(season.title).select('title');
      await Notification.insertMany(
        userIds.map((uid) => ({
          user: uid, type: 'new-episode',
          title: `New episode of ${series?.title || 'a series you follow'}`,
          message: `S${season.seasonNumber}E${episodeNumber}: ${title} is now available to stream.`,
          link: `/watch/${season.title}?episode=${episode._id}`,
        }))
      );
    }

    await logAdminAction(req, 'CREATE_EPISODE', 'episodes', episode._id, title);
    res.status(201).json({ episode });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'That episode number already exists in this season' });
    res.status(500).json({ message: 'Failed to create episode' });
  }
};

// @route POST /api/admin/seasons/:id/episodes/bulk { items: [{ episodeNumber, title, videoUrl, ... }] } (SRS §6.3)
export const bulkCreateEpisodes = async (req, res) => {
  try {
    const season = await Season.findById(req.params.id);
    if (!season) return res.status(404).json({ message: 'Season not found' });

    let items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 200) : [];
    if (!items.length && (req.body?.playlistUrl || req.body?.playlistText)) {
      const startEpisodeNumber = Number(req.body.startEpisodeNumber) || 1;
      if (req.body.playlistUrl) {
        items = await parsePlaylistUrlIntoEpisodes(req.body.playlistUrl, startEpisodeNumber);
      } else {
        items = parsePlaylistText(req.body.playlistText, startEpisodeNumber);
      }
    }

    if (!items.length) return res.status(400).json({ message: 'No episodes provided' });
    const docs = [];
    for (const it of items) {
      const episodeNumber = Number(it.episodeNumber);
      if (!episodeNumber || !it.title) continue;
      const videoUrl = String(it.videoUrl || '').trim().slice(0, 800);
      const videoSourceType = normalizeVideoSource(videoUrl, it.videoSourceType);
      docs.push({
        season: season._id, series: season.title, episodeNumber,
        title: String(it.title).slice(0, 200),
        description: String(it.description || '').slice(0, 2000),
        thumbnailUrl: String(it.thumbnailUrl || '').slice(0, 500),
        videoUrl,
        videoSourceType,
        durationMinutes: Number(it.durationMinutes) || 0,
        releaseDate: it.releaseDate || undefined,
        recapStart: Number(it.recapStart) || 0,
        recapEnd: Number(it.recapEnd) || 0,
        introStart: Number(it.introStart) || 0,
        introEnd: Number(it.introEnd) || 0,
        status: ['draft', 'published', 'unpublished'].includes(it.status) ? it.status : 'published',
        createdBy: req.user?._id, updatedBy: req.user?._id,
      });
    }
    if (!docs.length) return res.status(400).json({ message: 'No valid episodes found (each line needs number and title)' });
    const inserted = await Episode.insertMany(docs, { ordered: false });
    await logAdminAction(req, 'BULK_EPISODES', 'episodes', season._id, `${inserted.length} episodes added`);
    res.status(201).json({ createdCount: inserted.length, episodes: inserted });
  } catch (err) {
    if (err.writeErrors) {
      return res.status(409).json({ message: `${err.insertedDocs?.length || 0} added, ${err.writeErrors.length} skipped (duplicate episode numbers).` });
    }
    console.error('bulkCreateEpisodes:', err);
    res.status(500).json({ message: 'Bulk episode upload failed' });
  }
};

// @route PUT /api/admin/seasons/:id/episodes/reorder { order: [episodeId, ...] } (SRS §6.3 reorder)
export const reorderEpisodes = async (req, res) => {
  try {
    const { order } = req.body || {};
    if (!Array.isArray(order) || !order.length) return res.status(400).json({ message: 'order array of episode ids is required' });
    if (order.length > 500) return res.status(400).json({ message: 'Too many episodes in one reorder' });

    const all = await Episode.find({ season: req.params.id }).sort({ episodeNumber: 1 }).select('_id');
    const wanted = order.map(String);
    const known = all.map((e) => String(e._id));
    const invalid = wanted.filter((id) => !known.includes(id));
    if (invalid.length) return res.status(400).json({ message: 'order contains episodes from another season' });

    // Final sequence: episodes in the requested order, then any others keep relative order after them
    const listedSet = new Set(wanted);
    const finalOrder = [...wanted, ...known.filter((id) => !listedSet.has(id))];

    // Phase 1: park every episode at a temporary negative number so the unique
    // (season, episodeNumber) index can never collide mid-update.
    await Episode.bulkWrite(finalOrder.map((id, i) => ({
      updateOne: { filter: { _id: id }, update: { $set: { episodeNumber: -(i + 1) } } },
    })));
    // Phase 2: assign the final 1..n numbers
    await Episode.bulkWrite(finalOrder.map((id, i) => ({
      updateOne: { filter: { _id: id }, update: { $set: { episodeNumber: i + 1 } } },
    })));

    const episodes = await Episode.find({ season: req.params.id }).sort({ episodeNumber: 1 });
    await logAdminAction(req, 'REORDER_EPISODES', 'episodes', req.params.id, `${finalOrder.length} episodes reordered`);
    res.json({ episodes });
  } catch (err) {
    console.error('reorderEpisodes:', err);
    res.status(500).json({ message: 'Reorder failed' });
  }
};

// @route PUT /api/admin/episodes/:id
export const updateEpisode = async (req, res) => {
  try {
    const update = pickEditable(req.body, EPISODE_EDITABLE);
    const op = {};

    // An empty release date means "clear it" rather than saving an invalid date
    if ('releaseDate' in update && (update.releaseDate === '' || update.releaseDate === null)) {
      delete update.releaseDate;
      op.$unset = { releaseDate: 1 };
    }
    if (Object.keys(update).length) op.$set = update;
    if (op.$set) op.$set.updatedBy = req.user?._id; // governance: record who last edited this episode
    if (!op.$set && !op.$unset) {
      return res.status(400).json({ message: 'No valid fields to update' });
    }

    const episode = await Episode.findByIdAndUpdate(req.params.id, op, { new: true, runValidators: true });
    if (!episode) return res.status(404).json({ message: 'Episode not found' });
    await logAdminAction(req, 'UPDATE_EPISODE', 'episodes', episode._id, episode.title);
    res.json({ episode });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'That episode number already exists in this season' });
    console.error('updateEpisode:', err);
    res.status(500).json({ message: 'Failed to update episode', detail: err.message });
  }
};

// @route DELETE /api/admin/episodes/:id
export const deleteEpisode = async (req, res) => {
  try {
    const episode = await Episode.findByIdAndDelete(req.params.id);
    if (!episode) return res.status(404).json({ message: 'Episode not found' });
    await logAdminAction(req, 'DELETE_EPISODE', 'episodes', episode._id, episode.title);
    res.json({ message: 'Episode deleted' });
  } catch {
    res.status(500).json({ message: 'Failed to delete episode' });
  }
};
