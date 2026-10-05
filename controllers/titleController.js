import Title from '../models/Title.js';
import Genre from '../models/Genre.js';
import Season from '../models/Season.js';
import Episode from '../models/Episode.js';
import SiteSettings from '../models/SiteSettings.js';
import { withMaturity } from '../utils/maturity.js';
import { feedSeed, personalize } from '../utils/personalize.js';

// How many candidates each rail pulls before the viewer-specific shuffle picks
// the ones that actually ship. A small pool would make the feed identical for
// everyone; a huge one would be a slow query for no visible benefit.
const POOL = 60;
const ROW = 20;

// Real per-title season/episode counts, so browse cards can show the same
// "1 Seasons" / "3 Seasons" chip the design reference uses — computed in two
// aggregate queries for the whole feed instead of one query per card.
const annotateCounts = async (rows) => {
  const items = rows.flatMap((r) => r.items);
  const ids = items.map((i) => i._id).filter(Boolean);
  if (!ids.length) return rows;
  const [seasonAgg, epAgg] = await Promise.all([
    Season.aggregate([{ $match: { title: { $in: ids } } }, { $group: { _id: '$title', n: { $sum: 1 } } }]),
    Episode.aggregate([
      { $match: { series: { $in: ids }, status: 'published' } },
      { $group: { _id: '$series', n: { $sum: 1 } } },
    ]),
  ]);
  const seasons = new Map(seasonAgg.map((s) => [String(s._id), s.n]));
  const episodes = new Map(epAgg.map((s) => [String(s._id), s.n]));
  for (const row of rows) {
    row.items = row.items.map((doc) => {
      const plain = typeof doc.toObject === 'function' ? doc.toObject() : doc;
      const key = String(plain._id);
      return { ...plain, seasonsCount: seasons.get(key) || 0, episodesCount: episodes.get(key) || 0 };
    });
  }
  return rows;
};

const PAGE_SIZE = 20;
const SORTS = {
  newest: { createdAt: -1 }, oldest: { createdAt: 1 },
  az: { title: 1 }, za: { title: -1 },
  rating: { avgRating: -1 }, views: { viewCount: -1 }, year: { releaseYear: -1 },
};

const buildFilter = (q, profile) => {
  const currentYear = new Date().getUTCFullYear();
  const filter = withMaturity({
    status: 'published',
    releaseYear: { $gte: 2023, $lte: currentYear },
  }, profile);
  if (q.type) filter.type = q.type;
  if (q.genre) filter.genres = q.genre;
  const requestedYear = Number(q.year);
  if (Number.isInteger(requestedYear) && requestedYear >= 2023 && requestedYear <= currentYear) {
    filter.releaseYear = requestedYear;
  }
  if (q.language) filter.language = q.language;
  if (q.ageRating) filter.ageRating = q.ageRating;
  return filter;
};

