import mongoose from 'mongoose';

const watchHistorySchema = new mongoose.Schema(
  {
    profile: { type: mongoose.Schema.Types.ObjectId, ref: 'Profile', required: true },
    title: { type: mongoose.Schema.Types.ObjectId, ref: 'Title', required: true },
    episode: { type: mongoose.Schema.Types.ObjectId, ref: 'Episode', default: null },
    progressSeconds: { type: Number, default: 0 },
    durationSeconds: { type: Number, default: 0 },
    completed: { type: Boolean, default: false },
    lastWatchedAt: { type: Date, default: Date.now },
    device: { type: String, default: 'unknown', index: true },  // Desktop | Mobile | Tablet (SRS §6.11)
    browser: { type: String, default: 'unknown', index: true }, // Chrome | Safari | Firefox | Edge | Other
  },
  { timestamps: true }
);

watchHistorySchema.index({ profile: 1, title: 1 }, { unique: true });
watchHistorySchema.index({ profile: 1, lastWatchedAt: -1 });

export default mongoose.model('WatchHistory', watchHistorySchema);
