import Title from '../models/Title.js';
import Genre from '../models/Genre.js';
import Season from '../models/Season.js';
import Episode from '../models/Episode.js';
import WatchHistory from '../models/WatchHistory.js';
import Rating from '../models/Rating.js';
import { withMaturity, allowsTitle, maturityMessage, isKidsRequest } from '../utils/maturity.js';

// @route GET /api/titles/search?q= — instant search (title, cast, tags, genre)
export const searchTitles = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ items: [], total: 0 });
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const genre = await Genre.findOne({ name: rx });
    // A search must respect the profile's maturity ceiling too — otherwise a
    // Kids profile could surface an 18+ title just by typing its name.
    const maturity = withMaturity({}, req.profile);
    const filter = {
      status: 'published',
      $and: [
        {
          $or: [
            { title: rx },
            { description: rx },
            { tags: rx },
            { 'cast.name': rx },
            { director: rx },
            ...(genre ? [{ genres: genre._id }] : []),
          ],
        },
        ...(maturity ? [maturity] : []),
      ],
    };
    const [items, total] = await Promise.all([
      Title.find(filter).sort({ viewCount: -1 }).limit(30).populate('genres'),
      Title.countDocuments(filter),
    ]);
    res.json({ items, total, q });
  } catch (err) {
    console.error('searchTitles:', err);
    res.status(500).json({ message: 'Search failed' });
  }
};

// @route GET /api/titles/:slug — full details incl. seasons & episodes
export const getTitleBySlug = async (req, res) => {
  try {
    const title = await Title.findOne({ slug: req.params.slug, status: 'published' }).populate('genres');
    if (!title) return res.status(404).json({ message: 'Title not found' });

    // A Kids profile must not be able to open a grown-up title's detail page even
    // by typing the URL. 404 (not 403) so the title is simply not discoverable.
    if (!allowsTitle(req.profile, title)) {
      return res.status(404).json({ message: isKidsRequest(req.profile) ? 'Title not found' : maturityMessage(req.profile) });
    }

    const seasons = await Season.find({ title: title._id }).sort({ seasonNumber: 1 });
    const seasonsWithEpisodes = await Promise.all(
      seasons.map(async (s) => ({
        ...s.toObject(),
        episodes: await Episode.find({ season: s._id, status: 'published' }).sort({ episodeNumber: 1 }),
      }))
    );

    const genreIds = title.genres.map((g) => g._id);
    const moreLikeThis = await Title.find({
      _id: { $ne: title._id },
      ...withMaturity({ status: 'published' }, req.profile),
      ...(genreIds.length ? { genres: { $in: genreIds } } : {}),
    }).sort({ viewCount: -1 }).limit(12).populate('genres');

    // This profile's own rating, for the star widget (SRS §4.5)
    let yourRating = null;
    if (req.profileId) {
      const mine = await Rating.findOne({ title: title._id, profile: req.profileId }).select('rating');
      if (mine) yourRating = mine.rating;
    }

    // Continue-watching position for this profile — powers the modal's
    // "Resume" button and the "<elapsed> of <total>" bar above it.
    let resume = null;
    if (req.profileId) {
      const wh = await WatchHistory.findOne({ profile: req.profileId, title: title._id });
      if (wh && !wh.completed && wh.progressSeconds > 0) {
        resume = {
          episodeId: wh.episode || null,
          progressSeconds: wh.progressSeconds,
          durationSeconds: wh.durationSeconds,
        };
      }
    }

    Title.updateOne({ _id: title._id }, { $inc: { viewCount: 1 } }).exec();

    res.json({
      title,
      seasons: seasonsWithEpisodes,
      moreLikeThis,
      yourRating,
      resume,
      ratingCount: title.ratingCount || 0,
      // Ready-to-frame trailer (platform pages converted to their embed player)
      trailer: resolveSource(title.trailerUrl, title.videoSourceType),
    });
  } catch (err) {
    console.error('getTitleBySlug:', err);
    res.status(500).json({ message: 'Failed to load title' });
  }
};

