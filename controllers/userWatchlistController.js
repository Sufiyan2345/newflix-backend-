import Watchlist from '../models/Watchlist.js';
import WatchHistory from '../models/WatchHistory.js';
import TmdbWatchHistory from '../models/TmdbWatchHistory.js';
import Title from '../models/Title.js';
import Notification from '../models/Notification.js';

// ---------- WATCHLIST (My List) ----------
// @route GET /api/user/watchlist
export const getWatchlist = async (req, res) => {
  const items = await Watchlist.find({ profile: req.profileId })
    .sort({ addedAt: -1 }).populate({ path: 'title', populate: { path: 'genres' } });
  res.json({ items: items.filter((i) => i.title && i.title.status === 'published') });
};

// @route POST /api/user/watchlist { titleId }
export const addToWatchlist = async (req, res) => {
  try {
    const { titleId } = req.body;
    const title = await Title.findById(titleId);
    if (!title) return res.status(404).json({ message: 'Title not found' });
    const exists = await Watchlist.findOne({ profile: req.profileId, title: titleId });
    if (exists) return res.json({ message: 'Already in My List', item: exists });
    const item = await Watchlist.create({ profile: req.profileId, title: titleId });
    res.status(201).json({ item, message: 'Added to My List' });
  } catch (err) {
    console.error('addToWatchlist:', err);
    res.status(500).json({ message: 'Failed to add to My List' });
  }
};

// @route DELETE /api/user/watchlist/:titleId
export const removeFromWatchlist = async (req, res) => {
  try {
    const item = await Watchlist.findOneAndDelete({ profile: req.profileId, title: req.params.titleId });
    if (!item) return res.status(404).json({ message: 'Not in My List' });
    res.json({ message: 'Removed from My List' });
  } catch {
    res.status(500).json({ message: 'Failed to remove' });
  }
};

// @route GET /api/user/watchlist/status/:titleId
export const watchlistStatus = async (req, res) => {
  const item = await Watchlist.findOne({ profile: req.profileId, title: req.params.titleId });
  res.json({ inList: !!item });
};

// ---------- WATCH HISTORY (Continue Watching) ----------
const requestMeta = (req) => {
  const ua = req.headers['user-agent'] || '';
  const device = /ipad|tablet/i.test(ua) ? 'Tablet' : /mobile|android|iphone/i.test(ua) ? 'Mobile' : 'Desktop';
  const browser = /edg\//i.test(ua) ? 'Edge' : /chrome|crios/i.test(ua) ? 'Chrome'
    : /firefox/i.test(ua) ? 'Firefox' : /safari/i.test(ua) ? 'Safari' : 'Other';
  return { device, browser };
};

const safeText = (value, max = 500) => String(value || '').trim().slice(0, max);
const cleanTitleSnapshot = (value = {}) => ({
  title: safeText(value.title, 200),
  description: safeText(value.description, 3000),
  posterUrl: safeText(value.posterUrl, 1000),
  bannerUrl: safeText(value.bannerUrl, 1000),
  logoUrl: safeText(value.logoUrl, 1000),
  tagline: safeText(value.tagline, 500),
  releaseYear: Math.max(0, Number(value.releaseYear) || 0),
  ageRating: safeText(value.ageRating, 20) || '13+',
});
const cleanEpisodeSnapshot = (value = {}) => ({
  tmdbEpisodeId: Math.max(0, Number(value.tmdbEpisodeId) || 0),
  seasonNumber: Number(value.seasonNumber),
  episodeNumber: Number(value.episodeNumber),
  title: safeText(value.title, 200),
  description: safeText(value.description, 3000),
  thumbnailUrl: safeText(value.thumbnailUrl, 1000),
  durationMinutes: Math.max(0, Number(value.durationMinutes) || 0),
});

