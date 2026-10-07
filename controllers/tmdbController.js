import TmdbOverride from '../models/TmdbOverride.js';
import Title from '../models/Title.js';
import Season from '../models/Season.js';
import Episode from '../models/Episode.js';
import WatchHistory from '../models/WatchHistory.js';
import TmdbWatchHistory from '../models/TmdbWatchHistory.js';
import { buildTmdbEpisodeSourceUrl, buildTmdbMovieSourceUrl, resolvePlayable } from './titleDetailController.js';
import { maturityRankOf, maturityRank, requestLimit, isKidsRequest, allowsTitle, maturityMessage, withMaturity, MATURITY_ORDER } from '../utils/maturity.js';
import { personalize, feedSeed, filterRowsForMaturity } from '../utils/personalize.js';

// TMDB genre ids used to build a genuinely kid-safe catalogue.
//   10751 Family · 16 Animation · 10762 Kids · 10759 Action & Adventure
// `certification.lte` is the real gate: TMDB's list endpoints return no
// certification at all (normalize() can only guess "13+"), so filtering the
// standard popular/trending lists for a kids profile would either return nothing
// or return grown-up films. Discover + certification is what actually works.
const KIDS_MOVIE_DISCOVER = '/discover/movie?language=en-US&include_adult=false&with_genres=10751,16&certification_country=US&certification.lte=PG&sort_by=popularity.desc';
const KIDS_TV_DISCOVER = '/discover/tv?language=en-US&include_adult=false&with_genres=10762,16&certification_country=US&certification.lte=TV-PG&sort_by=popularity.desc';
const KIDS_CERTIFIED_MOVIE_POOL = '/discover/movie?language=en-US&include_adult=false&certification_country=US&certification.lte=PG&sort_by=popularity.desc&vote_count.gte=5';
const KIDS_CERTIFIED_TV_POOL = '/discover/tv?language=en-US&include_adult=false&certification_country=US&certification.lte=TV-PG&sort_by=popularity.desc&vote_count.gte=5';
const KIDS_MOVIE_TOP = '/discover/movie?language=en-US&include_adult=false&with_genres=10751,16&certification_country=US&certification.lte=PG&sort_by=vote_average.desc&vote_count.gte=50';
const KIDS_TV_TOP = '/discover/tv?language=en-US&include_adult=false&with_genres=10762,16&certification_country=US&certification.lte=TV-PG&sort_by=vote_average.desc&vote_count.gte=20';
const KIDS_TV_AIRING = '/discover/tv?language=en-US&include_adult=false&with_genres=10762,16&certification_country=US&certification.lte=TV-PG&sort_by=popularity.desc';

// "Stories" — short tellings a child can finish in one sitting. TMDB has no
// "story" genre, so the rail is built from the two things that actually ARE
// story-length content: family/animation features under 40 minutes, and kids
// series with short episodes. `with_runtime.lte` is a real signal off TMDB, so
// this rail can never go stale the way a hand-written list would.
const KIDS_STORY_MOVIE = '/discover/movie?language=en-US&include_adult=false&with_genres=10751,16&certification_country=US&certification.lte=PG&with_runtime.lte=40&sort_by=popularity.desc';
const KIDS_STORY_TV = '/discover/tv?language=en-US&include_adult=false&with_genres=10762,16&certification_country=US&certification.lte=TV-PG&with_runtime.lte=30&sort_by=popularity.desc';

// "Learn & Explore" — nature and science a child can sit through. Capped at
// TV-PG because the documentary genre is the one place a general-audience
// ceiling still needs the genre gate on top of it.
const KIDS_LEARN_TV = '/discover/tv?language=en-US&include_adult=false&with_genres=9648&certification_country=US&certification.lte=TV-PG&sort_by=popularity.desc';
// A kids rail is only useful if the rows are labelled for kids, so the
// "cartoon / family / kids" naming matches what a parent expects to see.

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/w780';
const PAGES_PER_LIST = 5; // 5 pages × 20 = 100 titles per row
const CACHE_TTL_MS = 30 * 60 * 1000; // refresh TMDB data every 30 minutes

export const tmdbFetch = async (path) => {
  const token = process.env.TMDB_ACCESS_TOKEN;
  const apiKey = process.env.TMDB_API_KEY;
  if (!token && !apiKey) return null;

  const url = new URL(`${TMDB_BASE_URL}${path}`);
  if (apiKey) url.searchParams.set('api_key', apiKey);

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`TMDB request failed with ${response.status}`);
  return response.json();
};

