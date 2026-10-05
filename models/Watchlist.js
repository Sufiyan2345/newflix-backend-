import mongoose from 'mongoose';

const watchlistSchema = new mongoose.Schema(
  {
    profile: { type: mongoose.Schema.Types.ObjectId, ref: 'Profile', required: true },
    title: { type: mongoose.Schema.Types.ObjectId, ref: 'Title', required: true },
    addedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

watchlistSchema.index({ profile: 1, title: 1 }, { unique: true });

export default mongoose.model('Watchlist', watchlistSchema);