const tmdbHistoryItem = (doc) => {
  const raw = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const title = raw.titleSnapshot || {};
  const episode = raw.episodeSnapshot || {};
  const id = Number(raw.tmdbId);
  const isMovie = raw.mediaType === 'movie';
  // A movie has no episode: presenting it as "S1:E1 Episode 1" was wrong, and its
  // watch route has to point at the movie endpoint instead of the TV one.
  const base = {
    ...raw,
    sourceType: 'tmdb',
    title: {
      _id: `tmdb-${isMovie ? 'movie' : 'tv'}-${id}`,
      type: isMovie ? 'movie' : 'tv',
      title: title.title || `TMDB ${isMovie ? 'movie' : 'series'} ${id}`,
      slug: `tmdb-${isMovie ? 'movie' : 'tv'}-${id}`,
      description: title.description || '',
      posterUrl: title.posterUrl || '',
      bannerUrl: title.bannerUrl || title.posterUrl || '',
      logoUrl: title.logoUrl || '',
      tagline: title.tagline || '',
      releaseYear: title.releaseYear || 0,
      ageRating: title.ageRating || '13+',
    },
    watchRoute: isMovie
      ? `/watch/tmdb/${id}?type=movie`
      : `/watch/tmdb/${id}?season=${episode.seasonNumber}&episode=${episode.episodeNumber}`,
  };
  if (isMovie) return { ...base, episode: null };
  return {
    ...base,
    episode: {
      _id: `tmdb-ep-${episode.tmdbEpisodeId || `${id}-${episode.seasonNumber}-${episode.episodeNumber}`}`,
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
      title: episode.title || `Episode ${episode.episodeNumber}`,
    },
  };
};