// Fetch several pages of one list and merge them (TMDB caps at 20 per page).
const fetchPages = async (path, pages = PAGES_PER_LIST) => {
  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) =>
      tmdbFetch(`${path}${path.includes('?') ? '&' : '?'}page=${i + 1}`).catch(() => null)
    )
  );
  const seen = new Set();
  const items = [];
  for (const page of results) {
    for (const item of page?.results || []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
};

// ==== Admin artwork/metadata overrides ====
// The admin panel can edit posters, thumbnails and text of the LIVE TMDB titles.
// Edits are stored in Mongo (models/TmdbOverride.js) and merged over every
// normalized TMDB response — rails, search, browse, explore and the detail modal.
// Overrides are applied at SERVE time (not inside the 30-min caches), so an admin
// edit shows up on the site immediately without waiting for a cache to expire.
let overrideMap = new Map(); // "movie-123" -> lean override doc
let overridesLoadedAt = 0;
const OVERRIDES_TTL_MS = 60 * 1000;

export const reloadTmdbOverrides = async () => {
  try {
    const docs = await TmdbOverride.find().lean();
    const m = new Map();
    for (const d of docs) m.set(`${d.mediaType}-${d.tmdbId}`, d);
    overrideMap = m;
    overridesLoadedAt = Date.now();
  } catch (err) {
    // DB hiccup: keep serving the previous map, retry after the TTL
    console.error('reloadTmdbOverrides:', err.message);
    overridesLoadedAt = Date.now();
  }
};

export const ensureTmdbOverrides = async () => {
  if (Date.now() - overridesLoadedAt > OVERRIDES_TTL_MS) await reloadTmdbOverrides();
};

// Merge admin overrides into an array of normalized items. Empty override fields
// fall back to the original TMDB values, so admins can set just a thumbnail.
export const applyTmdbOverrides = (items) => {
  if (!Array.isArray(items) || overrideMap.size === 0) return items;
  return items.map((it) => {
    const o = overrideMap.get(String(it._id || '').replace(/^tmdb-/, ''));
    if (!o) return it;
    return {
      ...it,
      title: o.title || it.title,
      description: o.description || it.description,
      posterUrl: o.posterUrl || it.posterUrl,
      bannerUrl: o.bannerUrl || it.bannerUrl,
      logoUrl: o.logoUrl || it.logoUrl || '',
      tagline: o.tagline || it.tagline || '',
      trailerUrl: o.trailerUrl || it.trailerUrl || '',
      edited: true,
    };
  });
};

const withHomeOverrides = (feed, includeOlderTitleRows = []) => ({
  ...feed,
  rows: (Array.isArray(feed.rows) ? feed.rows : []).map((row) => {
    const items = applyTmdbOverrides(row.items);
    const out = {
      ...row,
      items: includeOlderTitleRows.includes(row.key) ? items : currentCatalogueItems(items),
    };
    if (Array.isArray(row.top10)) out.top10 = currentCatalogueItems(applyTmdbOverrides(row.top10));
    return out;
  }).filter((row) => row.items.length > 0),
  ...(Array.isArray(feed.featured) ? { featured: currentCatalogueItems(applyTmdbOverrides(feed.featured)) } : {}),
  ...(Array.isArray(feed.top10) ? { top10: currentCatalogueItems(applyTmdbOverrides(feed.top10)) } : {}),
});

const withKidsOverrides = (feed) => ({
  ...feed,
  rows: (Array.isArray(feed.rows) ? feed.rows : [])
    .map((row) => ({ ...row, items: applyTmdbOverrides(row.items) || [] }))
    .filter((row) => row.items.length > 0),
});

const withBrowseOverrides = (data) => ({
  ...data,
  ...(Array.isArray(data.top10) ? { top10: currentCatalogueItems(applyTmdbOverrides(data.top10)) } : {}),
  rows: (Array.isArray(data.rows) ? data.rows : [])
    .map((row) => ({ ...row, items: currentCatalogueItems(applyTmdbOverrides(row.items)) }))
    .filter((row) => row.items.length > 0),
});

const personalizeTmdbFeed = (feed, req, rowLimit = 20) => {
  const seed = feedSeed(req);
  const pick = (items, salt, limit) => personalize(items, {
    seed,
    salt,
    limit,
    keepTop: Math.min(6, limit),
  });

  return {
    ...feed,
    ...(Array.isArray(feed.featured) ? { featured: pick(feed.featured, 'featured', 10) } : {}),
    ...(Array.isArray(feed.top10) ? { top10: pick(feed.top10, 'top10', 10) } : {}),
    rows: (feed.rows || [])
      .map((row) => ({
        ...row,
        items: pick(row.items, `row:${row.key}`, row.top10 ? 10 : rowLimit),
        ...(Array.isArray(row.top10) ? { top10: pick(row.top10, `top10:${row.key}`, 10) } : {}),
      }))
      .filter((row) => row.items.length > 0),
  };
};

// TMDB genre ids -> display names (movie + TV maps merged).
// Lets every card/hover show real genre names straight from the list endpoints.
const GENRE_NAMES = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi',
  53: 'Thriller', 10752: 'War', 37: 'Western',
  10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News', 10764: 'Reality',
  10765: 'Sci-Fi & Fantasy', 10766: 'Romance', 10767: 'Talk', 10768: 'War & Politics',
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_USER_CATALOGUE_YEAR = 2023;
const MIN_EXPLORE_YEAR = 1874;
const MAX_USER_CATALOGUE_YEAR = new Date().getUTCFullYear();

const isCurrentCatalogueTitle = (item) => {
  const id = String(item?._id || '');
  if (!id.startsWith('tmdb-')) return true;
  const year = Number(item.releaseYear || String(item.releaseDate || '').slice(0, 4));
  return year >= MIN_USER_CATALOGUE_YEAR && year <= MAX_USER_CATALOGUE_YEAR;
};

const currentCatalogueItems = (items = []) => (
  Array.isArray(items) ? items.filter(isCurrentCatalogueTitle) : []
);
const recentDateParams = (type) => type === 'tv'
  ? `&first_air_date.gte=${MIN_USER_CATALOGUE_YEAR}-01-01&first_air_date.lte=${MAX_USER_CATALOGUE_YEAR}-12-31`
  : `&primary_release_date.gte=${MIN_USER_CATALOGUE_YEAR}-01-01&primary_release_date.lte=${MAX_USER_CATALOGUE_YEAR}-12-31`;
const recentDiscoverPath = (path, type) => {
  if (!path.startsWith(`/discover/${type}?`)) return path;
  const [endpoint, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  const startKey = type === 'tv' ? 'first_air_date.gte' : 'primary_release_date.gte';
  const endKey = type === 'tv' ? 'first_air_date.lte' : 'primary_release_date.lte';
  params.set(startKey, `${MIN_USER_CATALOGUE_YEAR}-01-01`);
  params.set(endKey, `${MAX_USER_CATALOGUE_YEAR}-12-31`);
  return `${endpoint}?${params.toString()}`;
};

export const normalize = (item, type = 'movie') => {
  const dateStr = item.release_date || item.first_air_date || '';
  const ts = dateStr ? Date.parse(dateStr) : NaN;
  const now = Date.now();
  return {
    _id: `tmdb-${type}-${item.id}`,
    // Prefer the localized (English) display title, fall back to the original name
    title: item.title || item.name || item.original_title || item.original_name,
    originalTitle: item.original_title || item.original_name || '',
    description: item.overview || 'Discover this title on TMDB.',
    releaseYear: Number(dateStr.slice(0, 4)) || null,
    type,
    posterUrl: item.poster_path ? `${IMAGE_BASE_URL}${item.poster_path}` : '',
    bannerUrl: item.backdrop_path ? `${IMAGE_BASE_URL}${item.backdrop_path}` : '',
    tmdbUrl: `https://www.themoviedb.org/${type}/${item.id}`,
    genres: (item.genre_ids || []).map((id) => GENRE_NAMES[id]).filter(Boolean).slice(0, 3),
    originCountry: item.origin_country?.[0] || '',
    ageRating: item.adult ? '18+' : '13+',
    matchPercentage: Math.round((item.vote_average || 0) * 10),
    durationMinutes: item.runtime || (item.episode_run_time?.[0] ?? 0),
    seasonsCount: item.number_of_seasons || 0,
    // Netflix prints "Recently added" / "New Episode" chips on artwork released in the last ~45 days
    isNewRelease: !Number.isNaN(ts) && ts <= now && now - ts < 45 * DAY_MS,
    // raw values so the explore page can re-sort merged movie + TV lists
    popularity: item.popularity || 0,
    voteAverage: item.vote_average || 0,
    voteCount: item.vote_count || 0,
    releaseDate: dateStr,
  };
};

// The kid catalogue. Kept in its own cache because it is a different set of
// lists — serving grown-up "Trending This Week" to a kids profile would be
// exactly the bug this avoids. It is also what the navbar KIDS button renders,
// so a grown-up member can reach the same kid-safe lists without switching to
// a Kids profile first.
const kidsCache = { data: null, at: 0, pending: null };

// Admin-created kid titles have to appear here too, or the KIDS button shows a
// TMDB-only catalogue and everything the admin flagged `isKids` stays invisible
// outside a Kids profile. `withMaturity` with a synthetic kids profile reuses
// the exact rule the Kids PROFILE feed uses, so the page and the profile can
// never disagree about what counts as kid-safe.
const localKidsTitles = async () => {
  try {
    return await Title.find(withMaturity({
      status: 'published',
      releaseYear: { $gte: MIN_USER_CATALOGUE_YEAR, $lte: MAX_USER_CATALOGUE_YEAR },
    }, { isKidsProfile: true }))
      .sort({ createdAt: -1 })
      .limit(40)
      .lean();
  } catch (err) {
    // A DB hiccup must not cost the member the whole page — the TMDB rails
    // have already resolved by this point.
    console.error('kidsFeed local titles:', err.message);
    return [];
  }
};

const buildKidsFeed = async () => {
  const [movies, tv, certifiedMovies, certifiedTv, topMovies, topTv, airingTv, storyMovies, storyTv, learnTv, local] = await Promise.all([
    fetchPages(KIDS_MOVIE_DISCOVER, 3),
    fetchPages(KIDS_TV_DISCOVER, 3),
    fetchPages(KIDS_CERTIFIED_MOVIE_POOL, 5),
    fetchPages(KIDS_CERTIFIED_TV_POOL, 5),
    fetchPages(KIDS_MOVIE_TOP, 2),
    fetchPages(KIDS_TV_TOP, 2),
    fetchPages(KIDS_TV_AIRING, 2),
    fetchPages(KIDS_STORY_MOVIE, 3),
    fetchPages(KIDS_STORY_TV, 3),
    fetchPages(KIDS_LEARN_TV, 2),
    localKidsTitles(),
  ]);
  // Every list above is already certification-capped at PG / TV-PG, which is
  // what our "7+" bucket means (see CERT_MAP in utils/maturity.js). Saying so on
  // the card is honest; leaving normalize()'s guessed "13+" is not. `isKids` is
  // what lets these titles through the detail + watch gates for a Kids profile.
  const asKids = (list, type) => (list || []).map((i) => ({
    ...normalize(i, type), isKids: true, ageRating: '7+',
  }));
  const asMovies = (list) => asKids(list, 'movie');
  const asTv = (list) => asKids(list, 'tv');

  const kidMovies = asMovies(movies);
  const kidTop10Movies = currentCatalogueItems(kidMovies);
  const kidTv = asTv(tv);
  const localMovies = (local || []).filter((t) => t.type === 'movie');
  const localSeries = (local || []).filter((t) => t.type === 'series');
  const uniqueKidsItems = (...lists) => {
    const seen = new Set();
    return lists.flat()
      .filter((item) => {
        if (!item?._id || seen.has(String(item._id))) return false;
        seen.add(String(item._id));
        return true;
      });
  };
  const familyMoviePool = uniqueKidsItems(
    kidMovies,
    asMovies(topMovies),
    asMovies(storyMovies),
    asMovies(certifiedMovies),
    localMovies,
  );
  const familyTvPool = uniqueKidsItems(
    kidTv,
    asTv(topTv),
    asTv(airingTv),
    asTv(storyTv),
    asTv(learnTv),
    asTv(certifiedTv),
    localSeries,
  );
  const storyItems = uniqueKidsItems(
    asMovies(storyMovies),
    asTv(storyTv),
    familyMoviePool,
    familyTvPool,
  );
  const fillKidsRow = (items, fallbacks = []) => uniqueKidsItems(items, fallbacks).slice(0, 20);

  return {
    configured: Boolean(process.env.TMDB_ACCESS_TOKEN || process.env.TMDB_API_KEY),
    kids: true,
    // `section` drives the page's tab pills, `explorePath` the rail's
    // "Explore All ›" button — the server owns both so the page never has to
    // hardcode a list of row keys.
    rows: [
      { key: 'tmdb-kids-top10', section: 'top', title: 'Top 10 Cartoons & Family Today', top10: true, explorePath: '/browse/tmdb-genre-family', items: kidTop10Movies },
      { key: 'tmdb-kids-stories', section: 'stories', title: 'Stories & Short Tales', explorePath: '/browse/tmdb-genre-animation', items: fillKidsRow(storyItems, [...familyMoviePool, ...familyTvPool]) },
      { key: 'tmdb-kids-movies', section: 'movies', title: 'Cartoons & Family Movies', explorePath: '/browse/tmdb-genre-family', items: fillKidsRow(kidMovies, familyMoviePool) },
      { key: 'tmdb-kids-tv', section: 'shows', title: 'Kids & Animation Series', explorePath: '/browse/tmdb-genre-kids', items: fillKidsRow(kidTv, familyTvPool) },
      { key: 'tmdb-kids-top-movies', section: 'movies', title: 'Best Family Movies', explorePath: '/browse/tmdb-genre-family', items: fillKidsRow(asMovies(topMovies), familyMoviePool) },
      { key: 'tmdb-kids-top-tv', section: 'shows', title: 'Best Kids Series', explorePath: '/browse/tmdb-genre-kids', items: fillKidsRow(asTv(topTv), familyTvPool) },
      { key: 'tmdb-kids-airing', section: 'shows', title: 'Kids Shows & New Episodes', explorePath: '/browse/tmdb-genre-kids', items: fillKidsRow(asTv(airingTv), familyTvPool) },
      { key: 'tmdb-kids-learn', section: 'learn', title: 'Learn & Explore', explorePath: '/browse/tmdb-genre-documentary', items: fillKidsRow(asTv(learnTv), familyTvPool) },
      { key: 'local-kids-movies', section: 'movies', title: 'Kids Movies & Family Picks', items: fillKidsRow(localMovies, familyMoviePool) },
      { key: 'local-kids-series', section: 'shows', title: 'Kids Series & Cartoons', items: fillKidsRow(localSeries, familyTvPool) },
    ].filter((row) => row.items.length > 0),
  };
};

const getKidsFeed = async () => {
  if (kidsCache.data && Date.now() - kidsCache.at < CACHE_TTL_MS) return kidsCache.data;
  if (!kidsCache.pending) {
    kidsCache.pending = buildKidsFeed()
      .then((data) => { kidsCache.data = data; kidsCache.at = Date.now(); return data; })
      .finally(() => { kidsCache.pending = null; });
  }
  return kidsCache.pending;
};

export const tmdbHome = async (req, res) => {
  if (!process.env.TMDB_ACCESS_TOKEN && !process.env.TMDB_API_KEY) {
    return res.json({ rows: [], configured: false });
  }
  await ensureTmdbOverrides();

  // A Kids profile gets a completely different, kid-safe catalogue.
  if (isKidsRequest(req.profile)) {
    try {
      return res.json(personalizeTmdbFeed(withKidsOverrides(await getKidsFeed()), req));
    } catch {
      return res.json({ rows: [], configured: true, kids: true });
    }
  }

  // Serve the cached feed while a refresh runs in the background — the response
  // stays instant even though we now fetch ~12 TMDB lists.
  if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
    return res.json(personalizeTmdbFeed(withHomeOverrides(cache.data), req));
  }
  if (!cache.pending) {
    cache.pending = (async () => {
      // TMDB occasionally throttles a cold burst of ~40 parallel page requests,
      // so retry the whole feed once before surfacing an error.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const data = await buildFeed();
          cache.data = data;
          cache.at = Date.now();
          return data;
        } catch (err) {
          console.error(`tmdbHome refresh (attempt ${attempt}):`, err.message);
          if (attempt === 2) throw err;
          await new Promise((r) => setTimeout(r, 700));
        }
      }
    })().finally(() => { cache.pending = null; });
  }
  if (cache.data) return res.json(personalizeTmdbFeed(withHomeOverrides(cache.data), req));

  try {
    res.json(personalizeTmdbFeed(withHomeOverrides(await cache.pending), req));
  } catch {
    res.status(502).json({ message: 'TMDB content is temporarily unavailable' });
  }
};

// @route GET /api/tmdb/kids — the navbar KIDS button.
//
// The kid catalogue as its own destination rather than a profile switch: any
// member can open it, and a member who is already on a Kids profile gets the
// same lists (the profile feed already serves nothing but kid-safe titles).
// TMDB rails are certification-capped server-side and the local rail goes
// through the same withMaturity() rule a Kids profile gets, so nothing grown-up
// can reach this page by any route.
export const tmdbKids = async (req, res) => {
  const configured = Boolean(process.env.TMDB_ACCESS_TOKEN || process.env.TMDB_API_KEY);
  try {
    await ensureTmdbOverrides();
    return res.json(personalizeTmdbFeed(withKidsOverrides(await getKidsFeed()), req));
  } catch (err) {
    // Unlike tmdbHome this never 502s: with no TMDB key the local kids rail is
    // still a real page, and a TMDB outage should not blank it out.
    console.error('tmdbKids:', err.message);
    return res.json({ rows: [], configured, kids: true });
  }
};