// Smart video-type detection so admins can paste almost any link and it just plays.
// - direct media files  -> native HTML5 player (mp4/webm/mov or HLS .m3u8)
// - Stremio / YouTube / Vimeo / other providers -> embed iframe when the URL is a stream or watch page
// - any other web page  -> embed iframe (third-party watch pages)
const MEDIA_EXT = /\.(mp4|m4v|webm|mov|mkv|m3u8|mpd)(\?.*)?$/i;

const isLocalAppUrl = (url) => {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]' || host.endsWith('.localhost');
  } catch {
    return false;
  }
};

const isStremioUrl = (url) => {
  try {
    const u = new URL(url);
    return /(^|\.)stremio(\.|$)/i.test(u.hostname) || /stremio/i.test(u.pathname) || /stremio/i.test(url);
  } catch {
    return /stremio/i.test(url);
  }
};

// Turn a normal watch/share link into the provider's embeddable player URL, so the
// video can run INSIDE our own play screen. A raw watch page (youtube.com/watch?v=…)
// refuses to load in an iframe, its /embed/ equivalent does not.
const toEmbedUrl = (url) => {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const parts = u.pathname.split('/').filter(Boolean);

    // ---------- YouTube: watch?v=ID | youtu.be/ID | /shorts/ID | /live/ID ----------
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      const v = u.searchParams.get('v');
      if (v) return `https://www.youtube.com/embed/${v}`;
      if ((parts[0] === 'shorts' || parts[0] === 'live') && parts[1]) return `https://www.youtube.com/embed/${parts[1]}`;
      return url; // already an /embed/ link → keep it exactly as pasted
    }
    if (host === 'youtu.be' && parts[0]) return `https://www.youtube.com/embed/${parts[0]}`;

    // ---------- Bilibili: bilibili.com/video/BVxxxx | /video/av123 ----------
    if (host === 'bilibili.com' || host === 'm.bilibili.com' || host === 'player.bilibili.com') {
      if (host === 'player.bilibili.com') return url; // already the player
      if (parts[0] === 'video' && parts[1]) {
        const id = parts[1].replace(/\.html$/i, '');
        const q = /^av\d+$/i.test(id) ? `aid=${id.slice(2)}` : `bvid=${id}`;
        return `https://player.bilibili.com/player.html?${q}&autoplay=0&high_quality=1`;
      }
      return url;
    }

    // ---------- Dailymotion: dailymotion.com/video/xID | dai.ly/xID ----------
    if (host === 'dailymotion.com' || host === 'dai.ly') {
      let id = null;
      if (host === 'dai.ly') id = parts[0];
      else if (parts[0] === 'video' || parts[0] === 'embed') id = parts[1];
      id = id ? id.replace(/[^A-Za-z0-9]/g, '') : null;
      if (id) return `https://www.dailymotion.com/embed/video/${id}`;
      return url;
    }

    // ---------- Vimeo: vimeo.com/ID | /channels/x/ID | /video/ID ----------
    if (host === 'vimeo.com') {
      for (let i = parts.length - 1; i >= 0; i--) {
        if (/^\d+$/.test(parts[i])) return `https://player.vimeo.com/video/${parts[i]}`;
      }
      return url;
    }
    if (host === 'player.vimeo.com') return url;

    // ---------- Google Drive: /file/d/ID/view → /preview ----------
    if (host === 'drive.google.com' || host === 'docs.google.com') {
      const i = parts.indexOf('d');
      if (i >= 0 && parts[i + 1]) return `https://drive.google.com/file/d/${parts[i + 1]}/preview`;
      return url;
    }

    // ---------- Viki: /videos/1023585v-slug → official player page ----------
    if (host === 'viki.com' || host === 'm.viki.com' || /^viki\.(net|mx|jp|fr)$/.test(host)) {
      const seg = (parts[0] === 'videos' || parts[0] === 'player') ? parts[1] : null;
      const id = seg && seg.match(/^(\d+v)/i);
      if (id) return `https://www.viki.com/player/${id[1].toLowerCase()}`;
      return url;
    }

    // ---------- OK.ru: /video/ID → /videoembed/ID ----------
    if (host === 'ok.ru' || host === 'm.ok.ru') {
      const i = parts.indexOf('video');
      if (i >= 0 && parts[i + 1]) return `https://ok.ru/videoembed/${parts[i + 1]}`;
      return url;
    }

    // ---------- Rutube: /video/ID/ → /play/embed/ID ----------
    if (host === 'rutube.ru') {
      const i = parts.indexOf('video');
      if (i >= 0 && parts[i + 1]) return `https://rutube.ru/play/embed/${parts[i + 1]}`;
      return url;
    }

    // ---------- VK: /video-123_456 → video_ext.php ----------
    if (host === 'vk.com' || host === 'm.vk.com' || host === 'vkvideo.ru') {
      const seg = parts.find((p) => /^video-?\d+_\d+$/i.test(p));
      if (seg) {
        const [oid, vid] = seg.replace(/^video/i, '').split('_');
        return `https://vk.com/video_ext.php?oid=${oid}&id=${vid}&hd=2`;
      }
      return url;
    }

    // ---------- Facebook / Instagram ----------
    if (host === 'facebook.com' || host === 'fb.watch' || host === 'm.facebook.com') {
      return `https://www.facebook.com/plugins/video.php?show_text=false&href=${encodeURIComponent(url)}`;
    }
    if (host === 'instagram.com') {
      const i = parts.findIndex((p) => p === 'p' || p === 'reel' || p === 'tv');
      if (i >= 0 && parts[i + 1]) return `https://www.instagram.com/${parts[i]}/${parts[i + 1]}/embed`;
      return url;
    }

    // ---------- Internet Archive: /details/ID → /embed/ID ----------
    if (host === 'archive.org') {
      const i = parts.indexOf('details');
      if (i >= 0 && parts[i + 1]) return `https://archive.org/embed/${parts[i + 1]}`;
      return url;
    }

    // ---------- Streamable: /ID → /e/ID ----------
    if (host === 'streamable.com' && parts[0] && parts[0] !== 'e') {
      return `https://streamable.com/e/${parts[0]}`;
    }

    // ---------- Loom: /share/ID → /embed/ID ----------
    if (host === 'loom.com') {
      const i = parts.indexOf('share');
      if (i >= 0 && parts[i + 1]) return `https://www.loom.com/embed/${parts[i + 1]}`;
      return url;
    }

    // ---------- Videasy links (already a player) ----------
    if (host === 'player.videasy.net' || host === 'player.videasy.to') return url;

    // ---------- any other platform / watch page → frame it as-is ----------
    return url;
  } catch { return url; }
};


