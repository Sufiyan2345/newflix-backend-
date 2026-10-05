import mongoose from 'mongoose';

// TMDB catalogue titles are not Mongo Title documents, so their progress needs a
// separate stable identity. This keeps local WatchHistory ObjectId references valid
// while still giving every profile per-series/per-episode resume behaviour.
const tmdbTitleSnapshotSchema = new mongoose.Schema(
  {
    title: { type: String, default: '' },
    description: { type: String, default: '' },
    posterUrl: { type: String, default: '' },
    bannerUrl: { type: String, default: '' },
    logoUrl: { type: String, default: '' },
    tagline: { type: String, default: '' },
    releaseYear: { type: Number, default: 0 },
    ageRating: { type: String, default: '13+' },
  },
  { _id: false }
);

const tmdbEpisodeSnapshotSchema = new mongoose.Schema(
  {
    tmdbEpisodeId: { type: Number, default: 0 },
    seasonNumber: { type: Number, required: true },
    episodeNumber: { type: Number, required: true },
    title: { type: String, default: '' },
    description: { type: String, default: '' },
    thumbnailUrl: { type: String, default: '' },
    durationMinutes: { type: Number, default: 0 },
  },
  { _id: false }
);

const tmdbWatchHistorySchema = new mongoose.Schema(
  {
    profile: { type: mongoose.Schema.Types.ObjectId, ref: 'Profile', required: true },
    tmdbId: { type: Number, required: true, min: 1 },
    // Movies are a single feature with no episode, but this schema requires both
    // season/episode numbers, so they are stored as 1/1 and distinguished by this.
    mediaType: { type: String, enum: ['movie', 'tv'], default: 'tv' },
    seasonNumber: { type: Number, required: true, min: 1 },
    episodeNumber: { type: Number, required: true, min: 1 },
    titleSnapshot: { type: tmdbTitleSnapshotSchema, default: () => ({}) },
    episodeSnapshot: { type: tmdbEpisodeSnapshotSchema, required: true },
    progressSeconds: { type: Number, default: 0 },
    durationSeconds: { type: Number, default: 0 },
    completed: { type: Boolean, default: false },
    lastWatchedAt: { type: Date, default: Date.now },
    device: { type: String, default: 'unknown', index: true },
    browser: { type: String, default: 'unknown', index: true },
  },
  { timestamps: true }
);

tmdbWatchHistorySchema.index({ profile: 1, tmdbId: 1 }, { unique: true });
tmdbWatchHistorySchema.index({ profile: 1, lastWatchedAt: -1 });

export default mongoose.model('TmdbWatchHistory', tmdbWatchHistorySchema);