// ==== /tmdb/new-popular — the navbar "New & Popular" button ====
//
// Netflix's New & Popular is a set of rails, not a filter grid: what arrived
// recently, what everyone is watching this week, and the day's Top 10. Every
// row below is a real TMDB list rather than a hand-curated one, so the page
// cannot go stale the way an admin-maintained list would.
//
// `type: 'mix'` is used for /trending/all, the only TMDB list that returns
// movies and series in one payload (plus people, which are dropped).
const NEW_POPULAR = {
  heading: 'New & Popular',
  top10Title: 'Top 10 Today',
  top10: { path: '/trending/all/day?language=en-US', pages: 2 },
  rows: [
    { key: 'np-new-movies', section: 'new', title: 'New Release Movies', type: 'movie', pages: 2, explorePath: '/browse/tmdb-now-playing', path: '/discover/movie?language=en-US&include_adult=false&sort_by=primary_release_date.desc&vote_count.gte=20' },
    { key: 'np-new-series', section: 'new', title: 'New Episodes', type: 'tv', pages: 2, explorePath: '/browse/tmdb-airing-today', path: '/discover/tv?language=en-US&include_adult=false&sort_by=first_air_date.desc&vote_count.gte=20' },
    { key: 'np-k-dramas', section: 'new', title: 'K-Dramas (2023–2026)', type: 'tv', pages: 3, explorePath: '/browse/tmdb-genre-korean-dramas', path: `/discover/tv?language=en-US&include_adult=false&with_genres=18&with_original_language=ko${recentDateParams('tv')}&sort_by=popularity.desc&vote_count.gte=5` },
    { key: 'np-korean-movies', section: 'new', title: 'Korean Movies (2023–2026)', type: 'movie', pages: 3, explorePath: '/browse/tmdb-languages', path: `/discover/movie?language=en-US&include_adult=false&with_original_language=ko${recentDateParams('movie')}&sort_by=popularity.desc&vote_count.gte=5` },
    { key: 'np-english-movies', section: 'new', title: 'English Movies (2023–2026)', type: 'movie', pages: 3, explorePath: '/browse/tmdb-languages', path: `/discover/movie?language=en-US&include_adult=false&with_original_language=en${recentDateParams('movie')}&sort_by=popularity.desc&vote_count.gte=5` },
    { key: 'np-new-series-recent', section: 'new', title: 'New Series (2023–2026)', type: 'tv', pages: 3, explorePath: '/browse/tmdb-airing-today', path: `/discover/tv?language=en-US&include_adult=false${recentDateParams('tv')}&sort_by=first_air_date.desc&vote_count.gte=5` },
    { key: 'np-now-playing', section: 'new', title: 'Now Playing in Theaters', type: 'movie', pages: 2, explorePath: '/browse/tmdb-now-playing', path: '/movie/now_playing?language=en-US' },
    { key: 'np-airing-today', section: 'new', title: 'Airing Today', type: 'tv', pages: 5, explorePath: '/browse/tmdb-airing-today', path: '/tv/airing_today?language=en-US' },
    { key: 'np-trending', section: 'popular', title: 'Trending This Week', type: 'mix', pages: 3, explorePath: '/browse/tmdb-trending', path: '/trending/all/week?language=en-US' },
    { key: 'np-trending-movies', section: 'popular', title: 'Trending Movies', type: 'movie', pages: 2, explorePath: '/browse/tmdb-trending-movies', path: '/trending/movie/week?language=en-US' },
    { key: 'np-trending-tv', section: 'popular', title: 'Trending Series', type: 'tv', pages: 2, explorePath: '/browse/tmdb-trending-tv', path: '/trending/tv/week?language=en-US' },
    { key: 'np-popular-movies', section: 'popular', title: 'Popular Movies This Week', type: 'movie', pages: 3, explorePath: '/browse/tmdb-popular-movies', path: '/movie/popular?language=en-US' },
    { key: 'np-popular-tv', section: 'popular', title: 'Popular Series This Week', type: 'tv', pages: 3, explorePath: '/browse/tmdb-popular-tv', path: '/tv/popular?language=en-US' },
  ],
};

// /trending/all interleaves movies, series and people; keep the two we can show
// and drop the people, exactly like the home feed's mixed trending rail does.
const asList = (list, type, includeOlderTitles = false) => (list || [])
  .filter((i) => (type === 'mix' ? (i.media_type === 'movie' || i.media_type === 'tv') : true))
  .map((i) => normalize(i, type === 'mix' ? i.media_type : type))
  .filter((item) => includeOlderTitles || isCurrentCatalogueTitle(item));

const newPopularCache = { data: null, at: 0, pending: null };

const buildNewPopularFeed = async () => {
  const [top10Raw, ...lists] = await Promise.all([
    fetchPages(NEW_POPULAR.top10.path, NEW_POPULAR.top10.pages),
    ...NEW_POPULAR.rows.map((r) => fetchPages(r.path, r.pages)),
  ]);
  const rows = NEW_POPULAR.rows.map((r, i) => ({
    key: r.key,
    section: r.section,
    title: r.title,
    explorePath: r.explorePath,
    // Airing-today includes ongoing shows whose original premiere may predate
    // the site's recent-release window; the endpoint itself establishes that
    // they're currently airing, so don't hide them based on premiere year.
    items: asList(lists[i], r.type, r.key === 'np-airing-today'),
  }));
  return {
    configured: true,
    heading: NEW_POPULAR.heading,
    top10Title: NEW_POPULAR.top10Title,
    top10: asList(top10Raw, 'mix'),
    rows: rows.filter((r) => r.items.length > 0),
  };
};

const getNewPopularFeed = async () => {
  if (newPopularCache.data && Date.now() - newPopularCache.at < CACHE_TTL_MS) return newPopularCache.data;
  if (!newPopularCache.pending) {
    newPopularCache.pending = buildNewPopularFeed()
      .then((data) => { newPopularCache.data = data; newPopularCache.at = Date.now(); return data; })
      .finally(() => { newPopularCache.pending = null; });
  }
  return newPopularCache.pending;
};

// The local catalogue's own "New Release" titles belong on this page too, or
// the admin's newest uploads are invisible outside the home rails. withMaturity
// keeps them inside whatever the viewing profile is actually allowed to see.
const localNewReleases = async (profile) => {
  try {
    return await Title.find(withMaturity({
      status: 'published',
      isNewRelease: true,
      releaseYear: { $gte: MIN_USER_CATALOGUE_YEAR, $lte: MAX_USER_CATALOGUE_YEAR },
    }, profile))
      .sort({ createdAt: -1 })
      .limit(40)
      .lean();
  } catch (err) {
    console.error('newPopular local titles:', err.message);
    return [];
  }
};

// @route GET /api/tmdb/new-popular — the navbar "New & Popular" page.
export const tmdbNewPopular = async (req, res) => {
  const configured = Boolean(process.env.TMDB_ACCESS_TOKEN || process.env.TMDB_API_KEY);
  try {
    await ensureTmdbOverrides();
    // A Kids profile gets the cert-gated kid rails. TMDB's standard "new and
    // trending" lists carry no certification at all, so serving them to a Kids
    // profile would put grown-up titles on the page — the same rule /tmdb/home
    // already follows.
    const base = isKidsRequest(req.profile)
      ? await getKidsFeed()
      : configured
        ? await getNewPopularFeed()
        : { heading: NEW_POPULAR.heading, top10Title: NEW_POPULAR.top10Title, top10: [], rows: [] };

    const local = await localNewReleases(req.profile);
    const localMovies = local.filter((t) => t.type === 'movie');
    const localSeries = local.filter((t) => t.type === 'series');

    const feed = {
      ...base,
      configured,
      // Billboard pool: today's Top 10 first, then the newest arrivals, so the
      // hero leads with what is actually new and popular.
      featured: [...(base.top10 || []), ...(base.rows?.[0]?.items || [])],
      rows: [
        ...(base.rows || []),
        ...(localMovies.length ? [{ key: 'local-new-movies', section: 'new', title: 'New on Newflix', items: localMovies }] : []),
        ...(localSeries.length ? [{ key: 'local-new-series', section: 'new', title: 'New Series on Newflix', items: localSeries }] : []),
      ],
    };

    // The TMDB cache is shared by every profile, so maturity filtering happens
    // at SERVE time (same rule as /tmdb/browse/:type) — a restricted profile
    // can never inherit the adult list it happens to hit.
    const limitRank = maturityRank(requestLimit(req.profile));
    const out = limitRank !== null && limitRank < MATURITY_ORDER.indexOf('18+')
      ? {
        ...feed,
        top10: (feed.top10 || []).filter((it) => allowsTitle(req.profile, it)),
        featured: (feed.featured || []).filter((it) => allowsTitle(req.profile, it)),
        rows: (feed.rows || [])
          .map((row) => ({ ...row, items: (row.items || []).filter((it) => allowsTitle(req.profile, it)) }))
          .filter((row) => row.items.length > 0),
      }
      : feed;

    return res.json(personalizeTmdbFeed(withHomeOverrides(out, ['np-airing-today']), req));
  } catch (err) {
    // Never 502: the local "New on Newflix" rails are still a real page.
    console.error('tmdbNewPopular:', err.message);
    return res.json({ rows: [], top10: [], configured, heading: NEW_POPULAR.heading });
  }
};

const DETAIL_BASE = 'https://image.tmdb.org/t/p/w780';

const tmdbAgeRating = (d, type) => {
  if (type === 'tv') {
    const us = (d.content_ratings?.results || []).find((r) => r.iso_3166_1 === 'US');
    return us?.rating ? us.rating.replace('TV-', 'TV') : '13+';
  }
  const us = (d.release_dates?.results || []).find((r) => r.iso_3166_1 === 'US');
  return us?.release_dates?.find((r) => r.certification)?.certification || '13+';
};

const buildTmdbDetailItem = (d, type) => {
  const trailer = (d.videos?.results || []).find(
    (v) => v.site === 'YouTube' && ['Trailer', 'Teaser'].includes(v.type)
  );
  const item = {
    ...normalize(d, type),
    ageRating: tmdbAgeRating(d, type),
    genres: (d.genres || []).map((g) => g.name),
    audioLanguages: (d.spoken_languages || [])
      .map((language) => language.english_name || language.name).filter(Boolean),
    tagline: d.tagline || '',
    durationMinutes: d.runtime || (d.episode_run_time?.[0] ?? 0),
    seasonsCount: d.number_of_seasons || 0,
    episodesCount: d.number_of_episodes || 0,
    cast: (d.credits?.cast || []).slice(0, 6).map((c) => c.name),
    director: (d.credits?.crew || []).find((c) => c.job === 'Director')?.name
      || (d.created_by?.[0]?.name ?? ''),
    keywords: (d.keywords?.keywords || d.keywords?.results || [])
      .map((keyword) => keyword.name).filter(Boolean).slice(0, 8),
    trailerUrl: trailer ? `https://www.youtube.com/embed/${trailer.key}?autoplay=1` : '',
    seasons: (d.seasons || [])
      .filter((s) => s.season_number > 0 || (d.seasons || []).length === 1)
      .map((s) => ({
        seasonNumber: s.season_number,
        name: s.name,
        episodeCount: s.episode_count,
        posterUrl: s.poster_path ? `${DETAIL_BASE}${s.poster_path}` : '',
      })),
    recommendations: (d.recommendations?.results || [])
      .filter((r) => r.poster_path && isCurrentCatalogueTitle(normalize(r, r.media_type || type)))
      .slice(0, 12)
      .map((r) => normalize(r, r.media_type || type)),
  };
  item.recommendations = applyTmdbOverrides(item.recommendations);
  return applyTmdbOverrides([item])[0];
};

const mapTmdbEpisodes = (episodes = []) => episodes.map((ep) => ({
  _id: `tmdb-ep-${ep.id}`,
  id: `tmdb-ep-${ep.id}`,
  tmdbEpisodeId: Number(ep.id) || 0,
  episodeNumber: ep.episode_number,
  title: ep.name || `Episode ${ep.episode_number}`,
  description: ep.overview || '',
  durationMinutes: ep.runtime || 0,
  thumbnailUrl: ep.still_path ? `${DETAIL_BASE}${ep.still_path}` : '',
  airDate: ep.air_date || '',
  voteAverage: ep.vote_average || 0,
}));

// Hover-preview trailer for ONE title.
//
// The rails are built from normalize(), which deliberately stays cheap and does
// NOT request `videos` — so a rail card has no trailerUrl and the hover card had
// nothing to play. Rather than fattening every list response (a big payload for
// every tile on the page), the card asks for the teaser lazily, the moment the
// pointer actually lands on it, and the result is memoised here for the life of
// the process so sweeping back over a rail costs nothing.
//
// Result is cached per "type-id" for TRAILER_CACHE_TTL_MS; a miss is also cached
// briefly as null so a title with no teaser cannot be re-requested on every hover.
const TRAILER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TRAILER_MISS_TTL_MS = 10 * 60 * 1000;
const trailerCache = new Map(); // "movie-123" -> { at, url }

// TMDB trailer types, best first. "Trailer" is the full theatrical cut, which is
// the one worth previewing; "Teaser" is the fallback when a title has no trailer.
const pickTrailer = (videos = []) => videos
  .filter((v) => v.site === 'YouTube' && v.key)
  .sort((a, b) => {
    const rank = (v) => (v.type === 'Trailer' ? 0 : v.type === 'Teaser' ? 1 : v.type === 'Clip' ? 2 : 3);
    return rank(a) - rank(b);
  })[0];

// The same ranking as `pickTrailer`, but the WHOLE list rather than the single
// best one — the public title page prints a "Trailers" rail of every teaser and
// trailer a title has. De-duplicated by YouTube key, because TMDB regularly
// carries the same upload once per language, and cut to the handful a rail can
// actually show.
const pickVideos = (videos = [], limit = 8) => {
  const rank = (v) => (v.type === 'Trailer' ? 0 : v.type === 'Teaser' ? 1 : v.type === 'Clip' ? 2 : 3);
  const seen = new Set();
  const out = [];
  for (const v of [...videos].sort((a, b) => rank(a) - rank(b))) {
    if (v.site !== 'YouTube' || !v.key || seen.has(v.key)) continue;
    seen.add(v.key);
    out.push(v);
    if (out.length === limit) break;
  }
  return out;
};

