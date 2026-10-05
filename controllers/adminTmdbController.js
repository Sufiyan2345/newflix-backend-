import mongoose from 'mongoose';
import TmdbOverride from '../models/TmdbOverride.js';
import Title from '../models/Title.js';
import { logAdminAction } from '../middleware/activityLog.js';
import {
  tmdbFetch, normalize, ensureTmdbOverrides, applyTmdbOverrides, reloadTmdbOverrides,
} from './tmdbController.js';

// ==== Admin: manage the LIVE TMDB catalogue (movies / series / dramas) ====
// TMDB titles stream straight from the TMDB API, so "editing" them means saving an
// override (poster, thumbnail, title, description…) in Mongo that is merged over
// every TMDB response the user site serves. See models/TmdbOverride.js.

// @route GET /api/admin/tmdb/catalog?type=&list=&lang=&page=&q=
// Browse the whole TMDB catalogue with real pagination (Most Popular / Top Rated /
// In Theaters / Airing Today / Trending) or search it by name. Items carry any saved
// overrides, so the panel always shows exactly what visitors see.
export const adminTmdbCatalog = async (req, res) => {
  await ensureTmdbOverrides();
  const page = Math.min(500, Math.max(1, Number(req.query.page) || 1));
  const q = String(req.query.q || '').trim();
  const lang = String(req.query.lang || '').trim();
  const list = ['popular', 'top_rated', 'now_playing', 'airing_today', 'trending'].includes(req.query.list)
    ? req.query.list
    : 'popular';
  const type = req.query.type === 'tv' ? 'tv' : 'movie';
    const categories = {
      'korean-drama': ['ko', '18'],
      'chinese-drama': ['zh', '18'],
      'japanese-drama': ['ja', '18'],
      'hindi-drama': ['hi', '18'],
      'turkish-drama': ['tr', '18'],
      'spanish-drama': ['es', '18'],
      'english-drama': ['en', '18'],
    };
    const category = categories[String(req.query.category || '').trim()];

  if (!process.env.TMDB_ACCESS_TOKEN && !process.env.TMDB_API_KEY) {
    return res.json({ configured: false, items: [], page: 1, totalPages: 0, totalResults: 0 });
  }

  try {
    let data;
    if (q) {
      data = await tmdbFetch(
        `/search/multi?language=en-US&include_adult=false&page=${page}&query=${encodeURIComponent(q)}`
      );
    } else if (category) {
      const params = new URLSearchParams({
        language: 'en-US',
        page: String(page),
        sort_by: 'popularity.desc',
        with_original_language: category[0],
        with_genres: category[1],
      });
      data = await tmdbFetch(`/discover/tv?${params.toString()}`);
    } else {
      const paths = {
        popular: `/${type}/popular`,
        top_rated: `/${type}/top_rated`,
        now_playing: '/movie/now_playing',
        airing_today: '/tv/airing_today',
        trending: `/trending/${type}/week`,
      };
      const params = new URLSearchParams({ language: 'en-US', page: String(page) });
      if (lang) params.set('with_original_language', lang);
      data = await tmdbFetch(`${paths[list]}?${params.toString()}`);
    }
    const items = applyTmdbOverrides(
      (data?.results || [])
        .filter((r) => r.media_type !== 'person' && (r.poster_path || r.backdrop_path))
        .map((r) => normalize(r, r.media_type || type))
    );
    res.json({
      configured: true,
      page: data?.page || page,
      totalPages: Math.min(500, data?.total_pages || 1),
      totalResults: data?.total_results || 0,
      items,
    });
  } catch (err) {
    console.error('adminTmdbCatalog:', err.message);
    res.status(502).json({ message: 'TMDB catalog unavailable' });
  }
};

// @route GET /api/admin/tmdb/overrides — every saved edit
export const adminTmdbOverrides = async (req, res) => {
  const items = await TmdbOverride.find().sort({ updatedAt: -1 }).populate('updatedBy', 'name email').lean();
  res.json({ items });
};

// @route PUT /api/admin/tmdb/overrides — save poster / thumbnail / text edits
const EDITABLE = ['title', 'description', 'posterUrl', 'bannerUrl', 'logoUrl', 'tagline', 'trailerUrl'];