// ---------- VidPlay watch pages (vidplay.top / vidplay.tv / vidplay.org) ----------
// A VidPlay watch URL is NOT itself frameable — the page sends X-Frame-Options,
// and the video player is not even in its HTML. The page loads it through ajax
// endpoints that each answer with an <iframe> for the real stream player:
//   $.get('/ajax/tv_vplay.php', {"embed":"117376","season":"1","episode":"1"}, …)
//   → https://ythd.org/embed/117376/1-1/color-000000   (#V1)
//   → https://vidfast.pro/tv/117376/1/1?autoPlay=true  (#V2)
//   → https://peachify.top/embed/tv/117376/1/1         (#V3)
// All three players allow cross-origin framing, so we resolve the pasted watch
// URL server-side to that real player and embed it directly. The numeric id is
// the title's TMDB id — it only exists on the watch page, hence the scrape.
// Results are cached per URL for a few hours so watch requests stay fast.
export const VIDPLAY_HOSTS = /(^|\.)(vidplay\.(top|tv|org))$/i;
const vidplayCache = new Map(); // watch-page url -> { value, expires }
const VIDPLAY_TTL = 6 * 60 * 60 * 1000;

const vidplayFetch = async (url, referer) => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    return await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'text/html,*/*',
        ...(referer ? { Referer: referer } : {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
};

// Watch-page url → { url: realPlayerUrl, type: 'embed' } (or 'external' fallback).
export const resolveVidplay = async (pageUrl) => {
  const cached = vidplayCache.get(pageUrl);
  if (cached && cached.expires > Date.now()) return cached.value;

  try {
    const page = await (await vidplayFetch(pageUrl, 'https://vidplay.top/')).text();

    // Every server button wires itself like: $.get('/ajax/xxx.php', {"embed":"…",…}, fn)
    // Works for tv (embed/season/episode) and movie (embed) pages alike.
    const calls = [...page.matchAll(/\$\.get\(\s*'([^']*\/ajax\/[^']+)'\s*,\s*(\{[^}]*\})/gi)];
    for (const [, path, rawParams] of calls) {
      const params = new URLSearchParams();
      for (const [, key, value] of rawParams.matchAll(/"([^"]+)"\s*:\s*"([^"]*)"/g)) params.set(key, value);
      try {
        const u = new URL(path, pageUrl); // relative path → same vidplay domain
        u.search = params.toString();     // {"embed":"117376","season":…} → ?embed=…&season=…
        const html = await (await vidplayFetch(u.href, pageUrl)).text();
        const src = html.match(/<iframe[^>]*?\ssrc=["']([^"']+)["']/i)?.[1];
        if (src && /^https?:\/\//i.test(src)) {
          const value = { url: src, type: 'embed' };
          vidplayCache.set(pageUrl, { value, expires: Date.now() + VIDPLAY_TTL });
          return value;
        }
      } catch { /* endpoint failed — try the next server button */ }
    }
  } catch { /* site unreachable → honest fallback below */ }
  // Could not resolve: keep the honest "open on source site" behaviour.
  return { url: pageUrl, type: 'external' };
};


// Decide how a link should be played. The URL always wins over the stored source
// type, so a stale "mp4" can never send a YouTube/Bilibili page into the native
// <video> element (and a stale "hls" can never force HLS on a platform link).
//   1. real media file (.mp4/.webm/.mov/.mkv/.m3u8/.mpd) -> our own native player
//   2. everything else -> iframe inside our own play screen, using the provider's
//      embeddable URL (YouTube, Bilibili, Dailymotion, Vimeo, Drive, or any page link)
export const resolveSource = (rawUrl, declaredType) => {
  const url = String(rawUrl || '').trim();
  const declared = String(declaredType || '').toLowerCase();
  if (!url) return { url: '', type: declared || 'mp4' };

  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (/(^|\.)movienerds\.site$|(^|\.)nebulawatch\.tech$|(^|\.)vidsrc\.su$/.test(host)) {
      return { url: '', type: 'unsupported' };
    }
  } catch { /* malformed URLs are handled by the normal source checks below */ }

  // Real media files always play natively — even on localhost/127.0.0.1, where a
  // local media server is a perfectly valid source. Only NON-file local URLs
  // (someone pasting a page of the app itself) are treated as "no video".
  if (MEDIA_EXT.test(url)) {
    const isHls = /\.m3u8(\?|$)/i.test(url);
    return { url, type: isHls ? 'hls' : (declared === 'cloudinary' ? 'cloudinary' : 'mp4') };
  }

  if (isLocalAppUrl(url)) return { url: '', type: 'embed' };

  if (isStremioUrl(url) || declared === 'stremio') {
    return { url, type: 'stremio' };
  }

    // Providers that verifiably forbid being framed — X-Frame-Options: SAMEORIGIN
    // plus CSP frame-ancestors 'self' (browser-enforced; zenox.lol verified live,
    // it streams fine on its own site but can NEVER render inside an iframe).
    // Marking them 'external' makes the player show its honest "open on the
    // source site" panel immediately instead of a 12s black rectangle. Direct
    // media files on these hosts were already handled above and stay native.
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (/(^|\.)zenox\.(lol|cc)$/.test(host)) return { url, type: 'external' };
    } catch { /* not a parseable URL — fall through to the generic embed path */ }

    // ---------- any other platform / watch page → ONLY frame it when it is on a
    // known embed-friendly host. Unknown pages are treated as "external" so the
    // viewer sees a clear fallback instead of a silent black iframe.
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
      const embedUrl = toEmbedUrl(url);
      if (KNOWN_EMBED_HOSTS.test(host) || /^https?:\/\/(?:www\.)?(youtube\.com|youtu\.be|bilibili\.com|dailymotion\.com|dai\.ly|vimeo\.com|ok\.ru|rutube\.ru|vk\.com|vkvideo\.ru|archive\.org|streamable\.com|loom\.com|drive\.google\.com|facebook\.com|instagram\.com|player\.videasy\.net|player\.videasy\.to|vidsrc\.su|ythd\.org|vidfast\.pro|peachify\.top)\//i.test(embedUrl)) {
        return { url: embedUrl, type: 'embed' };
      }
      return { url, type: 'external' };
    } catch {
      return { url, type: 'external' };
    }
};

