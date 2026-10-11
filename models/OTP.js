import mongoose from 'mongoose';

const otpSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    email: { type: String, lowercase: true, index: true },
    phone: { type: String, trim: true, index: true },
    codeHash: { type: String, required: true }, // Hashed verification code or one-time profile-lock ticket.
    purpose: { type: String, enum: ['signup', 'forgot-password', 'phone-login', 'recovery-email', 'profile-lock', 'profile-email'], required: true },
    profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'Profile' },
    lockAction: { type: String, enum: ['set', 'delete'] },
    lockTicketHash: { type: String, default: '' },
    lockTicketUsed: { type: Boolean, default: false },
    attempts: { type: Number, default: 0 },
    consumed: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// TTL: auto-delete 15 min after expiry
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('OTP', otpSchema);