export const tmdbTrailer = async (req, res) => {
  const { type, id } = req.params;
  if (!['movie', 'tv'].includes(type)) return res.status(400).json({ message: 'Bad type' });
  if (!process.env.TMDB_ACCESS_TOKEN && !process.env.TMDB_API_KEY) {
    return res.status(503).json({ message: 'TMDB not configured' });
  }

  const cacheKey = `${type}-${id}`;
  const cached = trailerCache.get(cacheKey);
  if (cached) {
    const ttl = cached.url ? TRAILER_CACHE_TTL_MS : TRAILER_MISS_TTL_MS;
    if (Date.now() - cached.at < ttl) {
      return res.json({ url: cached.url, runtime: cached.runtime || 0, ageRating: cached.ageRating || '' });
    }
  }

  try {
    const d = await tmdbFetch(`/${type}/${id}?language=en-US&append_to_response=videos,content_ratings,release_dates`);
    const trailer = pickTrailer(d?.videos?.results);
    // Muted + looping + chromeless: the exact flags an inline hover preview needs.
    // (Browsers only autoplay an iframe when it is muted.) The same list is
    // mirrored in frontend/src/components/Row.jsx (CHROMELESS_VARS), which is the
    // component that actually strips the remaining player chrome at runtime.
    const url = trailer
      ? `https://www.youtube.com/embed/${trailer.key}?autoplay=1&mute=1&controls=0&loop=1&playlist=${trailer.key}&modestbranding=1&showinfo=0&playsinline=1&rel=0&disablekb=1&fs=0&cc_load_policy=0&iv_load_policy=3&enablejsapi=1`
      : '';
    // TMDB's list endpoints (trending/popular/discover) never return `runtime` or a
    // certification, so a rail card shows no "1h 41m" and a guessed "13+". Both are
    // only knowable from the detail call we are already making for the trailer, so
    // they ride along here and the card fills itself in.
    const runtime = d?.runtime || (d?.episode_run_time?.[0] ?? 0);
    const ageRating = tmdbAgeRating(d, type);
    trailerCache.set(cacheKey, { at: Date.now(), url, runtime, ageRating });
    res.json({ url, runtime, ageRating });
  } catch (err) {
    console.error('tmdbTrailer:', err.message);
    res.status(502).json({ message: 'Trailer unavailable' });
  }
};

// ==== /tmdb/title-media/:type/:id — the two extra pieces of a title the PUBLIC
// title page (/p/only-on-netflix/title/:type/:id) prints above the fold, and the
// two that /tmdb/detail deliberately leaves out:
//
//   logoUrl   the transparent title TREATMENT Netflix lays over the backdrop.
//             `normalize()` has no logo field at all (a rail card has nothing to
//             do with one), so the only place it can come from is TMDB's images
//             endpoint — or an admin override, which the CALLER prefers.
//   videos    every YouTube teaser/trailer the title has, for the "Trailers"
//             rail. /tmdb/detail collapses these to the single best one because
//             the member modal only ever plays one.
//
// Both are essentially immutable for a given title, so the answer is cached for
// six hours rather than re-derived on every visit. Never 5xx: the page has real
// chrome (hero, info, rails, plans) that must survive TMDB being unavailable, so
// a failure answers with empty values and the page simply omits those two bits.
const titleMediaCache = new Map(); // "tv-81437051" -> { at, data }
const TITLE_MEDIA_TTL_MS = 6 * 60 * 60 * 1000;

// Title logos and backdrops are returned at their original TMDB resolution so
// the title page and full-width hero do not enlarge small thumbnails.
const LOGO_BASE = 'https://image.tmdb.org/t/p/w500';
const BACKDROP_BASE = 'https://image.tmdb.org/t/p/original';

export const tmdbTitleMedia = async (req, res) => {
  const { type, id } = req.params;
  if (!['movie', 'tv'].includes(type)) return res.status(400).json({ message: 'Bad type' });
  if (!process.env.TMDB_ACCESS_TOKEN && !process.env.TMDB_API_KEY) {
    return res.json({ configured: false, logoUrl: '', backdropUrl: '', videos: [] });
  }

  const cacheKey = `${type}-${id}`;
  const cached = titleMediaCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TITLE_MEDIA_TTL_MS) return res.json(cached.data);

  try {
    const [details, videos] = await Promise.all([
      tmdbFetch(`/${type}/${id}?language=en-US`).catch(() => null),
      tmdbFetch(`/${type}/${id}/videos?language=en-US`).catch(() => null),
    ]);
    const imageLanguages = [...new Set(['en', 'null', details?.original_language].filter(Boolean))].join(',');
    const images = await tmdbFetch(`/${type}/${id}/images?include_image_language=${encodeURIComponent(imageLanguages)}`).catch(() => null);

    // An English treatment first, then a language-neutral one, then anything
    // in the title's original language; ties broken by TMDB's vote_average.
    const langRank = (logo) => (
      logo.iso_639_1 === 'en' ? 0
        : !logo.iso_639_1 ? 1
          : logo.iso_639_1 === details?.original_language ? 2
            : 3
    );
    const best = [...(images?.logos || [])]
      .filter((l) => l.file_path)
      .sort((a, b) => langRank(a) - langRank(b) || (b.vote_average || 0) - (a.vote_average || 0))[0];
    const backdropLangRank = (image) => (!image.iso_639_1 ? 0 : image.iso_639_1 === 'en' ? 1 : 2);
    const bestBackdrop = [...(images?.backdrops || [])]
      .filter((image) => image.file_path)
      .sort((a, b) => backdropLangRank(a) - backdropLangRank(b)
        || (b.vote_average || 0) - (a.vote_average || 0)
        || (b.width || 0) - (a.width || 0))[0];

    const data = {
      configured: true,
      logoUrl: best ? `${LOGO_BASE}${best.file_path}` : '',
      backdropUrl: bestBackdrop ? `${BACKDROP_BASE}${bestBackdrop.file_path}` : '',
      videos: pickVideos(videos?.results).map((v) => ({
        key: v.key,
        name: v.name || '',
        type: v.type || '',
        official: Boolean(v.official),
      })),
    };
    titleMediaCache.set(cacheKey, { at: Date.now(), data });
    return res.json(data);
  } catch (err) {
    console.error('tmdbTitleMedia:', err.message);
    return res.json({ configured: true, logoUrl: '', backdropUrl: '', videos: [] });
  }
};

// Full detail for one TMDB title: overview, runtime, genres, cast, trailer,
// recommendations — everything the Netflix-style modal needs, one call.
export const tmdbDetail = async (req, res) => {
  const { type, id } = req.params;
  if (!['movie', 'tv'].includes(type)) return res.status(400).json({ message: 'Bad type' });
  if (!process.env.TMDB_ACCESS_TOKEN && !process.env.TMDB_API_KEY) {
    return res.status(503).json({ message: 'TMDB not configured' });
  }
  await ensureTmdbOverrides();

  try {
    const d = await tmdbFetch(
      `/${type}/${id}?language=en-US&append_to_response=credits,videos,recommendations,content_ratings,release_dates,keywords`
    );
    if (!d || d.success === false) return res.status(404).json({ message: 'Title not found' });

    // Kids gate on the detail sheet too, so the modal cannot be opened directly.
    const item = buildTmdbDetailItem(d, type);
    if (!allowsTitle(req.profile, item)) {
      return res.status(404).json({ message: isKidsRequest(req.profile) ? 'Title not found' : maturityMessage(req.profile) });
    }

    if (item.recommendations.length < 12) {
      const genreIds = (d.genres || []).slice(0, 2).map((genre) => genre.id).filter(Boolean);
      const discoverPath = genreIds.length
        ? `/discover/${type}?language=en-US&include_adult=false&with_genres=${genreIds.join(',')}${recentDateParams(type)}&sort_by=popularity.desc&vote_count.gte=5`
        : '';
      const [similar, genreTitles] = await Promise.all([
        fetchPages(`/${type}/${id}/similar?language=en-US`, 2),
        discoverPath ? fetchPages(discoverPath, 2) : Promise.resolve([]),
      ]);
      const seen = new Set(item.recommendations.map((recommendation) => recommendation._id));
      const supplements = [...similar, ...genreTitles]
        .map((result) => normalize(result, type))
        .filter((recommendation) => recommendation.posterUrl
          && isCurrentCatalogueTitle(recommendation)
          && allowsTitle(req.profile, recommendation)
          && !seen.has(recommendation._id)
          && seen.add(recommendation._id))
        .map((recommendation) => recommendation);
      let recommendations = [...item.recommendations, ...supplements];

      if (recommendations.length < 9) {
        const recentPath = `/discover/${type}?language=en-US&include_adult=false${recentDateParams(type)}&sort_by=popularity.desc&vote_count.gte=5`;
        const recentTitles = await fetchPages(recentPath, 2);
        const recentSupplements = recentTitles
          .map((result) => normalize(result, type))
          .filter((recommendation) => recommendation.posterUrl
            && isCurrentCatalogueTitle(recommendation)
            && allowsTitle(req.profile, recommendation)
            && !seen.has(recommendation._id)
            && seen.add(recommendation._id));
        recommendations = [...recommendations, ...recentSupplements];
      }

      item.recommendations = applyTmdbOverrides(recommendations.slice(0, 30));
    }
    res.json({ item });
  } catch (err) {
    console.error('tmdbDetail:', err.message);
    res.status(502).json({ message: 'TMDB detail unavailable' });
  }
};

// Episode list for one season of a TMDB series (fetched when the user picks a season)
export const tmdbSeason = async (req, res) => {
  const { id, season } = req.params;
  if (!process.env.TMDB_ACCESS_TOKEN && !process.env.TMDB_API_KEY) {
    return res.status(503).json({ message: 'TMDB not configured' });
  }
  try {
    const d = await tmdbFetch(`/tv/${id}/season/${season}?language=en-US`);
    res.json({ episodes: mapTmdbEpisodes(d?.episodes || []) });
  } catch (err) {
    console.error('tmdbSeason:', err.message);
    res.status(502).json({ message: 'Season unavailable' });
  }
};
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const validObjectId = (value) => /^[a-f\d]{24}$/i.test(String(value || ''));

const findMappedLocalTitle = async (tmdbId, detail) => {
  const override = await TmdbOverride.findOne({ tmdbId, mediaType: 'tv' }).select('localTitleId').lean();
  if (validObjectId(override?.localTitleId)) {
    const mapped = await Title.findOne({
      _id: override.localTitleId,
      type: 'series',
      status: 'published',
    }).lean();
    if (mapped) return mapped;
  }

  const explicit = await Title.findOne({
    tmdbType: 'tv', tmdbId, type: 'series', status: 'published',
  }).lean();
  if (explicit) return explicit;

  const names = [...new Set([detail.name, detail.original_name].filter(Boolean))];
  if (!names.length) return null;
  const candidates = await Title.find({
    type: 'series',
    status: 'published',
    $or: names.map((name) => ({ title: new RegExp(`^${escapeRegExp(name)}$`, 'i') })),
  }).lean();
  const year = Number(String(detail.first_air_date || '').slice(0, 4)) || 0;
  return candidates.find((candidate) => Number(candidate.releaseYear) === year)
    || (candidates.length === 1 ? candidates[0] : null);
};

// Movie counterpart of findMappedLocalTitle. A mapped local movie supplies an
// authorized direct source plus the Mongo WatchHistory identity, so its resume
// position and Continue Watching behave exactly like a locally-hosted title.
const findMappedLocalMovie = async (tmdbId, detail) => {
  const override = await TmdbOverride.findOne({ tmdbId, mediaType: 'movie' }).select('localTitleId').lean();
  if (validObjectId(override?.localTitleId)) {
    const mapped = await Title.findOne({
      _id: override.localTitleId,
      type: 'movie',
      status: 'published',
    }).lean();
    if (mapped) return mapped;
  }

  const explicit = await Title.findOne({
    tmdbType: 'movie', tmdbId, type: 'movie', status: 'published',
  }).lean();
  if (explicit) return explicit;

  const names = [...new Set([detail.title, detail.original_title].filter(Boolean))];
  if (!names.length) return null;
  const candidates = await Title.find({
    type: 'movie',
    status: 'published',
    $or: names.map((name) => ({ title: new RegExp(`^${escapeRegExp(name)}$`, 'i') })),
  }).lean();
  const year = Number(String(detail.release_date || '').slice(0, 4)) || 0;
  return candidates.find((candidate) => Number(candidate.releaseYear) === year)
    || (candidates.length === 1 ? candidates[0] : null);
};

