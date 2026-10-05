import mongoose from 'mongoose';

const seasonSchema = new mongoose.Schema(
  {
    title: { type: mongoose.Schema.Types.ObjectId, ref: 'Title', required: true },
    seasonNumber: { type: Number, required: true },
    name: { type: String, default: '' },
    posterUrl: { type: String, default: '' },
    description: { type: String, default: '' },
    // Data governance: who created / last edited this season (server-managed).
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

seasonSchema.index({ title: 1, seasonNumber: 1 }, { unique: true });

export default mongoose.model('Season', seasonSchema);
