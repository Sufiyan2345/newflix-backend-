import mongoose from 'mongoose';

const AVATARS = [
  'https://ui-avatars.com/api/?background=E50914&color=fff&bold=true&name=',
];

const profileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    avatarUrl: { type: String, default: '' },
    avatarColor: {
      type: String,
      default: () => ['#E50914', '#E87C03', '#2E86AB', '#7D4CBE', '#1F9D55'][Math.floor(Math.random() * 5)],
    },
    isKidsProfile: { type: Boolean, default: false },
    maturityLimit: { type: String, default: '18+', enum: ['ALL', '7+', '13+', '16+', '18+'] },
    language: { type: String, default: 'en' },
    autoplayNext: { type: Boolean, default: true },
  },
  { timestamps: true }
);

profileSchema.index({ user: 1, name: 1 }, { unique: true });

export default mongoose.model('Profile', profileSchema);
export { AVATARS };