const mapLocalEpisodes = (episodes, seasonNumber, posterFallback = '') => episodes.map((ep) => ({
  _id: String(ep._id),
  id: String(ep._id),
  episodeNumber: ep.episodeNumber,
  seasonNumber,
  title: ep.title || `Episode ${ep.episodeNumber}`,
  description: ep.description || '',
  durationMinutes: ep.durationMinutes || 0,
  thumbnailUrl: ep.thumbnailUrl || posterFallback,
  airDate: ep.releaseDate ? new Date(ep.releaseDate).toISOString().slice(0, 10) : '',
}));

const loadLocalEpisodeData = async (localTitle, tmdbItem) => {
  if (!localTitle) return { seasons: [], selectedSeason: null, selectedEpisode: null };
  const localSeasons = await Season.find({ title: localTitle._id }).sort({ seasonNumber: 1 }).lean();
  const seasons = await Promise.all(localSeasons.map(async (season) => ({
    _id: String(season._id),
    seasonNumber: season.seasonNumber,
    name: season.name || `Season ${season.seasonNumber}`,
    posterUrl: season.posterUrl || tmdbItem.posterUrl || '',
    episodes: mapLocalEpisodes(
      await Episode.find({ season: season._id, status: 'published' }).sort({ episodeNumber: 1 }).lean(),
      season.seasonNumber,
      season.posterUrl || tmdbItem.bannerUrl || tmdbItem.posterUrl || '',
    ),
  })));
  return { seasons, selectedSeason: null, selectedEpisode: null };
};

const loadMappedLocalEpisode = async (localTitle, seasonNumber, episodeNumber) => {
  if (!localTitle) return { localSeason: null, localEpisode: null };
  const localSeason = await Season.findOne({ title: localTitle._id, seasonNumber }).lean();
  const localEpisode = localSeason
    ? await Episode.findOne({
      season: localSeason._id,
      series: localTitle._id,
      episodeNumber,
      status: 'published',
    }).lean()
    : null;
  return { localSeason, localEpisode };
};

// @route GET /api/tmdb/tv/:id/watch?season=&episode=
// TMDB owns the metadata contract. A mapped local series supplies its real episode
// media + Mongo history identity; otherwise the configured provider resolver and
// the separate TMDB history collection supply those two concerns.
export const tmdbWatch = async (req, res) => {
  try {
    if (!process.env.TMDB_ACCESS_TOKEN && !process.env.TMDB_API_KEY) {
      return res.status(503).json({ message: 'TMDB not configured' });
    }
    if (!req.profileId) return res.status(400).json({ message: 'Choose a profile before playing' });
    const tmdbId = Number(req.params.id);
    const seasonNumber = Number(req.query.season || 1);
    const episodeNumber = Number(req.query.episode || 1);
    if (!Number.isSafeInteger(tmdbId) || tmdbId < 1
      || !Number.isSafeInteger(seasonNumber) || seasonNumber < 1
      || !Number.isSafeInteger(episodeNumber) || episodeNumber < 1) {
      return res.status(400).json({ message: 'Invalid TMDB series or episode coordinates' });
    }

    await ensureTmdbOverrides();
    const [detail, seasonData] = await Promise.all([
      tmdbFetch(`/tv/${tmdbId}?language=en-US&append_to_response=credits,videos,recommendations,content_ratings`),
      tmdbFetch(`/tv/${tmdbId}/season/${seasonNumber}?language=en-US`),
    ]);
    if (!detail || detail.success === false) return res.status(404).json({ message: 'Series not found' });

    const tmdbItem = buildTmdbDetailItem(detail, 'tv');
    // Kids gate. TMDB hands us the real certification here, so a Kids profile
    // cannot start an 18+ series by pasting /watch/tmdb/<id>.
    if (!allowsTitle(req.profile, tmdbItem)) {
      return res.status(403).json({ message: maturityMessage(req.profile) });
    }
    const tmdbEpisodes = mapTmdbEpisodes(seasonData?.episodes || []);
    const tmdbEpisode = tmdbEpisodes.find((episode) => episode.episodeNumber === episodeNumber);
    if (!tmdbEpisode) return res.status(404).json({ message: 'Episode not found' });

    const localTitle = await findMappedLocalTitle(tmdbId, detail);
    const [{ localEpisode }, localData] = await Promise.all([
      loadMappedLocalEpisode(localTitle, seasonNumber, episodeNumber),
      loadLocalEpisodeData(localTitle, tmdbItem),
    ]);

    const localSeasonData = localData.seasons.find(
      (season) => Number(season.seasonNumber) === seasonNumber,
    );
    // A title match alone is not enough: a partial local series (3 episodes) must
    // not mix local history/sources with TMDB provider episodes (20 episodes) in
    // the same season. Use the local mapping only when it covers the TMDB season.
    const localSeasonCoversRequested = Boolean(
      localEpisode && localSeasonData && localSeasonData.episodes.length >= tmdbEpisodes.length,
    );

    let source = null;
    let localIdentity = false;
    if (localTitle && localSeasonCoversRequested) {
      const localUrl = localEpisode.videoUrl || localTitle.videoUrl;
      if (localUrl) {
        const resolved = await resolvePlayable(
          localUrl,
          localEpisode.videoSourceType || localTitle.videoSourceType,
        );
        if (resolved.url) {
          source = resolved;
          localIdentity = true;
        }
      }
    }
    if (!source?.url) {
      source = await resolvePlayable(
        buildTmdbEpisodeSourceUrl(tmdbId, seasonNumber, episodeNumber),
        'embed',
      );
    }
    if (!source?.url) {
      return res.status(400).json({
        message: 'No playable source',
        detail: 'Add an authorized video source to a local series mapping before playing this episode.',
      });
    }

    const activeId = localIdentity ? String(localEpisode._id) : tmdbEpisode._id;
    const activeEpisode = {
      ...tmdbEpisode,
      _id: activeId,
      id: activeId,
      thumbnailUrl: tmdbEpisode.thumbnailUrl || localEpisode?.thumbnailUrl || tmdbItem.bannerUrl,
    };
    const railSeasons = localIdentity && localData.seasons.length
      ? localData.seasons
      : tmdbItem.seasons.map((season) => ({
        _id: `tmdb-season-${tmdbId}-${season.seasonNumber}`,
        seasonNumber: season.seasonNumber,
        name: season.name || `Season ${season.seasonNumber}`,
        posterUrl: season.posterUrl || tmdbItem.posterUrl || '',
        episodes: season.seasonNumber === seasonNumber ? tmdbEpisodes : [],
      }));

    let resumeSeconds = 0;
    let history;
    if (localIdentity) {
      const wh = await WatchHistory.findOne({ profile: req.profileId, title: localTitle._id });
      if (wh && !wh.completed && String(wh.episode || '') === activeId) {
        resumeSeconds = wh.progressSeconds || 0;
      }
      history = { kind: 'local', titleId: String(localTitle._id), episodeId: activeId };
    } else {
      const wh = await TmdbWatchHistory.findOne({ profile: req.profileId, tmdbId });
      if (wh && !wh.completed && wh.seasonNumber === seasonNumber && wh.episodeNumber === episodeNumber) {
        resumeSeconds = wh.progressSeconds || 0;
      }
      history = {
        kind: 'tmdb',
        tmdbId,
        seasonNumber,
        episodeNumber,
        titleSnapshot: {
          title: tmdbItem.title,
          description: tmdbItem.description || '',
          posterUrl: tmdbItem.posterUrl || '',
          bannerUrl: tmdbItem.bannerUrl || '',
          logoUrl: tmdbItem.logoUrl || '',
          tagline: tmdbItem.tagline || '',
          releaseYear: tmdbItem.releaseYear || 0,
          ageRating: tmdbItem.ageRating || '13+',
        },
        episodeSnapshot: {
          tmdbEpisodeId: tmdbEpisode.tmdbEpisodeId,
          seasonNumber,
          episodeNumber,
          title: tmdbEpisode.title,
          description: tmdbEpisode.description || '',
          thumbnailUrl: tmdbEpisode.thumbnailUrl || tmdbItem.bannerUrl || '',
          durationMinutes: tmdbEpisode.durationMinutes || 0,
        },
      };
    }

    res.json({
      video: { ...source, thumbnail: activeEpisode.thumbnailUrl || tmdbItem.bannerUrl },
      resumeSeconds,
      title: {
        id: `tmdb-tv-${tmdbId}`,
        type: 'series',
        title: tmdbItem.title,
        slug: `tmdb-tv-${tmdbId}`,
        ageRating: tmdbItem.ageRating || '13+',
        logoUrl: tmdbItem.logoUrl || '',
        tagline: tmdbItem.tagline || '',
        language: tmdbItem.audioLanguages?.[0] || '',
        description: tmdbItem.description || '',
        releaseYear: tmdbItem.releaseYear || '',
        durationMinutes: tmdbItem.durationMinutes || 0,
        bannerUrl: tmdbItem.bannerUrl || '',
        posterUrl: tmdbItem.posterUrl || '',
        audioLanguages: tmdbItem.audioLanguages || [],
        tmdb: { type: 'tv', id: tmdbId },
      },
      episode: activeEpisode,
      seasons: railSeasons,
      history,
      subtitles: localEpisode?.subtitleTracks || localTitle?.subtitleTracks || [],
      audio: localEpisode?.audioTracks || localTitle?.audioTracks || [],
      markers: localEpisode ? {
        recapStart: localEpisode.recapStart || 0,
        recapEnd: localEpisode.recapEnd || 0,
        introStart: localEpisode.introStart || 0,
        introEnd: localEpisode.introEnd || 0,
      } : null,
    });
  } catch (err) {
    console.error('tmdbWatch:', err);
    res.status(502).json({ message: 'TMDB episode playback is temporarily unavailable' });
  }
};