export const adminTmdbOverrideSave = async (req, res) => {
  try {
    const tmdbId = Number(req.body.tmdbId);
    const mediaType = req.body.mediaType === 'tv' ? 'tv' : 'movie';
    if (!tmdbId) return res.status(400).json({ message: 'tmdbId is required' });
    const update = { tmdbId, mediaType, updatedBy: req.user?._id };
    for (const k of EDITABLE) {
      if (typeof req.body[k] === 'string') update[k] = req.body[k].trim();
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'localTitleId')) {
      if (mediaType !== 'tv') return res.status(400).json({ message: 'Local mapping is only available for TV series' });
      const localTitleId = String(req.body.localTitleId || '').trim();
      if (!localTitleId) {
        update.localTitleId = null;
      } else {
        if (!mongoose.isValidObjectId(localTitleId)) {
          return res.status(400).json({ message: 'Local series id is not a valid title id' });
        }
        const local = await Title.findById(localTitleId).select('type status').lean();
        if (!local || local.type !== 'series' || local.status !== 'published') {
          return res.status(400).json({ message: 'Local mapping must be a published series' });
        }
        update.localTitleId = localTitleId;
      }
    }
    const override = await TmdbOverride.findOneAndUpdate(
      { tmdbId, mediaType },
      update,
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    await reloadTmdbOverrides(); // site reflects the edit on the very next request
    await logAdminAction(req, 'UPDATE_TMDB_TITLE', 'tmdb', `${mediaType}-${tmdbId}`, override.title || `TMDB ${mediaType} #${tmdbId}`);
    res.json({ override });
  } catch (err) {
    console.error('adminTmdbOverrideSave:', err.message);
    res.status(500).json({ message: 'Could not save the edit' });
  }
};

// @route DELETE /api/admin/tmdb/overrides/:mediaType/:tmdbId — restore original TMDB data
export const adminTmdbOverrideDelete = async (req, res) => {
  try {
    const tmdbId = Number(req.params.tmdbId);
    const mediaType = req.params.mediaType === 'tv' ? 'tv' : 'movie';
    const removed = await TmdbOverride.findOneAndDelete({ tmdbId, mediaType });
    if (!removed) return res.status(404).json({ message: 'This title has no saved edits' });
    await reloadTmdbOverrides();
    await logAdminAction(req, 'RESET_TMDB_TITLE', 'tmdb', `${mediaType}-${tmdbId}`, 'Restored original TMDB artwork/metadata');
    res.json({ message: 'Reverted to the original TMDB data' });
  } catch (err) {
    console.error('adminTmdbOverrideDelete:', err.message);
    res.status(500).json({ message: 'Could not revert this title' });
  }
};

// @route POST /api/admin/tmdb/overrides/restore — restore multiple titles at once
export const adminTmdbOverridesRestore = async (req, res) => {
  try {
    const requested = req.body?.items;
    if (!Array.isArray(requested) || requested.length === 0) {
      return res.status(400).json({ message: 'Select at least one edited title to restore' });
    }

    const unique = new Map();
    for (const item of requested) {
      const tmdbId = Number(item?.tmdbId);
      const mediaType = item?.mediaType;
      if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0 || !['movie', 'tv'].includes(mediaType)) {
        return res.status(400).json({ message: 'Each title must have a valid TMDB ID and media type' });
      }
      unique.set(`${mediaType}-${tmdbId}`, { tmdbId, mediaType });
    }

    const titles = [...unique.values()];
    const clauses = titles.map(({ tmdbId, mediaType }) => ({ tmdbId, mediaType }));
    const removed = await TmdbOverride.find({ $or: clauses }).select('tmdbId mediaType title').lean();
    if (!removed.length) return res.status(404).json({ message: 'The selected titles no longer have saved edits' });

    await TmdbOverride.deleteMany({ $or: clauses });
    await reloadTmdbOverrides();
    await Promise.all(removed.map((item) => logAdminAction(
      req,
      'RESET_TMDB_TITLE',
      'tmdb',
      `${item.mediaType}-${item.tmdbId}`,
      `Restored original TMDB artwork/metadata${item.title ? ` for ${item.title}` : ''}`,
    )));
    res.json({ message: 'Restored original TMDB data', restoredCount: removed.length });
  } catch (err) {
    console.error('adminTmdbOverridesRestore:', err.message);
    res.status(500).json({ message: 'Could not restore the selected titles' });
  }
};