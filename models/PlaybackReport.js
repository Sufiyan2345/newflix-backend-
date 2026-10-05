import mongoose from 'mongoose';

// "Report a problem" filed straight from the player (SRS §10 control + §23 "Report
// content/playback problem"). Every row is a support ticket for the admin support
// module: what went wrong, at which second of which episode, and on what device.
const playbackReportSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    profile: { type: mongoose.Schema.Types.ObjectId, ref: 'Profile', default: null },
    title: { type: mongoose.Schema.Types.ObjectId, ref: 'Title', required: true },
    episode: { type: mongoose.Schema.Types.ObjectId, ref: 'Episode', default: null },
    category: {
      type: String,
      enum: ['playback', 'video', 'audio', 'subtitles', 'buffering', 'other'],
      default: 'playback',
    },
    message: { type: String, required: true, trim: true, maxlength: 1000 },
    // Exact point of playback the viewer was on when they hit "Report a problem".
    progressSeconds: { type: Number, default: 0 },
    durationSeconds: { type: Number, default: 0 },
    device: { type: String, default: 'unknown' },
    browser: { type: String, default: 'unknown' },
    status: { type: String, enum: ['open', 'reviewing', 'resolved'], default: 'open' },
  },
  { timestamps: true }
);

playbackReportSchema.index({ status: 1, createdAt: -1 });
playbackReportSchema.index({ title: 1, createdAt: -1 });

export default mongoose.model('PlaybackReport', playbackReportSchema);