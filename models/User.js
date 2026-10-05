import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Invalid email format'],
    },
    phone: { type: String, trim: true, unique: true, sparse: true, index: true },
    password: { type: String, required: true, minlength: 8, select: false },
    role: {
      type: String,
      enum: ['user', 'content-manager', 'super-admin'],
      default: 'user',
    },
    isEmailVerified: { type: Boolean, default: false },
    // Passwordless member (the "Create Your Account" link in the sign-up email):
    // the account exists without a password the user ever typed — the mailed link
    // signs them in, exactly like netflix.com's "No password needed" flow.
    passwordless: { type: Boolean, default: false },

    // Mid-signup state — a user who left before paying resumes via the
    // "Finish Sign-Up" page at exactly this step/plan (Netflix behaviour).
    signupStep: { type: String, default: '', enum: ['', 'plan-intro', 'plan', 'upgrade', 'pay', 'card'] },
    signupPlan: { type: String, default: '', enum: ['', 'mobile', 'basic', 'standard', 'premium'] },
    membershipActive: { type: Boolean, default: false },
    isOnline: { type: Boolean, default: false },
    // Post-payment personalization (Netflix "simpleSetup"): the 6 screens walked
    // after "Start Membership" — devices → who's watching → maturity → genres →
    // languages → pick 3 titles. onboardingStep tracks the current screen
    // (0 = paid, setup not started yet) so a member who leaves mid-setup resumes
    // exactly where they left, before /browse opens.
    onboardingDone: { type: Boolean, default: false },
    onboardingStep: { type: Number, default: 0, min: 0, max: 8 },
    phoneVerified: { type: Boolean, default: false },
    onboarding: {
      recoveryPhone: { type: String, default: '' },
      devices: { type: [String], default: [] },
      profiles: { type: [String], default: [] },
      maturity: { type: String, default: '' },
      genres: { type: [String], default: [] },
      languages: { type: [String], default: [] },
      picks: { type: [String], default: [] },
    },
    isSuspended: { type: Boolean, default: false },
    suspendedReason: { type: String, default: '' },
    lastLoginAt: { type: Date },
    loginAttempts: { type: Number, default: 0, select: false },
    lockUntil: { type: Date, default: null, select: false },
  },
  { timestamps: true }
);

// email unique index is already declared inline via `unique: true` above

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.isLocked = function () {
  return this.lockUntil && this.lockUntil > new Date();
};

export default mongoose.model('User', userSchema);