// @route GET /api/tmdb/movie/:id/watch
// Movie counterpart of tmdbWatch. TMDB supplies the metadata; a mapped local
// movie supplies an authorized direct source plus the Mongo history identity,
// and otherwise the configured provider source template is used. Movies have no
// season/episode coordinates, so the history record parks them at 1/1 (that
// schema requires both) while the player is told there is no episode.
export const tmdbMovieWatch = async (req, res) => {
  try {
    if (!process.env.TMDB_ACCESS_TOKEN && !process.env.TMDB_API_KEY) {
      return res.status(503).json({ message: 'TMDB not configured' });
    }
    if (!req.profileId) return res.status(400).json({ message: 'Choose a profile before playing' });
    const tmdbId = Number(req.params.id);
    if (!Number.isSafeInteger(tmdbId) || tmdbId < 1) {
      return res.status(400).json({ message: 'Invalid TMDB movie id' });
    }

    await ensureTmdbOverrides();
    const detail = await tmdbFetch(
      `/movie/${tmdbId}?language=en-US&append_to_response=credits,videos`,
    );
    if (!detail || detail.success === false) return res.status(404).json({ message: 'Movie not found' });

    const tmdbItem = buildTmdbDetailItem(detail, 'movie');
    // Same kids gate as the TV path above.
    if (!allowsTitle(req.profile, tmdbItem)) {
      return res.status(403).json({ message: maturityMessage(req.profile) });
    }
    const localTitle = await findMappedLocalMovie(tmdbId, detail);

    let source = null;
    let localIdentity = false;
    if (localTitle?.videoUrl) {
      const resolved = await resolvePlayable(localTitle.videoUrl, localTitle.videoSourceType);
      if (resolved.url) {
        source = resolved;
        localIdentity = true;
      }
    }
    if (!source?.url) {
      source = await resolvePlayable(buildTmdbMovieSourceUrl(tmdbId), 'embed');
    }
    if (!source?.url) {
      return res.status(400).json({
        message: 'No playable source',
        detail: 'Map this TMDB movie to a local title with an authorized video source before playing it.',
      });
    }

    let resumeSeconds = 0;
    let history;
    if (localIdentity) {
      const wh = await WatchHistory.findOne({ profile: req.profileId, title: localTitle._id });
      if (wh && !wh.completed) resumeSeconds = wh.progressSeconds || 0;
      history = { kind: 'local', titleId: String(localTitle._id), episodeId: null };
    } else {
      const wh = await TmdbWatchHistory.findOne({ profile: req.profileId, tmdbId });
      if (wh && !wh.completed) resumeSeconds = wh.progressSeconds || 0;
      history = {
        kind: 'tmdb',
        tmdbId,
        mediaType: 'movie',
        seasonNumber: 1,
        episodeNumber: 1,
        titleSnapshot: {
          title: tmdbItem.title,
          description: tmdbItem.description || '',
          posterUrl: tmdbItem.posterUrl || '',
          bannerUrl: tmdbItem.bannerUrl || '',
          logoUrl: tmdbItem.logoUrl || '',
          tagline: tmdbItem.tagline || '',
          releaseYear: tmdbItem.releaseYear || 0,
          ageRating: tmdbItem.ageRating || '13+',
        },
        episodeSnapshot: {
          tmdbEpisodeId: 0,
          seasonNumber: 1,
          episodeNumber: 1,
          title: tmdbItem.title,
          description: tmdbItem.description || '',
          thumbnailUrl: tmdbItem.bannerUrl || '',
          durationMinutes: tmdbItem.durationMinutes || 0,
        },
      };
    }

    res.json({
      video: { ...source, thumbnail: tmdbItem.bannerUrl || tmdbItem.posterUrl || '' },
      resumeSeconds,
      title: {
        id: `tmdb-movie-${tmdbId}`,
        type: 'movie',
        title: tmdbItem.title,
        slug: `tmdb-movie-${tmdbId}`,
        ageRating: tmdbItem.ageRating || '13+',
        logoUrl: tmdbItem.logoUrl || '',
        tagline: tmdbItem.tagline || '',
        language: tmdbItem.audioLanguages?.[0] || '',
        description: tmdbItem.description || '',
        releaseYear: tmdbItem.releaseYear || '',
        durationMinutes: tmdbItem.durationMinutes || 0,
        bannerUrl: tmdbItem.bannerUrl || '',
        posterUrl: tmdbItem.posterUrl || '',
        audioLanguages: tmdbItem.audioLanguages || [],
        tmdb: { type: 'movie', id: tmdbId },
      },
      episode: null,
      seasons: [],
      history,
      subtitles: localTitle?.subtitleTracks || [],
      audio: localTitle?.audioTracks || [],
      markers: localTitle ? {
        recapStart: localTitle.recapStart || 0,
        recapEnd: localTitle.recapEnd || 0,
        introStart: localTitle.introStart || 0,
        introEnd: localTitle.introEnd || 0,
      } : null,
    });
  } catch (err) {
    console.error('tmdbMovieWatch:', err);
    res.status(502).json({ message: 'TMDB movie playback is temporarily unavailable' });
  }
};

const cache = { data: null, at: 0, pending: null };



export const tmdbSearch = async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ items: [] });
  if (!process.env.TMDB_ACCESS_TOKEN && !process.env.TMDB_API_KEY) {
    return res.json({ items: [] });
  }
  await ensureTmdbOverrides();

  try {
    const data = await tmdbFetch(
      `/search/multi?language=en-US&include_adult=false&query=${encodeURIComponent(q)}`
    );
    // keep only movies/series — multi-search also returns people
    const items = (data?.results || [])
      .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
      .map((r) => normalize(r, r.media_type))
      .filter((item) => allowsTitle(req.profile, item));
    res.json({ items: applyTmdbOverrides(items) });
  } catch (err) {
    console.error('tmdbSearch:', err.message);
    res.status(502).json({ message: 'TMDB search is temporarily unavailable' });
  }
};


const buildFeed = async () => {
  const today = new Date().toISOString().slice(0, 10);
  const [
    popularMovies, topRatedMovies, nowPlaying,
    popularTV, topRatedTV, airingToday,
    trendingAll, trendingMovies, trendingTV,
    recentMovies, recentTV,
    koreanMovies, koreanDramas, englishMovies, newSeries,
  ] = await Promise.all([
    fetchPages('/movie/popular?language=en-US'),
    fetchPages('/movie/top_rated?language=en-US'),
    fetchPages('/movie/now_playing?language=en-US', 2),
    fetchPages('/tv/popular?language=en-US', PAGES_PER_LIST),
    fetchPages('/tv/top_rated?language=en-US'),
    fetchPages('/tv/airing_today?language=en-US', PAGES_PER_LIST),
    fetchPages('/trending/all/week?language=en-US', 2),
    fetchPages('/trending/movie/week?language=en-US', 2),
    fetchPages('/trending/tv/week?language=en-US', 2),
    fetchPages(`/discover/movie?language=en-US&include_adult=false&primary_release_date.gte=${MIN_USER_CATALOGUE_YEAR}-01-01&primary_release_date.lte=${today}&sort_by=primary_release_date.desc&vote_count.gte=5`, 2),
    fetchPages(`/discover/tv?language=en-US&include_adult=false&first_air_date.gte=${MIN_USER_CATALOGUE_YEAR}-01-01&first_air_date.lte=${today}&sort_by=first_air_date.desc&vote_count.gte=5`, 2),
    fetchPages(`/discover/movie?language=en-US&include_adult=false&with_original_language=ko${recentDateParams('movie')}&sort_by=popularity.desc&vote_count.gte=5`, 2),
    fetchPages(`/discover/tv?language=en-US&include_adult=false&with_original_language=ko&with_genres=18${recentDateParams('tv')}&sort_by=popularity.desc&vote_count.gte=5`, 2),
    fetchPages(`/discover/movie?language=en-US&include_adult=false&with_original_language=en${recentDateParams('movie')}&sort_by=popularity.desc&vote_count.gte=5`, 2),
    fetchPages(`/discover/tv?language=en-US&include_adult=false${recentDateParams('tv')}&sort_by=first_air_date.desc&vote_count.gte=5`, 2),
  ]);

  const movies = (items) => currentCatalogueItems(items.map((item) => normalize(item, 'movie')));
  const tv = (items) => currentCatalogueItems(items.map((item) => normalize(item, 'tv')));
  const trendingMixed = (trendingAll || []).filter((i) => i.media_type !== 'person');
  const recentReleases = [
    ...movies(recentMovies),
    ...tv(recentTV),
  ].sort((a, b) => String(b.releaseDate || '').localeCompare(String(a.releaseDate || ''))).slice(0, 60);

  return {
    configured: true,
    rows: [
      { key: 'tmdb-top10', title: 'Top 10 Movies in Netflix Today', top10: true, items: movies(popularMovies) },
      { key: 'tmdb-recent-releases', title: 'Recently Released', items: recentReleases },
      { key: 'tmdb-trending', title: 'Trending This Week', items: currentCatalogueItems(trendingMixed.map((i) => normalize(i, i.media_type || 'movie'))) },
      { key: 'tmdb-korean-dramas', title: 'K-Dramas (2023–2026)', items: tv(koreanDramas) },
      { key: 'tmdb-korean-movies', title: 'Korean Movies (2023–2026)', items: movies(koreanMovies) },
      { key: 'tmdb-english-movies', title: 'English Movies (2023–2026)', items: movies(englishMovies) },
      { key: 'tmdb-new-series', title: 'New Series (2023–2026)', items: tv(newSeries) },
      { key: 'tmdb-popular-movies', title: 'Popular Movies', items: movies(popularMovies) },
      { key: 'tmdb-popular-tv', title: 'Popular TV Series', items: tv(popularTV) },
      { key: 'tmdb-top-rated-movies', title: 'Top Rated Movies', items: movies(topRatedMovies) },
      { key: 'tmdb-top-rated-tv', title: 'Top Rated Series', items: tv(topRatedTV) },
      { key: 'tmdb-now-playing', title: 'Now Playing in Theaters', items: movies(nowPlaying) },
      { key: 'tmdb-airing-today', title: 'Airing Today', items: tv(airingToday) },
      { key: 'tmdb-trending-movies', title: 'Trending Movies', items: movies(trendingMovies) },
      { key: 'tmdb-trending-tv', title: 'Trending Series', items: tv(trendingTV) },
    ].filter((row) => row.items.length > 0),
  };
};

// ==== /tmdb/browse/:type — full Movies / TV Series pages (navbar buttons) ====
// Netflix-style genre pages: a Top 10 rail + category rails (Popular, Trending,
// genre rows like "TV Thrillers & Mysteries" / "TV Dramas" — screenshot ref 1).
const BROWSABLE = {
  movie: {
    heading: 'Movies',
    top10Title: 'Top 10 Movies in Netflix Today',
    rows: [
      { key: 'popular', title: 'Popular Movies', path: '/movie/popular?language=en-US', pages: 5 },
      { key: 'trending', title: 'Trending Now', path: '/trending/movie/week?language=en-US', pages: 2 },
      { key: 'top', title: 'Top Rated Movies', path: '/movie/top_rated?language=en-US', pages: 2 },
      { key: 'now', title: 'Now Playing in Theaters', path: '/movie/now_playing?language=en-US', pages: 2 },
      { key: 'g-action', title: 'Action Movies', path: '/discover/movie?language=en-US&sort_by=popularity.desc&with_genres=28', pages: 2 },
      { key: 'g-comedy', title: 'Comedies', path: '/discover/movie?language=en-US&sort_by=popularity.desc&with_genres=35', pages: 2 },
      { key: 'g-drama', title: 'Dramas', path: '/discover/movie?language=en-US&sort_by=popularity.desc&with_genres=18', pages: 2 },
      { key: 'g-horror', title: 'Horror Movies', path: '/discover/movie?language=en-US&sort_by=popularity.desc&with_genres=27', pages: 2 },
      { key: 'g-thriller', title: 'Thrillers & Mysteries', path: '/discover/movie?language=en-US&sort_by=popularity.desc&with_genres=53%7C9648', pages: 2 },
      { key: 'g-scifi', title: 'Sci-Fi & Fantasy', path: '/discover/movie?language=en-US&sort_by=popularity.desc&with_genres=878%7C14', pages: 2 },
      { key: 'g-romance', title: 'Romance', path: '/discover/movie?language=en-US&sort_by=popularity.desc&with_genres=10749', pages: 2 },
      { key: 'g-anim', title: 'Animation', path: '/discover/movie?language=en-US&sort_by=popularity.desc&with_genres=16', pages: 2 },
      { key: 'g-doc', title: 'Documentaries', path: '/discover/movie?language=en-US&sort_by=popularity.desc&with_genres=99', pages: 2 },
      { key: 'korean-movies-recent', title: 'Korean Movies (2023–2026)', path: '/discover/movie?language=en-US&sort_by=popularity.desc&with_original_language=ko', pages: 3 },
      { key: 'english-movies-recent', title: 'English Movies (2023–2026)', path: '/discover/movie?language=en-US&sort_by=popularity.desc&with_original_language=en', pages: 3 },
    ],
  },
  tv: {
    heading: 'TV Series',
    top10Title: 'Top 10 Series in Netflix Today',
    rows: [
      { key: 'popular', title: 'Popular TV Series', path: '/tv/popular?language=en-US', pages: 5 },
      { key: 'trending', title: 'Trending Series', path: '/trending/tv/week?language=en-US', pages: 2 },
      { key: 'top', title: 'Top Rated Series', path: '/tv/top_rated?language=en-US', pages: 2 },
      { key: 'airing', title: 'Airing Today', path: '/tv/airing_today?language=en-US', pages: 2 },
      { key: 'g-crime', title: 'TV Thrillers & Mysteries', path: '/discover/tv?language=en-US&sort_by=popularity.desc&with_genres=80%7C9648', pages: 2 },
      { key: 'g-drama', title: 'TV Dramas', path: '/discover/tv?language=en-US&sort_by=popularity.desc&with_genres=18', pages: 2 },
      { key: 'g-action', title: 'Action & Adventure TV', path: '/discover/tv?language=en-US&sort_by=popularity.desc&with_genres=10759', pages: 2 },
      { key: 'g-comedy', title: 'Comedy TV', path: '/discover/tv?language=en-US&sort_by=popularity.desc&with_genres=35', pages: 2 },
      { key: 'g-scifi', title: 'Sci-Fi & Fantasy TV', path: '/discover/tv?language=en-US&sort_by=popularity.desc&with_genres=10765', pages: 2 },
      { key: 'g-anime', title: 'Anime', path: '/discover/tv?language=en-US&sort_by=popularity.desc&with_genres=16', pages: 2 },
      { key: 'g-reality', title: 'Reality TV', path: '/discover/tv?language=en-US&sort_by=popularity.desc&with_genres=10764', pages: 2 },
      { key: 'g-romance', title: 'Romance TV', path: '/discover/tv?language=en-US&sort_by=popularity.desc&with_genres=10766', pages: 2 },
      { key: 'g-doc', title: 'Documentaries', path: '/discover/tv?language=en-US&sort_by=popularity.desc&with_genres=99', pages: 2 },
      { key: 'k-drama-recent', title: 'K-Dramas (2023–2026)', path: '/discover/tv?language=en-US&sort_by=popularity.desc&with_genres=18&with_original_language=ko', pages: 3 },
      { key: 'new-series-recent', title: 'New Series (2023–2026)', path: '/discover/tv?language=en-US&sort_by=first_air_date.desc', pages: 3 },
      { key: 'chinese-drama-recent', title: 'Recent Chinese Dramas', path: '/discover/tv?language=en-US&sort_by=popularity.desc&with_genres=18&with_original_language=zh', pages: 2 },
    ],
  },
};

