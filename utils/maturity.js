// One maturity scale for the whole site.
//
// The local catalogue already stores `ageRating` in this scale, but TMDB hands
// back raw certifications ("TV-Y", "PG-13", "R") from some endpoints and the
// app's own "18+"/"13+" fallback from the list endpoints. Before this module
// existed, a Kids profile had nothing to compare against, so filtering was
// impossible. Everything is normalised to THIS scale so one filter serves both.

export const MATURITY_ORDER = ['ALL', '7+', '13+', '16+', '18+'];

const RANK = new Map(MATURITY_ORDER.map((v, i) => [v, i]));

// Raw TMDB certifications -> our scale. `null` means "TMDB did not say", which is
// treated as unknown and therefore NOT assumed safe for a kids profile.
const CERT_MAP = {
  'TV-Y': 'ALL', 'TV-Y7': '7+', 'TV-Y7-FV': '7+', 'TV-G': 'ALL', 'TV-FY': '7+',
  'TV-PG': '7+', 'TV-PG-FV': '7+', 'TV-14': '13+', 'TV-MA': '18+',
  G: 'ALL', 'G-FV': 'ALL', PG: '7+', 'PG-FV': '7+', 'PG-13': '13+', R: '18+',
  'NC-17': '18+', NR: null, 'NR-16': '18+', UR: '18+', 'TV-NR': null,
};

export const maturityRank = (value) => {
  const v = String(value ?? '').trim();
  if (RANK.has(v)) return RANK.get(v);
  return null;
};

// Best-effort: a raw TMDB certification becomes a rank; anything already in our
// scale passes straight through; anything unrecognised returns null (unknown).
export const maturityRankOf = (value) => {
  const v = String(value ?? '').trim();
  if (RANK.has(v)) return RANK.get(v);
  if (Object.prototype.hasOwnProperty.call(CERT_MAP, v)) {
    const mapped = CERT_MAP[v];
    return mapped ? RANK.get(mapped) : null;
  }
  return null;
};

/**
 * The maturity ceiling for this request.
 * A Kids profile is pinned to 'ALL' no matter what maturityLimit says, so a
 * mis-stored limit can never widen a kids account.
 */
export const requestLimit = (profile) => {
  if (!profile) return '18+';
  // Kids are pinned to 7+, NOT 'ALL': pinning to 'ALL' would hide every 7+ title
  // too, which is most of the kid-friendly catalogue. A mis-stored maturityLimit
  // on a kids profile can never widen it past this.
  if (profile.isKidsProfile) return '7+';
  const rank = maturityRank(profile.maturityLimit);
  return rank === null ? '18+' : profile.maturityLimit;
};

export const isKidsRequest = (profile) => Boolean(profile?.isKidsProfile);

/**
 * Mongo filter fragment restricting a Title query to what this request may see.
 * A kids profile gets titles that are either explicitly flagged `isKids` (so an
 * admin can mark a cartoon that happens to be rated 13+) or carry a low
 * certificate. Adult profiles just honour their own maturityLimit.
 */
export const maturityFilter = (profile) => {
  const limit = requestLimit(profile);
  const limitRank = maturityRank(limit);
  if (limitRank === null || limitRank >= MATURITY_ORDER.indexOf('18+')) return null;
  const allowed = MATURITY_ORDER.slice(0, limitRank + 1);
  if (limitRank <= MATURITY_ORDER.indexOf('7+')) {
    return { $or: [{ isKids: true }, { ageRating: { $in: allowed } }] };
  }
  return { ageRating: { $in: allowed } };
};

/** Merge a maturity fragment into an existing query filter without clobbering it. */
export const withMaturity = (filter, profile) => {
  const frag = maturityFilter(profile);
  if (!frag) return filter;
  if (frag.$or && filter.$or) return { $and: [filter, frag] };
  if (frag.$or) return { ...filter, ...frag };
  if (filter.$or) return { $and: [filter, frag] };
  return { ...filter, ageRating: frag.ageRating };
};

/** Runtime check for a single document (used to gate detail + watch endpoints). */
export const allowsTitle = (profile, title) => {
  const limitRank = maturityRank(requestLimit(profile));
  if (limitRank === null || limitRank >= MATURITY_ORDER.indexOf('18+')) return true;
  if (limitRank <= MATURITY_ORDER.indexOf('7+') && title?.isKids) return true;
  const titleRank = maturityRankOf(title?.ageRating);
  // Unknown certificate: block for kids, allow for a partially-restricted adult.
  if (titleRank === null) return limitRank > MATURITY_ORDER.indexOf('7+');
  return titleRank <= limitRank;
};

export const maturityMessage = (profile) => (isKidsRequest(profile)
  ? 'This title is not available on a Kids profile.'
  : 'This title is above your profile\'s maturity limit.');

export const maturityStatus = (profile) => (isKidsRequest(profile) ? 403 : 403);