// @route POST /api/user/watch-history { titleId, episodeId?, progressSeconds, durationSeconds }
export const updateWatchHistory = async (req, res) => {
  try {
    const { titleId, episodeId = null, progressSeconds = 0, durationSeconds = 0 } = req.body;
    const completed = durationSeconds > 0 && progressSeconds / durationSeconds > 0.95;
    // Capture device/browser for the analytics breakdown (SRS §6.11)
    const { device, browser } = requestMeta(req);
    const doc = await WatchHistory.findOneAndUpdate(
      { profile: req.profileId, title: titleId },
      { episode: episodeId, progressSeconds, durationSeconds, completed, lastWatchedAt: new Date(), device, browser },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    if (completed) Title.updateOne({ _id: titleId }, { $inc: { watchCount: 1 } }).exec();
    res.json({ history: doc });
  } catch (err) {
    console.error('updateWatchHistory:', err);
    res.status(500).json({ message: 'Failed to update watch history' });
  }
};

// @route POST /api/user/tmdb-watch-history
// TMDB titles use their own stable series identity; local ObjectId history is untouched.
export const updateTmdbWatchHistory = async (req, res) => {
  try {
    if (!req.profileId) return res.status(400).json({ message: 'Choose a profile before saving progress' });
    const tmdbId = Number(req.body?.tmdbId);
    const seasonNumber = Number(req.body?.seasonNumber);
    const episodeNumber = Number(req.body?.episodeNumber);
    const progressSeconds = Math.max(0, Math.floor(Number(req.body?.progressSeconds) || 0));
    const durationSeconds = Math.max(0, Math.floor(Number(req.body?.durationSeconds) || 0));
    if (!Number.isSafeInteger(tmdbId) || tmdbId < 1
      || !Number.isSafeInteger(seasonNumber) || seasonNumber < 1
      || !Number.isSafeInteger(episodeNumber) || episodeNumber < 1) {
      return res.status(400).json({ message: 'Invalid TMDB history coordinates' });
    }
    const completed = durationSeconds > 0 && progressSeconds / durationSeconds > 0.95;
    const mediaType = req.body?.mediaType === 'movie' ? 'movie' : 'tv';
    const { device, browser } = requestMeta(req);
    const doc = await TmdbWatchHistory.findOneAndUpdate(
      { profile: req.profileId, tmdbId },
      {
        mediaType,
        seasonNumber,
        episodeNumber,
        titleSnapshot: cleanTitleSnapshot(req.body?.titleSnapshot),
        episodeSnapshot: cleanEpisodeSnapshot({
          seasonNumber,
          episodeNumber,
          ...(req.body?.episodeSnapshot || {}),
        }),
        progressSeconds,
        durationSeconds,
        completed,
        lastWatchedAt: new Date(),
        device,
        browser,
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    res.json({ history: tmdbHistoryItem(doc) });
  } catch (err) {
    console.error('updateTmdbWatchHistory:', err);
    res.status(500).json({ message: 'Failed to update TMDB watch history' });
  }
};

// @route GET /api/user/continue-watching
export const continueWatching = async (req, res) => {
  const [local, tmdb] = await Promise.all([
    WatchHistory.find({
      profile: req.profileId,
      completed: false,
      progressSeconds: { $gt: 0 },
    })
      .sort({ lastWatchedAt: -1 }).limit(20)
      .populate({ path: 'title', match: { status: 'published' }, populate: { path: 'genres' } })
      // The Continue Watching lead tile prints "S3:E4 · Old Friends", which needs
      // the episode AND its season number. `episode` was previously left as a bare
      // ObjectId, so local titles could only ever show the show title.
      .populate({ path: 'episode', populate: { path: 'season', select: 'seasonNumber name' } }),
    TmdbWatchHistory.find({
      profile: req.profileId,
      completed: false,
      progressSeconds: { $gt: 0 },
    }).sort({ lastWatchedAt: -1 }).limit(20),
  ]);
  const items = [
    ...local.filter((item) => item.title).map((item) => ({ ...item.toObject(), sourceType: 'local' })),
    ...tmdb.map(tmdbHistoryItem),
  ].sort((a, b) => new Date(b.lastWatchedAt) - new Date(a.lastWatchedAt)).slice(0, 20);
  res.json({ items });
};

// @route GET /api/user/history
export const getHistory = async (req, res) => {
  const [local, tmdb] = await Promise.all([
    WatchHistory.find({ profile: req.profileId })
      .sort({ lastWatchedAt: -1 }).limit(100)
      .populate({ path: 'title', match: { status: 'published' }, populate: { path: 'genres' } }),
    TmdbWatchHistory.find({ profile: req.profileId }).sort({ lastWatchedAt: -1 }).limit(100),
  ]);
  const items = [
    ...local.filter((item) => item.title).map((item) => ({ ...item.toObject(), sourceType: 'local' })),
    ...tmdb.map(tmdbHistoryItem),
  ].sort((a, b) => new Date(b.lastWatchedAt) - new Date(a.lastWatchedAt)).slice(0, 100);
  res.json({ items });
};

// @route DELETE /api/user/history/:titleId
export const removeHistoryItem = async (req, res) => {
  await WatchHistory.findOneAndDelete({ profile: req.profileId, title: req.params.titleId });
  res.json({ message: 'Removed from history' });
};

// @route DELETE /api/user/history/tmdb/:tmdbId
export const removeTmdbHistoryItem = async (req, res) => {
  const tmdbId = Number(req.params.tmdbId);
  if (!Number.isSafeInteger(tmdbId) || tmdbId < 1) {
    return res.status(400).json({ message: 'Invalid TMDB id' });
  }
  await TmdbWatchHistory.findOneAndDelete({ profile: req.profileId, tmdbId });
  res.json({ message: 'Removed from history' });
};

// ---------- NOTIFICATIONS ----------
// @route GET /api/user/notifications
export const getNotifications = async (req, res) => {
  const items = await Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(30);
  res.json({ items, unread: items.filter((n) => !n.isRead).length });
};

// @route PUT /api/user/notifications/read-all
export const markNotificationsRead = async (req, res) => {
  await Notification.updateMany({ user: req.user._id, isRead: false }, { isRead: true });
  res.json({ message: 'All notifications marked read' });
};