const MIN_TV_BROWSE_ROW_ITEMS = 20;

const browseCaches = {
  movie: { data: null, at: 0, pending: null },
  tv: { data: null, at: 0, pending: null },
};

export const tmdbBrowse = async (req, res) => {
  const type = req.params.type === 'tv' ? 'tv' : 'movie';
  const spec = BROWSABLE[type];
  if (!process.env.TMDB_ACCESS_TOKEN && !process.env.TMDB_API_KEY) {
    return res.json({ configured: false, heading: spec.heading, top10Title: spec.top10Title, top10: [], rows: [] });
  }

  await ensureTmdbOverrides();
  const c = browseCaches[type];

  // Cached TMDB lists are maturity-filtered and personalised AT SERVE TIME, not
  // baked into the cache — the cache is shared by every profile, so a Kids
  // profile must not inherit the adult list it happens to hit.
  const forViewer = (data) => {
    let out = withBrowseOverrides(data);
    const limitRank = maturityRank(requestLimit(req.profile));
    if (limitRank !== null && limitRank < MATURITY_ORDER.indexOf('18+')) {
      out = {
        ...out,
        top10: (out.top10 || []).filter((it) => allowsTitle(req.profile, it)),
        rows: (out.rows || [])
          .map((row) => ({ ...row, items: (row.items || []).filter((it) => allowsTitle(req.profile, it)) }))
          .filter((row) => row.items.length > 0),
      };
    }
    return personalizeTmdbFeed(out, req);
  };

  if (c.data && Date.now() - c.at < CACHE_TTL_MS) return res.json(forViewer(c.data));

  if (!c.pending) {
    c.pending = (async () => {
      const [lists, recentTvPool] = await Promise.all([
        Promise.all(
          spec.rows.map((r) => fetchPages(recentDiscoverPath(r.path, type), r.pages).catch(() => []))
        ),
        type === 'tv'
          ? fetchPages(`/discover/tv?language=en-US&include_adult=false${recentDateParams('tv')}&sort_by=popularity.desc&vote_count.gte=5`, 5)
            .catch(() => [])
          : Promise.resolve([]),
      ]);
      const normalizedRecentTv = currentCatalogueItems(recentTvPool.map((item) => normalize(item, 'tv')));
      const rows = spec.rows
        .map((r, i) => {
          const items = currentCatalogueItems((lists[i] || []).map((item) => normalize(item, type)));
          if (type === 'tv' && items.length < MIN_TV_BROWSE_ROW_ITEMS) {
            const seen = new Set(items.map((item) => item._id));
            for (const item of normalizedRecentTv) {
              if (items.length >= MIN_TV_BROWSE_ROW_ITEMS) break;
              if (seen.has(item._id)) continue;
              items.push(item);
              seen.add(item._id);
            }
          }
          return { key: r.key, title: r.title, items };
        })
        .filter((r) => r.items.length > 0);
      const top10Source = type === 'tv'
        ? [...(lists[0] || []).map((item) => normalize(item, type)), ...normalizedRecentTv]
        : (lists[0] || []).map((item) => normalize(item, type));
      const top10Seen = new Set();
      const top10 = currentCatalogueItems(top10Source).filter((item) => {
        if (top10Seen.has(item._id)) return false;
        top10Seen.add(item._id);
        return true;
      });
      return {
        configured: true,
        heading: spec.heading,
        top10Title: spec.top10Title,
        top10,
        rows,
      };
    })();
    c.pending
      .then((data) => { c.data = data; c.at = Date.now(); })
      .catch((err) => console.error('tmdbBrowse:', err.message))
      .finally(() => { c.pending = null; });
  }

  try {
    res.json(forViewer(await c.pending));
  } catch {
    res.status(502).json({ message: 'TMDB browse unavailable' });
  }
};

// ==== /tmdb/only-on-netflix — the PUBLIC "Only on Netflix" page (genre 839338) ====
// The reference is a marketing page (no membership gate) and, unlike /tmdb/browse,
// its rail ORDER and TITLES are hand-curated by Netflix rather than derived from a
// genre feed — so they are declared here, in the reference's own order and with the
// reference's own titles, and each rail is backed by a real TMDB query. That keeps
// the headings identical to the reference while the titles under them stay live and
// can never go stale the way a hand-written list would.
//
// `explore` is the page a rail's own "Explore more" chip opens. Four rails carry no
// chip on the reference (the personal opener, "New on Netflix", "International TV
// Dramas" and "Action Movies"), which is why those are the only nulls.
//
// Read off the live page at 1280x900: 17 rails, each 961 wide on the 152px column,
// h2 32px/700, cards 184x283 (portrait 5:7 art + a 3-line clamp), 32px between rails.
const ONLY_ON_NETFLIX_ROWS = [
  { key: 'oon-next-watch', title: 'Your Next Watch', type: 'movie', pages: 3, explore: null,
    path: '/movie/popular?language=en-US' },
  { key: 'oon-reality', title: 'Reality, Variety & Talk Shows', type: 'tv', pages: 2, explore: null,
    path: '/discover/tv?language=en-US&sort_by=popularity.desc&with_genres=10764%7C10767' },
  { key: 'oon-suspenseful', title: 'Suspenseful Movies', type: 'movie', pages: 2, explore: '/browse/tmdb-genre-thriller',
    path: '/discover/movie?language=en-US&sort_by=popularity.desc&with_genres=53%7C9648' },
  { key: 'oon-kdramas', title: 'K-Dramas', type: 'tv', pages: 2, explore: '/browse/tmdb-genre-korean-dramas',
    path: '/discover/tv?language=en-US&sort_by=popularity.desc&with_genres=18&with_original_language=ko' },
  { key: 'oon-weekend', title: 'Watch in One Weekend', type: 'movie', pages: 2, explore: null,
    path: '/discover/movie?language=en-US&sort_by=popularity.desc&with_runtime.lte=120&vote_count.gte=200' },
  { key: 'oon-new', title: 'New on Netflix', type: 'movie', pages: 2, explore: null,
    path: '/movie/now_playing?language=en-US' },
  { key: 'oon-intl-tv-dramas', title: 'International TV Dramas', type: 'tv', pages: 2, explore: null,
    path: '/discover/tv?language=en-US&sort_by=popularity.desc&with_genres=18&with_original_language=es%7Cfr%7Ctr%7Cja%7Cde%7Cit' },
  { key: 'oon-gritty', title: 'Gritty Movies', type: 'movie', pages: 2, explore: '/browse/tmdb-genre-crime',
    path: '/discover/movie?language=en-US&sort_by=popularity.desc&with_genres=80%7C53' },
  { key: 'oon-us-tv', title: 'US TV Shows', type: 'tv', pages: 2, explore: '/browse/tmdb-genre-drama',
    path: '/discover/tv?language=en-US&sort_by=popularity.desc&with_original_language=en' },
  { key: 'oon-action-movies', title: 'Action Movies', type: 'movie', pages: 2, explore: null,
    path: '/discover/movie?language=en-US&sort_by=popularity.desc&with_genres=28' },
  { key: 'oon-binge-tv-dramas', title: 'Bingeworthy TV Dramas', type: 'tv', pages: 2, explore: null,
    path: '/discover/tv?language=en-US&sort_by=vote_count.desc&vote_count.gte=400&with_genres=18' },
  { key: 'oon-family-movies', title: 'Family Movies', type: 'movie', pages: 2, explore: '/browse/tmdb-genre-family',
    path: '/discover/movie?language=en-US&sort_by=popularity.desc&with_genres=10751' },
  { key: 'oon-squad-night', title: 'Squad Night In', type: 'movie', pages: 2, explore: '/browse/tmdb-genre-comedy',
    path: '/discover/movie?language=en-US&sort_by=popularity.desc&with_genres=35%7C12&with_original_language=en' },
  { key: 'oon-comedy-movies', title: 'Comedy Movies', type: 'movie', pages: 2, explore: '/browse/tmdb-genre-comedy',
    path: '/discover/movie?language=en-US&sort_by=popularity.desc&with_genres=35' },
  { key: 'oon-goofy-tv', title: 'Goofy TV Shows', type: 'tv', pages: 2, explore: null,
    path: '/discover/tv?language=en-US&sort_by=popularity.desc&with_genres=35%7C10764' },
  { key: 'oon-action-adventure', title: 'Action & Adventure Movies', type: 'movie', pages: 2, explore: '/browse/tmdb-genre-action',
    path: '/discover/movie?language=en-US&sort_by=popularity.desc&with_genres=28%7C12' },
  { key: 'oon-scifi-shows', title: 'Sci-Fi Shows', type: 'tv', pages: 2, explore: '/browse/tmdb-genre-scifi',
    path: '/discover/tv?language=en-US&sort_by=popularity.desc&with_genres=10765' },
];

const onlyOnNetflixCache = { data: null, at: 0, pending: null };

export const tmdbOnlyOnNetflix = async (req, res) => {
  if (!process.env.TMDB_ACCESS_TOKEN && !process.env.TMDB_API_KEY) {
    return res.json({ configured: false, rows: [] });
  }

  await ensureTmdbOverrides();
  const c = onlyOnNetflixCache;

  // Same serve-time maturity filter /tmdb/browse uses: the cache is shared by
  // every profile, so a Kids profile must not inherit the adult list it hit.
  const forViewer = (data) => {
    const rows = (data.rows || [])
      .map((row) => ({ ...row, items: currentCatalogueItems(applyTmdbOverrides(row.items)) }))
      .filter((row) => row.items.length > 0);
    const limitRank = maturityRank(requestLimit(req.profile));
    if (limitRank !== null && limitRank < MATURITY_ORDER.indexOf('18+')) {
      return {
        ...data,
        rows: rows
          .map((row) => ({ ...row, items: row.items.filter((it) => allowsTitle(req.profile, it)) }))
          .filter((row) => row.items.length > 0),
      };
    }
    return { ...data, rows };
  };

  if (c.data && Date.now() - c.at < CACHE_TTL_MS) return res.json(forViewer(c.data));

  if (!c.pending) {
    c.pending = (async () => {
      const lists = await Promise.all(
        ONLY_ON_NETFLIX_ROWS.map((r) => fetchPages(r.path, r.pages).catch(() => []))
      );
      const rows = ONLY_ON_NETFLIX_ROWS
        .map((r, i) => ({
          key: r.key,
          title: r.title,
          explore: r.explore || null,
          // The "TOP 10" corner badge sits on the first three cards of EVERY rail on
          // the reference. Those three ARE the rail's own chart — every query above
          // is sorted by popularity, so "position < 3" means "this is the 1st, 2nd or
          // 3rd most popular title in this category", which is exactly what the
          // reference's badge is claiming. Deriving it from the index keeps the badge
          // honest (it can never disagree with the order the rail is printed in) and
          // needs no second list to cross-reference.
          items: currentCatalogueItems(lists[i].map((it, rank) => {
            const card = normalize(it, r.type);
            return rank < 3 ? { ...card, inTop10: true } : card;
          })),
        }))
        .filter((r) => r.items.length > 0);
      return { configured: true, rows };
    })();
    c.pending
      .then((data) => { c.data = data; c.at = Date.now(); })
      .catch((err) => console.error('tmdbOnlyOnNetflix:', err.message))
      .finally(() => { c.pending = null; });
  }

  try {
    res.json(forViewer(await c.pending));
  } catch {
    res.status(502).json({ message: 'TMDB only-on-netflix unavailable' });
  }
};

