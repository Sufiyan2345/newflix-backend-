import mongoose from 'mongoose';

// User ratings per profile — powers the star rating on the title page and the
// admin moderation list (SRS §4.5 IMDB-style rating + §6.9 moderation).
const ratingSchema = new mongoose.Schema(
  {
    title: { type: mongoose.Schema.Types.ObjectId, ref: 'Title', required: true },
    profile: { type: mongoose.Schema.Types.ObjectId, ref: 'Profile', required: true },
    rating: { type: Number, required: true, min: 1, max: 10 },
  },
  { timestamps: true }
);

ratingSchema.index({ title: 1, profile: 1 }, { unique: true });

export default mongoose.model('Rating', ratingSchema);