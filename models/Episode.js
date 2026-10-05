import mongoose from 'mongoose';

const episodeSchema = new mongoose.Schema(
  {
    season: { type: mongoose.Schema.Types.ObjectId, ref: 'Season', required: true },
    series: { type: mongoose.Schema.Types.ObjectId, ref: 'Title', required: true },
    episodeNumber: { type: Number, required: true },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    thumbnailUrl: { type: String, default: '' },
    videoUrl: { type: String, default: '' },
    videoSourceType: { type: String, enum: ['cloudinary', 'hls', 'mp4', 'embed', 'stremio'], default: 'mp4' },
    durationMinutes: { type: Number, default: 0 },
    // Per-episode alternate audio + subtitle tracks (admin-managed, real files only).
    audioTracks: [{ _id: false, language: String, label: String, url: String }],
    subtitleTracks: [{ _id: false, language: String, label: String, url: String, isDefault: Boolean }],
    releaseDate: { type: Date },
    // Skip markers, in seconds from the start of the episode (SRS §10 "Skip intro /
    // Skip recap"; Admin 12-13 "Intro markers / Recap markers"). 0 means "not set",
    // and the player then falls back to its default skip window.
    recapStart: { type: Number, default: 0 },
    recapEnd: { type: Number, default: 0 },
    introStart: { type: Number, default: 0 },
    introEnd: { type: Number, default: 0 },
    status: { type: String, enum: ['draft', 'published', 'unpublished'], default: 'published' },
    // Data governance: who created / last edited this episode (server-managed).
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

episodeSchema.index({ season: 1, episodeNumber: 1 }, { unique: true });

export default mongoose.model('Episode', episodeSchema);