// ---------- runtime embeddability probe (fixes the user-side blank screen) ----------
// Generic page embeds (type 'embed') are the risky class: many streaming pages send
// X-Frame-Options yet still fire the iframe's onLoad with Chrome's blocked error
// page — the client veil clears and the viewer sees a silent black box.
// At watch time we probe such hosts once per TTL and downgrade blocked pages to
// type 'external', which the player renders as the "open on source site" panel.
// Known embed players (YouTube, Dailymotion, …) skip the probe — zero added latency.
// (Kept in sync with FRAME_FRIENDLY in adminController.js; not imported to avoid
//  a circular dependency — adminController imports resolveSource from here.)
const FRAME_FRIENDLY_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|bilibili\.com|dailymotion\.com|dai\.ly|vimeo\.com|ok\.ru|rutube\.ru|vk\.com|vkvideo\.ru|archive\.org|streamable\.com|loom\.com|drive\.google\.com|facebook\.com|instagram\.com|player\.videasy\.net|player\.videasy\.to|vidsrc\.su|viki\.com|ythd\.org|vidfast\.pro|peachify\.top)$/i;
const KNOWN_EMBED_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|bilibili\.com|dailymotion\.com|dai\.ly|vimeo\.com|ok\.ru|rutube\.ru|vk\.com|vkvideo\.ru|archive\.org|streamable\.com|loom\.com|drive\.google\.com|facebook\.com|instagram\.com|player\.videasy\.net|player\.videasy\.to|vidsrc\.su|player\.bilibili\.com|viki\.com|ythd\.org|vidfast\.pro|peachify\.top)$/i;
const embedProbeCache = new Map(); // host -> { verdict, expires }
const EMBED_PROBE_TTL = 10 * 60 * 1000;

