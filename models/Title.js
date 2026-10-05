import mongoose from 'mongoose';

const titleSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['movie', 'series'], required: true, index: true },
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true },
    // Optional explicit link to the live TMDB catalogue. Exact-title matching is
    // also supported, but these fields are the deterministic mapping for remakes,
    // alternate names and titles whose local name differs from TMDB.
    tmdbType: { type: String, enum: ['movie', 'tv'], required: false },
    tmdbId: { type: Number, required: false },
    description: { type: String, default: '' },
    posterUrl: { type: String, required: true },
    bannerUrl: { type: String, default: '' },
    // Transparent PNG/SVG wordmark shown instead of text in the hero + detail modal
    // (e.g. the "BLAST" art in the design reference).
    logoUrl: { type: String, default: '' },
    // Marketing line under the logo, e.g. "Watch in Tamil, Telugu, Hindi, Malayalam".
    tagline: { type: String, default: '' },
    trailerUrl: { type: String, default: '' },
    videoUrl: { type: String, default: '' }, // movie full video (Cloudinary or stream URL)
    videoSourceType: { type: String, enum: ['cloudinary', 'hls', 'mp4', 'embed', 'stremio'], default: 'mp4' },
    genres: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Genre' }],
    cast: [{ name: String, characterName: String, photoUrl: String }],
    director: { type: String, default: '' },
    releaseYear: { type: Number },
    durationMinutes: { type: Number, default: 0 }, // movie only
    ageRating: { type: String, default: '13+', enum: ['ALL', '7+', '13+', '16+', '18+'] },
    // Explicit "this is kids content" flag. A cartoon is very often certified 13+
    // or PG-13, so ageRating alone cannot express "safe for a Kids profile" —
    // this flag can, and a Kids profile sees (isKids OR ALL/7+). Admin-settable
    // on the title form.
    isKids: { type: Boolean, default: false, index: true },
    language: { type: String, default: 'English' },
    avgRating: { type: Number, default: 0, min: 0, max: 10 },
    ratingCount: { type: Number, default: 0 }, // user ratings counted (SRS §6.9)
    maturityScore: { type: Number, default: 0 },
    status: { type: String, enum: ['draft', 'published', 'unpublished'], default: 'draft', index: true },
    seriesStatus: { type: String, enum: ['ongoing', 'completed'], default: 'ongoing' }, // §6.3 ongoing vs completed series
    isTrending: { type: Boolean, default: false },
    isNewRelease: { type: Boolean, default: false },
    isFeatured: { type: Boolean, default: false }, // hero banner
    isTop10: { type: Boolean, default: false },
    viewCount: { type: Number, default: 0, index: true },
    watchCount: { type: Number, default: 0 },
    // Community-derived "match" (0 = no signal yet, the UI hides the badge). This
    // used to default to a hard-coded 96, which showed a fabricated match %.
    matchPercentage: { type: Number, default: 0, min: 0, max: 100 },
    tags: [{ type: String, lowercase: true }],
    // Languages advertised in the detail modal + player audio picker (real, admin-managed).
    audioLanguages: [{ type: String }],
    // Alternate audio + subtitle tracks. `url` is the real media file the player loads;
    // the player only offers a switch when a URL exists, so nothing is faked.
    audioTracks: [{ _id: false, language: String, label: String, url: String }],
    subtitleTracks: [{ _id: false, language: String, label: String, url: String, isDefault: Boolean }],
    // ---- Data governance: record ownership ----
    // Server-managed only. These are set from the authenticated admin's id in the
    // controllers and are deliberately NOT part of the editable-field whitelist, so
    // they cannot be spoofed by posting them from the admin form.
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// NOTE: no text index here on purpose — MongoDB treats a field named "language" as a
// text-search language override, which broke inserts for languages like Urdu/Korean.
// Search uses escaped regex matching (see titleDetailController.searchTitles) instead.
titleSchema.index({ status: 1, type: 1, createdAt: -1 });
titleSchema.index(
  { tmdbType: 1, tmdbId: 1 },
  {
    unique: true,
    partialFilterExpression: { tmdbType: { $exists: true }, tmdbId: { $exists: true } },
  },
);

export default mongoose.model('Title', titleSchema);