// @route GET /api/titles — list with filters/pagination
export const listTitles = async (req, res) => {
  try {
    const { page = 1, limit = PAGE_SIZE, sort = 'newest' } = req.query;
    const filter = buildFilter(req.query, req.profile);
    const skip = (Number(page) - 1) * Number(limit);
    const [items, total] = await Promise.all([
      Title.find(filter).sort(SORTS[sort] || SORTS.newest).skip(skip).limit(Number(limit)).populate('genres'),
      Title.countDocuments(filter),
    ]);
    res.json({ items, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    console.error('listTitles:', err);
    res.status(500).json({ message: 'Failed to list titles' });
  }
};

// @route GET /api/titles/home — all home rows in one call
//
// Two things happen here that the endpoint did not do before:
//
//  1. MATURITY — a Kids profile only ever receives kid-safe titles. The filter is
//     applied in the query (not after), so a disallowed title cannot leak into
//     the payload at all.
//  2. VIEWER-SPECIFIC RAILS — every rail is drawn from a wide candidate pool and
//     then picked for THIS profile via a stable per-viewer shuffle, so two users
//     on the same catalogue see different titles instead of one fixed feed.
export const homeFeed = async (req, res) => {
  try {
    const profile = req.profile || null;
    const seed = feedSeed(req);
    const published = withMaturity({
      status: 'published',
      releaseYear: { $gte: 2023, $lte: new Date().getUTCFullYear() },
    }, profile);
    const [featured, trending, newReleases, top10, movies, series, genres, settings] = await Promise.all([
      // Every featured title is a CANDIDATE for the home billboard: the user site
      // picks 5 of them at random on each visit/login (frontend/hooks/useHeroSlides),
      // so the hero is never the same fixed set. Capped at 30 to keep the feed light.
      Title.find({ ...published, isFeatured: true }).sort({ updatedAt: -1 }).limit(30).populate('genres'),
      Title.find({ ...published, isTrending: true }).sort({ viewCount: -1 }).limit(POOL).populate('genres'),
      Title.find({ ...published, isNewRelease: true }).sort({ createdAt: -1 }).limit(POOL).populate('genres'),
      Title.find({ ...published, isTop10: true }).sort({ viewCount: -1 }).limit(POOL).populate('genres'),
      Title.find({ ...published, type: 'movie' }).sort({ viewCount: -1 }).limit(POOL).populate('genres'),
      Title.find({ ...published, type: 'series' }).sort({ viewCount: -1 }).limit(POOL).populate('genres'),
      Genre.find({ isActive: true }).sort({ order: 1 }),
      SiteSettings.findOne().select('customRows'),
    ]);

    const genreRows = await Promise.all(
      genres.map(async (g) => {
        const items = await Title.find({ ...published, genres: g._id }).sort({ viewCount: -1 }).limit(POOL).populate('genres');
        const seen = new Set();
        return {
          genre: { id: g._id, name: g.name, slug: g.slug },
          items: items.filter((item) => {
            if (!item || !item._id || seen.has(String(item._id))) return false;
            seen.add(String(item._id));
            return true;
          }),
        };
      })
    );

    // §6.5 — admin-created custom homepage rows with manually pinned titles (admin's order preserved)
    // Pinned rows are NOT personalised: the admin hand-picked these titles and
    // that order is deliberate. They are still maturity-filtered, because a Kids
    // profile must not receive an 18+ title just because an admin pinned it.
    const customRows = [];
    for (const r of settings?.customRows || []) {
      if (!r.titleIds?.length || !r.title) continue;
      const found = await Title.find({
        ...withMaturity({
          _id: { $in: r.titleIds },
          releaseYear: { $gte: 2023, $lte: new Date().getUTCFullYear() },
        }, profile),
        status: 'published',
      }).populate('genres');
      const byId = new Map(found.map((t) => [String(t._id), t]));
      const items = r.titleIds.map((id) => byId.get(String(id))).filter(Boolean);
      if (items.length) customRows.push({ key: `custom-${r._id}`, title: r.title, items });
    }

    const rowSeen = new Set();
    const uniqueRowItems = (items = []) => items.filter((item) => {
      if (!item || !item._id) return false;
      const key = String(item._id);
      if (rowSeen.has(key)) return false;
      rowSeen.add(key);
      return true;
    });

    // §6.5 — admin-created custom homepage rows with manually pinned titles (admin's order preserved).
    // Pinned rows are NOT personalised: the admin hand-picked these titles and
    // that order is deliberate. They are still maturity-filtered, because a Kids
    // profile must not receive an 18+ title just because an admin pinned it.
    const dedupeLocal = (items = []) => {
      const seen = new Set();
      return items.filter((item) => {
        if (!item || !item._id) return false;
        const key = String(item._id);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };

    // Personalise FIRST, dedupe SECOND. The order matters: the cross-row dedupe
    // consumes items in rail order, so personalising first means the "already
    // used" title varies per viewer instead of every viewer burning the same
    // top-of-rail titles across rows.
    const forViewer = (items, salt, limit = ROW) => personalize(items, { seed, salt, limit });
    const top10Items = forViewer(top10, 'top10', 10);

    const baseRows = [
      { key: 'trending', title: 'Trending Now', items: uniqueRowItems(forViewer(trending, 'trending')) },
      { key: 'top10', title: 'Top 10 Today', items: uniqueRowItems(top10Items), top10: true },
      { key: 'new', title: 'New Releases', items: uniqueRowItems(forViewer(newReleases, 'new')) },
      ...customRows.map((row) => ({ ...row, items: dedupeLocal(row.items) })),
      { key: 'movies', title: 'Popular Movies', items: uniqueRowItems(forViewer(movies, 'movies')) },
      { key: 'series', title: 'Popular Dramas & Series', items: uniqueRowItems(forViewer(series, 'series')) },
    ];

    const genreSectionRows = genreRows
      .filter((r) => r.items.length > 0)
      // Salted by the genre slug so each genre rail is an independent stream —
      // otherwise every rail would share one order and look copy-pasted.
      .map((r) => ({ key: r.genre.slug, title: r.genre.name, genreId: r.genre.id, items: uniqueRowItems(forViewer(r.items, `genre:${r.genre.slug}`)) }))
      .filter((row) => row.items.length > 0);

    // Attach seasonsCount / episodesCount (real DB counts) used by the card chips.
    const rows = await annotateCounts([...baseRows, ...genreSectionRows]);

    // The billboard pool is personalised too, and ordered for this viewer so the
    // frontend's 5-of-N pick differs between profiles. isKids is passed through
    // so the card can badge kid content.
    const heroPool = featured.map((t) => (typeof t.toObject === 'function' ? t.toObject() : t));

    res.json({
      featured: heroPool,
      rows,
      // Lets the UI say "Kids" and confirm which feed variant was served.
      viewer: { isKids: Boolean(profile?.isKidsProfile), seed },
    });
  } catch (err) {
    console.error('homeFeed:', err);
    res.status(500).json({ message: 'Failed to load home feed' });
  }
};