export const probeEmbeddable = async (url) => {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return true; }
  if (FRAME_FRIENDLY_HOSTS.test(host)) return true;
  const hit = embedProbeCache.get(host);
  if (hit && hit.expires > Date.now()) return hit.verdict;
  // Optimistic default: unreachable/timeout → assume frameable and let the
  // player's own 12s watchdog + fallback panel be the safety net.
  let verdict = true;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000);
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
    clearTimeout(timer);
    const xfo = (r.headers.get('x-frame-options') || '').toLowerCase();
    const csp = (r.headers.get('content-security-policy') || '').toLowerCase();
    const fa = (csp.match(/frame-ancestors[^;]*/) || [''])[0];
    verdict = !(/deny|sameorigin/.test(xfo) || (/frame-ancestors/.test(fa) && !/frame-ancestors\s+\*/.test(fa)));
  } catch { /* keep optimistic default */ }
  embedProbeCache.set(host, { verdict, expires: Date.now() + EMBED_PROBE_TTL });
  return verdict;
};

// A configured provider template can replace the default, but only numeric TMDB
// coordinates are interpolated. The caller still runs the normal source resolver,
// so an unknown/blocked provider becomes an honest external handoff.
const DEFAULT_TMDB_TV_SOURCE = '';
export const buildTmdbEpisodeSourceUrl = (tmdbId, seasonNumber, episodeNumber, template) => {
  const id = Number(tmdbId);
  const season = Number(seasonNumber);
  const episode = Number(episodeNumber);
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(season) || season < 1
    || !Number.isSafeInteger(episode) || episode < 1) return '';
  const sourceTemplate = String(template || process.env.TMDB_TV_SOURCE_TEMPLATE || DEFAULT_TMDB_TV_SOURCE).trim();
  if (!sourceTemplate) return '';
  return sourceTemplate
    .replace(/\{tmdbId\}/g, String(id))
    .replace(/\{season\}/g, String(season))
    .replace(/\{episode\}/g, String(episode));
};

