import mongoose from 'mongoose';

// Admin edits for the LIVE TMDB catalogue (movies / series / dramas streamed from
// the TMDB API). TMDB itself is read-only, so anything the admin changes — poster,
// thumbnail, title, description… — is stored here and merged over every normalized
// TMDB response (home rails, search, browse, explore, detail modal) at serve time.
const tmdbOverrideSchema = new mongoose.Schema(
  {
    tmdbId: { type: Number, required: true },
    mediaType: { type: String, enum: ['movie', 'tv'], required: true },
    title: { type: String, default: '', trim: true },
    description: { type: String, default: '' },
    posterUrl: { type: String, default: '' }, // portrait artwork (grid/search cards)
    bannerUrl: { type: String, default: '' }, // landscape thumbnail (rails/hover cards)
    logoUrl: { type: String, default: '' }, // wordmark (hero / detail modal)
    tagline: { type: String, default: '' },
    trailerUrl: { type: String, default: '' }, // embed URL override for the modal
    // Optional local catalogue series that owns the real per-episode media files.
    // When set, TMDB supplies metadata/artwork while this Mongo title supplies
    // stable history IDs and the site's configured playable sources.
    localTitleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Title', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// One edit per TMDB title
tmdbOverrideSchema.index({ tmdbId: 1, mediaType: 1 }, { unique: true });

export default mongoose.model('TmdbOverride', tmdbOverrideSchema);