// ==== /tmdb/explore/:type — "Explore All" grid (Netflix-style browse page) ====
// type: 'movie' | 'tv' | 'all'. Filters: genre (slug), year (1874 through current year),
// lang (ISO-639-1), sort (views|rating|newest|oldest|az|za), page (Load More).
// Every filter combination is fetched once (6 pages per type), merged, sorted and
// cached 30 minutes — pagination just slices the cached list.
const EXPLORE_GENRES = [
  { slug: 'action', name: 'Action & Adventure', movie: '28', tv: '10759' },
  { slug: 'comedy', name: 'Comedies', movie: '35', tv: '35' },
  { slug: 'drama', name: 'Dramas', movie: '18', tv: '18' },
  { slug: 'crime', name: 'Crime', movie: '80', tv: '80' },
  { slug: 'horror', name: 'Horror', movie: '27', tv: '27' },
  { slug: 'thriller', name: 'Thrillers & Mystery', movie: '53|9648', tv: '80|9648' },
  { slug: 'scifi', name: 'Sci-Fi & Fantasy', movie: '878|14', tv: '10765' },
  { slug: 'romance', name: 'Romance', movie: '10749', tv: '10766' },
  { slug: 'animation', name: 'Animation & Anime', movie: '16', tv: '16' },
  { slug: 'documentary', name: 'Documentaries', movie: '99', tv: '99' },
  { slug: 'family', name: 'Family', movie: '10751', tv: '10751' },
  { slug: 'kids', name: 'Kids & Reality', movie: null, tv: '10762|10764' },
  { slug: 'history', name: 'History', movie: '36', tv: null },
  { slug: 'war', name: 'War & Politics', movie: '10752', tv: '10768' },
  { slug: 'western', name: 'Westerns', movie: '37', tv: '37' },
  { slug: 'music', name: 'Music & Musicals', movie: '10402', tv: null },
];

const EXPLORE_LANGUAGES = {
  en: 'English', hi: 'Hindi', ko: 'Korean', es: 'Spanish', tr: 'Turkish',
  ar: 'Arabic', ur: 'Urdu', ja: 'Japanese', fr: 'French', zh: 'Chinese',
  de: 'German', it: 'Italian',
};

const EXPLORE_PAGES = 6; // 6 pages × 20 = up to 120 titles per type per combo
const EXPLORE_PAGE_SIZE = 30;

const EXPLORE_SORTS = {
  views: { movie: 'popularity.desc', tv: 'popularity.desc', cmp: (a, b) => (b.popularity || 0) - (a.popularity || 0) },
  rating: {
    movie: 'vote_average.desc', tv: 'vote_average.desc', extra: '300',
    cmp: (a, b) => (b.voteAverage || 0) - (a.voteAverage || 0) || (b.voteCount || 0) - (a.voteCount || 0),
  },
  newest: {
    movie: 'primary_release_date.desc', tv: 'first_air_date.desc', extra: '1',
    cmp: (a, b) => String(b.releaseDate || '').localeCompare(String(a.releaseDate || '')),
  },
  oldest: {
    movie: 'primary_release_date.asc', tv: 'first_air_date.asc', extra: '1',
    cmp: (a, b) => String(a.releaseDate || '').localeCompare(String(b.releaseDate || '')),
  },
  az: { movie: 'title.asc', tv: 'name.asc', cmp: (a, b) => String(a.title || '').localeCompare(String(b.title || '')) },
  za: { movie: 'title.desc', tv: 'name.desc', cmp: (a, b) => String(b.title || '').localeCompare(String(a.title || '')) },
};

// Year filter → TMDB discover params. Movies use primary_release_*, TV uses first_air_*.
const yearFilter = (type, year) => {
  if (!year || !/^\d{4}$/.test(year)) return {};
  return type === 'tv' ? { first_air_date_year: year } : { primary_release_year: year };
};

const exploreGenres = (type) => EXPLORE_GENRES
  .filter((g) => (type === 'all' ? (g.movie || g.tv) : g[type]))
  .map((g) => ({ slug: g.slug, name: g.name }));

const exploreCaches = new Map(); // key "type|genre|year|lang|sort" -> { items, at }
const explorePending = new Map(); // in-flight identical requests
const EXPLORE_CACHE_MAX = 60;

export const tmdbExplore = async (req, res) => {
  const type = ['movie', 'tv'].includes(req.params.type) ? req.params.type : 'all';
  await ensureTmdbOverrides();
  const sortKey = EXPLORE_SORTS[req.query.sort] ? String(req.query.sort) : 'views';
  const genre = String(req.query.genre || '');
  const requestedYear = String(req.query.year || '');
  const year = /^\d{4}$/.test(requestedYear)
    && Number(requestedYear) >= MIN_EXPLORE_YEAR
    && Number(requestedYear) <= MAX_USER_CATALOGUE_YEAR
    ? requestedYear
    : '';
  const lang = String(req.query.lang || '');
  const page = Math.max(1, Number(req.query.page) || 1);

  const meta = { type, sort: sortKey, genres: exploreGenres(type), languages: EXPLORE_LANGUAGES };

  const respond = (items) => {
    const currentItems = year
      ? (Array.isArray(items) ? items : [])
      : currentCatalogueItems(items);
    const start = (page - 1) * EXPLORE_PAGE_SIZE;
    res.json({
      configured: true,
      ...meta,
      items: applyTmdbOverrides(currentItems.slice(start, start + EXPLORE_PAGE_SIZE)),
      page,
      totalPages: Math.max(1, Math.ceil(currentItems.length / EXPLORE_PAGE_SIZE)),
      totalResults: currentItems.length,
    });
  };

  if (!process.env.TMDB_ACCESS_TOKEN && !process.env.TMDB_API_KEY) {
    return res.json({ configured: false, ...meta, items: [], page: 1, totalPages: 0, totalResults: 0 });
  }

  const key = `${type}|${genre}|${year}|${lang}|${sortKey}`;
  if (exploreCaches.has(key)) return respond(exploreCaches.get(key).items);

  if (!explorePending.has(key)) {
    explorePending.set(key, (async () => {
      const wanted = type === 'all' ? ['movie', 'tv'] : [type];
      const g = EXPLORE_GENRES.find((x) => x.slug === genre);
      // A genre that only exists on one side (e.g. History) must not pull the
      // other type unfiltered, so only query types that support the genre.
      const fetchTypes = g ? wanted.filter((t) => g[t]) : wanted;
      const spec = EXPLORE_SORTS[sortKey];
      const lists = await Promise.all(fetchTypes.map(async (t) => {
        const params = new URLSearchParams({
          language: 'en-US',
          include_adult: 'false',
          sort_by: spec[t],
          // NOTE: no `page` here — fetchPages appends &page=N per page
        });
        if (g && g[t]) params.set('with_genres', g[t]);
        if (lang) params.set('with_original_language', lang);
        if (spec.extra) params.set('vote_count.gte', spec.extra);
        const selectedYear = yearFilter(t, year);
        if (year) {
          Object.entries(selectedYear).forEach(([k, v]) => params.set(k, v));
        } else {
          new URLSearchParams(recentDateParams(t).slice(1)).forEach((value, key) => params.set(key, value));
        }
        return fetchPages(`/discover/${t}?${params.toString()}`, EXPLORE_PAGES);
      }));
      const seen = new Set();
      const merged = [];
      lists.forEach((list, i) => (list || []).forEach((item) => {
        const n = normalize(item, fetchTypes[i]);
        if (!year && !isCurrentCatalogueTitle(n)) return;
        if (seen.has(n._id)) return;
        seen.add(n._id);
        merged.push(n);
      }));
      merged.sort(spec.cmp);
      return merged;
    })());
    explorePending.get(key)
      .then((items) => {
        exploreCaches.set(key, { items, at: Date.now() });
        if (exploreCaches.size > EXPLORE_CACHE_MAX) {
          exploreCaches.delete(exploreCaches.keys().next().value);
        }
      })
      .catch((err) => console.error('tmdbExplore:', err.message))
      .finally(() => explorePending.delete(key));
  }

  try {
    respond(await explorePending.get(key));
  } catch {
    res.status(502).json({ message: 'TMDB explore unavailable' });
  }
};

// ==== /tmdb/genre-cards — themed artwork for the "Find Shows by Genre" cards ====
// Each tile shows a REAL backdrop from a popular title in that exact genre
// (TMDB discover), so the "Horror" card looks like horror and "Comedy" like
// comedy. Clicking a tile opens the Explore page pre-filtered to that category.
let genreCardsCache = { data: null, at: 0, pending: null };
const GENRE_CARDS_TTL_MS = 6 * 60 * 60 * 1000; // 6h — category artwork rarely changes

export const tmdbGenreCards = async (req, res) => {
  const meta = { configured: Boolean(process.env.TMDB_ACCESS_TOKEN || process.env.TMDB_API_KEY) };
  if (!meta.configured) return res.json({ ...meta, items: [] });

  const serve = (items) => res.json({ ...meta, items });
  if (genreCardsCache.data && Date.now() - genreCardsCache.at < GENRE_CARDS_TTL_MS) {
    return serve(genreCardsCache.data);
  }
  if (!genreCardsCache.pending) {
    genreCardsCache.pending = (async () => {
      const usedBackdrops = new Set(); // no two cards may show the same artwork
      const cards = [];
      for (const g of EXPLORE_GENRES) {
        // First popular title in the genre whose backdrop no other card uses yet.
        // vote_count.gte=100 keeps the artwork well-known (no obscure placeholders).
        const pick = async (type, ids) => {
          if (!ids) return '';
          const params = new URLSearchParams({
            language: 'en-US',
            include_adult: 'false',
            sort_by: 'popularity.desc',
            with_genres: ids,
            'vote_count.gte': '100',
          });
          new URLSearchParams(recentDateParams(type).slice(1)).forEach((value, key) => params.set(key, value));
          let fallback = null;
          let hit = null;
          for (const page of [2, 3, 1]) {
            if (hit) break;
            params.set('page', String(page));
            const data = await tmdbFetch(`/discover/${type}?${params.toString()}`).catch(() => null);
            const results = (data?.results || []).filter((r) => r.backdrop_path);
            fallback ||= results[0] || null;
            // Prefer later popular results to refresh the artwork set, while
            // avoiding backdrops already assigned to another genre card.
            hit = results.find((r) => !usedBackdrops.has(r.backdrop_path)) || null;
          }
          hit ||= fallback;
          if (!hit) return '';
          usedBackdrops.add(hit.backdrop_path);
          return `${IMAGE_BASE_URL}${hit.backdrop_path}`;
        };
        // Movies first (richer backdrops); fall back to TV genres that only exist there.
        const imageUrl = (await pick('movie', g.movie)) || (await pick('tv', g.tv));
        if (imageUrl) cards.push({ slug: g.slug, name: g.name, imageUrl });
      }
      return cards; // 16 categories — only genres with real art make the row
    })();
    genreCardsCache.pending
      .then((items) => { genreCardsCache.data = items; genreCardsCache.at = Date.now(); })
      .catch((err) => console.error('tmdbGenreCards:', err.message))
      .finally(() => { genreCardsCache.pending = null; });
  }
  try {
    serve(await genreCardsCache.pending);
  } catch {
    res.status(502).json({ message: 'Genre cards unavailable' });
  }
};