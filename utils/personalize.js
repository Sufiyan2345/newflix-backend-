// Per-viewer home feed variety.
//
// The home feed used to be one hard-coded set of rows sorted by viewCount, so
// every signed-in user saw byte-identical rails. This module makes the feed
// viewer-specific WITHOUT making it feel random on every reload:
//
//   * the order is a pure function of (viewer seed, title id) — a given profile
//     always gets the same feed, so reloading does not reshuffle the page;
//   * a different profile gets a different order AND a different slice of the
//     candidate pool, so the titles on screen actually differ between users.
//
// It is a shuffle, not an arbitrary sort: a popularity weight is folded in, so
// genuinely good titles still surface near the front and the tail is the part
// that rotates between viewers.

/** FNV-1a, 32-bit. Small, fast, and stable across Node versions. */
const fnv1a = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
};

/** Deterministic float in [0, 1) for a (seed, id) pair. */
export const unit = (seed, id) => fnv1a(`${seed}::${id}`) / 0x100000000;

/**
 * The seed for this request. Profile first (a shared account still gives each
 * profile its own feed), then user, then a per-process fallback for anonymous
 * visitors so they are not all pinned to one identical rail.
 */
export const feedSeed = (req) => {
  if (req?.profileId) return `p:${req.profileId}`;
  if (req?.user?._id) return `u:${req.user._id}`;
  return `a:${fnv1a(`${req?.ip || ''}:${Date.now()}`)}`;
};

/**
 * Order `items` for one viewer.
 *
 * @param {Array}  items     candidate pool (already filtered by maturity)
 * @param {object} opts
 * @param {string} opts.seed       from feedSeed()
 * @param {number} opts.limit      how many to return
 * @param {number} opts.keepTop    how many leading items keep their original
 *                                 (ranked) order — anchors the rail so it is
 *                                 never all-obscure, then the rest rotates
 * @param {string} opts.salt       separate streams for rows built from the same pool
 */
export const personalize = (items, { seed, limit = 20, keepTop = 6, salt = '' } = {}) => {
  const list = (items || []).filter(Boolean);
  if (!list.length) return [];

  const scored = list.map((item, index) => {
    const id = String(item._id ?? item.id ?? index);
    const r = unit(`${seed}|${salt}`, id);
    // Popularity weight: log so a 10k-view title is favoured over a 10-view one
    // but never fully decides the order. Combined with the per-viewer random
    // term, this yields "good titles, in a personal order".
    const weight = Math.log10(1 + Number(item.viewCount || 0));
    return { item, index, r, score: r * 0.82 - weight * 0.18 };
  });

  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));

  const anchors = scored.slice(0, Math.max(0, Math.min(keepTop, scored.length)));
  const tail = scored.slice(anchors.length);

  // A per-viewer rotation offset means two viewers looking at the SAME pool
  // still see different titles, not just a different order of the same 20.
  const offset = tail.length
    ? fnv1a(`${seed}|${salt}|offset`) % tail.length
    : 0;
  const rotated = tail.slice(offset).concat(tail.slice(0, offset));

  // Unwrap: the sort worked on { item, score } wrappers, but callers (and the
  // response payload) need the original documents.
  return anchors.concat(rotated).slice(0, limit).map((entry) => entry.item);
};

/**
 * Filter an already-built list of TMDB/override rows down to what this viewer
 * may see, dropping rows that end up empty.
 */
export const filterRowsForMaturity = (rows, profile, allows) => (rows || [])
  .map((row) => ({
    ...row,
    items: (row.items || []).filter((item) => allows(profile, item)),
    ...(row.top10 ? { top10: row.top10.filter((item) => allows(profile, item)) } : {}),
  }))
  .filter((row) => (row.items?.length || 0) > 0 || (row.top10?.length || 0) > 0);