// Same contract for movies, which have a single feature and no season/episode
// coordinates. Only {tmdbId} is interpolated.
const DEFAULT_TMDB_MOVIE_SOURCE = '';
export const buildTmdbMovieSourceUrl = (tmdbId, template) => {
  const id = Number(tmdbId);
  if (!Number.isSafeInteger(id) || id < 1) return '';
  const sourceTemplate = String(template || process.env.TMDB_MOVIE_SOURCE_TEMPLATE
    || DEFAULT_TMDB_MOVIE_SOURCE).trim();
  if (!sourceTemplate) return '';
  return sourceTemplate.replace(/\{tmdbId\}/g, String(id));
};

// resolveSource + automatic embeddability downgrade — used by the watch endpoint
// so what the player receives is exactly what can actually be shown in-frame.
export const resolvePlayable = async (url, declaredType) => {
  // VidPlay watch pages resolve to their real ajax-loaded player (frameable),
  // never to the X-Frame-Options page itself.
  try {
    if (VIDPLAY_HOSTS.test(new URL(String(url || '').trim()).hostname)) return resolveVidplay(url);
  } catch { /* not a parseable URL — generic path below */ }
  const s = resolveSource(url, declaredType);
  if (!s.url || s.type !== 'embed') return s;
  const ok = await probeEmbeddable(s.url);
  return ok ? s : { url: s.url, type: 'external' };
};

