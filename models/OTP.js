import mongoose from 'mongoose';

const otpSchema = new mongoose.Schema(
  {
    email: { type: String, lowercase: true, index: true },
    phone: { type: String, trim: true, index: true },
    codeHash: { type: String, required: true }, // bcrypt-hashed 6-digit OTP
    purpose: { type: String, enum: ['signup', 'forgot-password', 'phone-login'], required: true },
    attempts: { type: Number, default: 0 },
    consumed: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// TTL: auto-delete 15 min after expiry
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('OTP', otpSchema);