// @route GET /api/titles/:id/watch — playable video info + resume position
export const getWatchData = async (req, res) => {
  try {
    const { id } = req.params;
    // Accept both ?episode= (what the player/episode list sends) and ?episodeId=
    const episodeId = req.query.episode || req.query.episodeId;
    const title = await Title.findById(id);
    if (!title || title.status !== 'published')
      return res.status(404).json({ message: 'Title not found' });

    // THE gate. Filtering the rails is cosmetic; this is what actually stops a
    // Kids profile from playing grown-up content by pasting /watch/<id>.
    if (!allowsTitle(req.profile, title)) {
      return res.status(403).json({ message: maturityMessage(req.profile) });
    }

    let src = null;
    // Set when a series/movie has no main video URL and we fall back to its first
    // episode — the player puts this in the URL so resume/next-episode stay in sync.
    let autoEpisodeId = null;
    // The episode document actually being played (episodeId param or auto-selected),
    // used for the "S1:E1 — Episode title" chip on the player bar.
    let epDoc = null;

    if (episodeId) {
      const ep = await Episode.findById(episodeId).populate('season', 'seasonNumber');
      if (!ep || ep.status !== 'published') return res.status(404).json({ message: 'Episode not found' });
      epDoc = ep;
      const s = await resolvePlayable(ep.videoUrl || title.videoUrl, ep.videoSourceType || title.videoSourceType);
      src = { ...s, thumbnail: ep.thumbnailUrl || title.bannerUrl };
    } else {
      const s = await resolvePlayable(title.videoUrl, title.videoSourceType);
      if (s.url) {
        src = { ...s, thumbnail: title.bannerUrl };
      } else {
        // No main video on the title itself → play the FIRST episode instead of failing.
        // This is what the Play buttons on cards / hero / detail page hit for a series.
        const firstSeason = await Season.findOne({ title: title._id }).sort({ seasonNumber: 1 });
        const firstEp = firstSeason
          ? await Episode.findOne({ season: firstSeason._id, status: 'published' }).sort({ episodeNumber: 1 })
          : await Episode.findOne({ series: title._id, status: 'published' }).sort({ episodeNumber: 1 });
        if (firstEp) {
          const es = await resolvePlayable(firstEp.videoUrl, firstEp.videoSourceType);
          if (es.url) {
            src = { ...es, thumbnail: firstEp.thumbnailUrl || title.bannerUrl };
            autoEpisodeId = firstEp._id;
            epDoc = await Episode.findById(firstEp._id).populate('season', 'seasonNumber');
          }
        }
      }
    }

    if (!src || !src.url) {
      return res.status(400).json({
        message: 'No valid video source',
        detail: 'Use a real media URL (MP4/HLS/YouTube embed) or a supported provider link. A local app route like http://localhost:5173/watch/... is not a video stream and cannot play here.',
      });
    }

    let resumeSeconds = 0;
    if (req.profileId) {
      const wh = await WatchHistory.findOne({ profile: req.profileId, title: title._id });
      if (wh && !wh.completed) {
        // Only resume when we are on the SAME episode the position was saved for —
        // otherwise picking episode 5 would jump to episode 1's timestamp.
        const playingEp = epDoc ? String(epDoc._id) : null;
        const storedEp = wh.episode ? String(wh.episode) : null;
        if (playingEp === storedEp) resumeSeconds = wh.progressSeconds;
      }
    }

    // Real subtitle/audio tracks for the player's settings panel. Episode tracks win;
    // the title-level tracks are the fallback. Nothing is invented — when the arrays
    // are empty the player only offers the audio/subtitles that actually exist.
    const subtitleTracks = (epDoc?.subtitleTracks?.length ? epDoc.subtitleTracks : title.subtitleTracks) || [];
    const audioTracks = (epDoc?.audioTracks?.length ? epDoc.audioTracks : title.audioTracks) || [];

    res.json({
      video: { ...src, episodeId: autoEpisodeId },
      resumeSeconds,
      title: {
        id: title._id,
        type: title.type,
        title: title.title,
        slug: title.slug,
        ageRating: title.ageRating,
        logoUrl: title.logoUrl || '',
        tagline: title.tagline || '',
        language: title.language || '',
        bannerUrl: title.bannerUrl || '',
        posterUrl: title.posterUrl || '',
        description: title.description || '',
        releaseYear: title.releaseYear || '',
        durationMinutes: title.durationMinutes || 0,
        audioLanguages: title.audioLanguages || [],
      },
      // The player uses this explicit identity for progress. Local titles continue
      // to save their Mongo IDs; TMDB routes save their separate stable identity.
      history: {
        kind: 'local',
        titleId: String(title._id),
        episodeId: epDoc ? String(epDoc._id) : null,
      },
      episode: epDoc
        ? {
            id: epDoc._id,
            episodeNumber: epDoc.episodeNumber,
            seasonNumber: epDoc.season?.seasonNumber || 1,
            title: epDoc.title,
            description: epDoc.description || '',
            durationMinutes: epDoc.durationMinutes || 0,
            thumbnailUrl: epDoc.thumbnailUrl || '',
          }
        : null,
      subtitles: subtitleTracks,
      audio: audioTracks,
      // Skip markers for "Skip Recap" / "Skip Intro" (SRS §10). Real per-episode
      // values when the admin set them; otherwise 0 and the player uses its default
      // window. Movies (no episode) have no markers.
      markers: epDoc
        ? {
            recapStart: epDoc.recapStart || 0,
            recapEnd: epDoc.recapEnd || 0,
            introStart: epDoc.introStart || 0,
            introEnd: epDoc.introEnd || 0,
          }
        : null,
    });
  } catch (err) {
    console.error('getWatchData:', err);
    res.status(500).json({ message: 'Failed to load stream' });
  }
};

// @route GET /api/genres
export const listGenres = async (req, res) => {
  try {
    const genres = await Genre.find({ isActive: true }).sort({ order: 1 });
    res.json({ items: genres });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load genres' });
  }
};
