import User from '../models/User.js';
import bcrypt from 'bcryptjs';
import Profile from '../models/Profile.js';
import Watchlist from '../models/Watchlist.js';
import WatchHistory from '../models/WatchHistory.js';
import Title from '../models/Title.js';
import Notification from '../models/Notification.js';
import OTP from '../models/OTP.js';
import crypto from 'crypto';
import { normalizePhone, sendOTPSMS } from '../config/sms.js';
import { sendVerificationCodeEmail } from '../config/mailer.js';
import { generateProfileUnlockToken } from '../middleware/tokens.js';

const MAX_PROFILES = 5;

// ---------- ONBOARDING PHONE (SMS OTP) VERIFICATION ----------
// Real SMS OTP for the recovery phone entered on "Welcome to Netflix!".
// Uses the same SMS provider and OTP model as phone login.
const hashOtpCode = (code) => crypto.createHash('sha256').update(code).digest('hex');
const profileLockTicketExpiry = () => new Date(Date.now() + 10 * 60 * 1000);

const issueProfileLockTicket = async (userId, profileId, action, email) => {
  const ticket = crypto.randomBytes(32).toString('hex');
  await OTP.create({
    user: userId,
    email,
    codeHash: hashOtpCode(ticket),
    purpose: 'profile-lock',
    profileId,
    lockAction: action,
    lockTicketHash: hashOtpCode(ticket),
    consumed: true,
    expiresAt: profileLockTicketExpiry(),
  });
  return ticket;
};

// @route POST /api/user/phone/send-otp { phone }  (protected)
export const sendPhoneVerifyOTP = async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ message: 'Enter a valid mobile number, including country code.' });

    // Blocked if another account already owns this number
    const owner = await User.findOne({ phone, _id: { $ne: req.user._id } });
    if (owner) return res.status(409).json({ message: 'That mobile number is already linked to another account.' });

    const code = String(crypto.randomInt(100000, 999999));
    const otpDoc = await OTP.create({ phone, codeHash: hashOtpCode(code), purpose: 'phone-login', expiresAt: new Date(Date.now() + 10 * 60 * 1000) });
    try {
      await sendOTPSMS(phone, code);
    } catch (err) {
      otpDoc.consumed = true;
      await otpDoc.save();
      throw err;
    }
    res.json({ message: `Verification code sent to ${phone}. It expires in 10 minutes.` });
  } catch (err) {
    console.error('sendPhoneVerifyOTP error:', err);
    res.status(503).json({ message: 'Could not send the SMS OTP. Check SMS provider settings and try again.' });
  }
};

// @route POST /api/user/phone/verify-otp { phone, otp }
export const verifyPhoneVerifyOTP = async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const otp = String(req.body?.otp || '');
    if (!phone || !/^\d{6}$/.test(otp)) return res.status(400).json({ message: 'Mobile number and 6-digit code are required.' });

    const otpDoc = await OTP.findOne({ phone, purpose: 'phone-login', consumed: false, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
    if (!otpDoc) return res.status(400).json({ message: 'Code expired or not found. Request a new one.' });
    otpDoc.attempts += 1;
    await otpDoc.save();
    if (otpDoc.attempts > 5) return res.status(429).json({ message: 'Too many wrong attempts. Request a new code.' });
    if (otpDoc.codeHash !== hashOtpCode(otp)) return res.status(400).json({ message: 'Invalid code. Please check and try again.' });

    otpDoc.consumed = true;
    await otpDoc.save();

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    user.phone = phone;
    user.phoneVerified = true;
    user.onboarding = user.onboarding || {};
    user.onboarding.recoveryPhone = phone;
    user.markModified('onboarding');
    await user.save();

    res.json({ message: 'Phone number verified.', phoneVerified: true });
  } catch (err) {
    console.error('verifyPhoneVerifyOTP error:', err);
    res.status(500).json({ message: 'Phone verification failed.' });
  }
};

// ---------- ONBOARDING EMAIL RECOVERY OTP ----------
// Verify the signed-in user's existing account email as a recovery channel.
export const sendEmailRecoveryOTP = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('email isEmailVerified');
    if (!user?.email || !user.isEmailVerified) {
      return res.status(400).json({ message: 'Verify your account email before using it for recovery.' });
    }

    const code = String(crypto.randomInt(100000, 999999));
    const email = user.email.toLowerCase();
    const otpDoc = await OTP.create({
      email,
      codeHash: hashOtpCode(code),
      purpose: 'recovery-email',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    try {
      await sendVerificationCodeEmail(
        email,
        code,
        'Your password recovery verification code',
      );
    } catch (err) {
      otpDoc.consumed = true;
      await otpDoc.save();
      throw err;
    }

    res.json({ message: `Verification code sent to ${email}. It expires in 10 minutes.` });
  } catch (err) {
    console.error('sendEmailRecoveryOTP error:', err);
    res.status(503).json({ message: 'Could not send the email verification code. Check email settings and try again.' });
  }
};

export const verifyEmailRecoveryOTP = async (req, res) => {
  try {
    const otp = String(req.body?.otp || '');
    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ message: 'Enter the 6-digit code sent to your email.' });
    }

    const user = await User.findById(req.user._id).select('email isEmailVerified onboarding');
    if (!user?.email || !user.isEmailVerified) {
      return res.status(400).json({ message: 'Verify your account email before using it for recovery.' });
    }

    const email = user.email.toLowerCase();
    const otpDoc = await OTP.findOne({
      email,
      purpose: 'recovery-email',
      consumed: false,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });
    if (!otpDoc) return res.status(400).json({ message: 'Code expired or not found. Request a new code.' });

    otpDoc.attempts += 1;
    await otpDoc.save();
    if (otpDoc.attempts > 5) return res.status(429).json({ message: 'Too many incorrect attempts. Request a new code.' });
    if (otpDoc.codeHash !== hashOtpCode(otp)) return res.status(400).json({ message: 'Invalid code. Please check and try again.' });

    otpDoc.consumed = true;
    await otpDoc.save();
    user.onboarding = user.onboarding || {};
    user.onboarding.recoveryEmail = email;
    user.markModified('onboarding');
    await user.save();

    res.json({ message: 'Recovery email verified.', emailVerified: true });
  } catch (err) {
    console.error('verifyEmailRecoveryOTP error:', err);
    res.status(500).json({ message: 'Email verification failed.' });
  }
};

export const sendProfileEmailOTP = async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return res.status(400).json({ message: 'Enter a valid email address.' });
    }
    const profile = await Profile.findOne({ _id: req.params.id, user: req.user._id });
    if (!profile) return res.status(404).json({ message: 'Profile not found.' });
    if (profile.isKidsProfile) return res.status(400).json({ message: 'A profile email can only be added to an adult profile.' });

    const existingProfile = await Profile.findOne({
      user: req.user._id,
      profileEmail: email,
      _id: { $ne: profile._id },
    }).select('_id');
    if (existingProfile) return res.status(409).json({ message: 'This email is already assigned to another profile.' });

    await OTP.updateMany(
      { user: req.user._id, profileId: profile._id, purpose: 'profile-email', consumed: false },
      { $set: { consumed: true } },
    );
    const code = String(crypto.randomInt(100000, 1000000));
    const otpDoc = await OTP.create({
      user: req.user._id,
      email,
      codeHash: hashOtpCode(code),
      purpose: 'profile-email',
      profileId: profile._id,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    try {
      await sendVerificationCodeEmail(email, code, 'Your profile email verification code');
    } catch (err) {
      otpDoc.consumed = true;
      await otpDoc.save();
      throw err;
    }
    res.json({ message: `Verification code sent to ${email}. It expires in 10 minutes.`, email });
  } catch (err) {
    console.error('sendProfileEmailOTP error:', err);
    res.status(503).json({ message: 'Could not send the email verification code. Check email settings and try again.' });
  }
};

export const verifyProfileEmailOTP = async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const otp = String(req.body?.otp || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({ message: 'Enter the valid email address and 6-digit verification code.' });
    }
    const profile = await Profile.findOne({ _id: req.params.id, user: req.user._id });
    if (!profile) return res.status(404).json({ message: 'Profile not found.' });
    if (profile.isKidsProfile) return res.status(400).json({ message: 'A profile email can only be added to an adult profile.' });

    const otpDoc = await OTP.findOne({
      user: req.user._id,
      profileId: profile._id,
      email,
      purpose: 'profile-email',
      consumed: false,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });
    if (!otpDoc) return res.status(400).json({ message: 'Code expired or not found. Request a new code.' });

    otpDoc.attempts += 1;
    await otpDoc.save();
    if (otpDoc.attempts > 5) return res.status(429).json({ message: 'Too many incorrect attempts. Request a new code.' });
    if (otpDoc.codeHash !== hashOtpCode(otp)) return res.status(400).json({ message: 'Invalid code. Please check and try again.' });

    const existingProfile = await Profile.findOne({
      user: req.user._id,
      profileEmail: email,
      _id: { $ne: profile._id },
    }).select('_id');
    if (existingProfile) return res.status(409).json({ message: 'This email is already assigned to another profile.' });

    otpDoc.consumed = true;
    await otpDoc.save();
    profile.profileEmail = email;
    profile.profileEmailVerified = true;
    profile.profileEmailMarketingOptOut = Boolean(req.body?.marketingOptOut);
    await profile.save();
    res.json({ message: 'Profile email verified and saved.', profileEmail: email, emailVerified: true });
  } catch (err) {
    console.error('verifyProfileEmailOTP error:', err);
    res.status(500).json({ message: 'Could not verify the profile email.' });
  }
};

// ---------- PROFILES (Netflix "Who's Watching?") ----------
// @route GET /api/user/profiles
export const getProfiles = async (req, res) => {
  const profiles = await Profile.find({ user: req.user._id }).sort({ createdAt: 1 });
  res.json({ items: profiles });
};

const profileLockAction = (value) => (value === 'set' || value === 'delete' ? value : null);

export const sendProfileLockOTP = async (req, res) => {
  try {
    const action = profileLockAction(req.body?.action);
    if (!action) return res.status(400).json({ message: 'Choose a valid profile lock action.' });
    const [profile, user] = await Promise.all([
      Profile.findOne({ _id: req.params.id, user: req.user._id }),
      User.findById(req.user._id).select('email isEmailVerified'),
    ]);
    if (!profile) return res.status(404).json({ message: 'Profile not found.' });
    if (!user?.email || !user.isEmailVerified) {
      return res.status(400).json({ message: 'Verify your account email before using email confirmation.' });
    }

    await OTP.updateMany(
      {
        user: req.user._id,
        profileId: profile._id,
        purpose: 'profile-lock',
        $or: [{ consumed: false }, { lockTicketUsed: false }],
      },
      { $set: { consumed: true, lockTicketUsed: true } }
    );
    const code = String(crypto.randomInt(100000, 1000000));
    const otpDoc = await OTP.create({
      user: req.user._id,
      email: user.email.toLowerCase(),
      codeHash: hashOtpCode(code),
      purpose: 'profile-lock',
      profileId: profile._id,
      lockAction: action,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    try {
      await sendVerificationCodeEmail(user.email, code, 'Your profile lock verification code');
    } catch (err) {
      otpDoc.consumed = true;
      await otpDoc.save();
      throw err;
    }
    res.json({
      message: `Verification code sent to ${user.email}. It expires in 10 minutes.`,
      email: user.email,
    });
  } catch (err) {
    console.error('sendProfileLockOTP error:', err);
    res.status(503).json({ message: 'Could not send the verification code. Please try again.' });
  }
};

export const verifyProfileLockOTP = async (req, res) => {
  try {
    const action = profileLockAction(req.body?.action);
    const otp = String(req.body?.otp || '');
    if (!action || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({ message: 'Enter the 6-digit code sent to your email.' });
    }
    const otpDoc = await OTP.findOne({
      user: req.user._id,
      profileId: req.params.id,
      purpose: 'profile-lock',
      lockAction: action,
      consumed: false,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });
    if (!otpDoc) return res.status(400).json({ message: 'Code expired or not found. Request a new one.' });
    otpDoc.attempts += 1;
    await otpDoc.save();
    if (otpDoc.attempts > 5) return res.status(429).json({ message: 'Too many incorrect attempts. Request a new code.' });
    if (otpDoc.codeHash !== hashOtpCode(otp)) return res.status(400).json({ message: 'Invalid code. Please check and try again.' });

    otpDoc.consumed = true;
    const ticket = crypto.randomBytes(32).toString('hex');
    otpDoc.lockTicketHash = hashOtpCode(ticket);
    otpDoc.lockTicketUsed = false;
    await otpDoc.save();
    res.json({ ticket });
  } catch (err) {
    console.error('verifyProfileLockOTP error:', err);
    res.status(500).json({ message: 'Could not verify the email code.' });
  }
};

export const confirmProfileLockPassword = async (req, res) => {
  try {
    const action = profileLockAction(req.body?.action);
    const password = String(req.body?.password || '');
    if (!action || !password) return res.status(400).json({ message: 'Password and a valid action are required.' });
    const [profile, user] = await Promise.all([
      Profile.findOne({ _id: req.params.id, user: req.user._id }),
      User.findById(req.user._id).select('+password'),
    ]);
    if (!profile) return res.status(404).json({ message: 'Profile not found.' });
    if (!user || user.passwordless || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: 'The account password is incorrect. You can also use an email code.' });
    }
    const ticket = await issueProfileLockTicket(user._id, profile._id, action, user.email);
    res.json({ ticket });
  } catch (err) {
    console.error('confirmProfileLockPassword error:', err);
    res.status(500).json({ message: 'Could not confirm the account password.' });
  }
};

const consumeProfileLockTicket = async (req, action) => {
  const ticket = String(req.body?.ticket || '');
  if (!/^[a-f0-9]{64}$/i.test(ticket)) return null;
  return OTP.findOneAndUpdate(
    {
      user: req.user._id,
      profileId: req.params.id,
      purpose: 'profile-lock',
      lockAction: action,
      lockTicketHash: hashOtpCode(ticket),
      lockTicketUsed: false,
      expiresAt: { $gt: new Date() },
    },
    { $set: { lockTicketUsed: true } },
    { new: true }
  );
};

export const setProfileLockPIN = async (req, res) => {
  try {
    const pin = String(req.body?.pin || '');
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ message: 'Choose a 4-digit PIN.' });
    const ticket = await consumeProfileLockTicket(req, 'set');
    if (!ticket) return res.status(401).json({ message: 'Verification expired or already used. Please confirm your identity again.' });
    const profile = await Profile.findOne({ _id: req.params.id, user: req.user._id }).select('+profileLockPinHash');
    if (!profile) return res.status(404).json({ message: 'Profile not found.' });
    profile.profileLockPinHash = await bcrypt.hash(pin, 12);
    profile.profileLockEnabled = true;
    await profile.save();
    res.json({ message: 'Profile Lock is on.' });
  } catch (err) {
    console.error('setProfileLockPIN error:', err);
    res.status(500).json({ message: 'Could not save the profile PIN.' });
  }
};

export const deleteProfileLock = async (req, res) => {
  try {
    const ticket = await consumeProfileLockTicket(req, 'delete');
    if (!ticket) return res.status(401).json({ message: 'Verification expired or already used. Please confirm your identity again.' });
    const profile = await Profile.findOne({ _id: req.params.id, user: req.user._id }).select('+profileLockPinHash');
    if (!profile) return res.status(404).json({ message: 'Profile not found.' });
    profile.profileLockPinHash = '';
    profile.profileLockEnabled = false;
    await profile.save();
    res.json({ message: 'Profile Lock has been removed.' });
  } catch (err) {
    console.error('deleteProfileLock error:', err);
    res.status(500).json({ message: 'Could not remove the profile lock.' });
  }
};

export const verifyProfileLockPIN = async (req, res) => {
  try {
    const pin = String(req.body?.pin || '');
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ message: 'Enter the 4-digit profile PIN.' });
    const profile = await Profile.findOne({ _id: req.params.id, user: req.user._id }).select('+profileLockPinHash');
    if (!profile) return res.status(404).json({ message: 'Profile not found.' });
    if (!profile.profileLockEnabled || !profile.profileLockPinHash) {
      return res.status(400).json({ message: 'This profile does not have a lock.' });
    }
    if (!(await bcrypt.compare(pin, profile.profileLockPinHash))) {
      return res.status(401).json({ message: 'Incorrect PIN. Please try again.' });
    }
    res.json({ unlockToken: generateProfileUnlockToken(req.user._id, profile._id) });
  } catch (err) {
    console.error('verifyProfileLockPIN error:', err);
    res.status(500).json({ message: 'Could not verify the profile PIN.' });
  }
};

// @route POST /api/user/profiles { name, isKidsProfile, avatarColor, avatarUrl }
export const createProfile = async (req, res) => {
  try {
    const count = await Profile.countDocuments({ user: req.user._id });
    if (count >= MAX_PROFILES) return res.status(400).json({ message: `Maximum ${MAX_PROFILES} profiles reached` });
    const { name, isKidsProfile, avatarColor, avatarUrl } = req.body;
    if (!name) return res.status(400).json({ message: 'Profile name is required' });
    const profile = await Profile.create({
      user: req.user._id, name, isKidsProfile: !!isKidsProfile,
      maturityLimit: isKidsProfile ? 'ALL' : '18+', avatarColor, avatarUrl,
    });
    res.status(201).json({ profile });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'A profile with this name already exists' });
    res.status(500).json({ message: 'Failed to create profile' });
  }
};

// @route PUT /api/user/profiles/:id
export const updateProfile = async (req, res) => {
  try {
    const profile = await Profile.findOne({ _id: req.params.id, user: req.user._id });
    if (!profile) return res.status(404).json({ message: 'Profile not found' });
    const preferences = req.body.notificationPreferences;
    if (preferences !== undefined) {
      const validChannels = ['email', 'text', 'push'];
      if (
        !preferences ||
        typeof preferences !== 'object' ||
        Array.isArray(preferences) ||
        Object.entries(preferences).some(([channel, enabled]) => !validChannels.includes(channel) || typeof enabled !== 'boolean')
      ) {
        return res.status(400).json({ message: 'Notification preferences must contain boolean email, text, or push values.' });
      }
      validChannels.forEach((channel) => {
        if (preferences[channel] !== undefined) profile.set(`notificationPreferences.${channel}`, preferences[channel]);
      });
    }
    const allowed = ['name', 'avatarUrl', 'avatarColor', 'isKidsProfile', 'maturityLimit', 'language', 'autoplayNext'];
    allowed.forEach((k) => { if (req.body[k] !== undefined) profile[k] = req.body[k]; });
    await profile.save();
    res.json({ profile });
  } catch {
    res.status(500).json({ message: 'Failed to update profile' });
  }
};

// @route DELETE /api/user/profiles/:id
export const deleteProfile = async (req, res) => {
  try {
    const profile = await Profile.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!profile) return res.status(404).json({ message: 'Profile not found' });
    await Watchlist.deleteMany({ profile: profile._id });
    await WatchHistory.deleteMany({ profile: profile._id });
    res.json({ message: 'Profile deleted' });
  } catch {
    res.status(500).json({ message: 'Failed to delete profile' });
  }
};

// ---------- POST-PAYMENT ONBOARDING (Netflix "Simple setup") ----------
// The step-by-step screens shown after "Start Membership": devices → who's
// watching → maturity → genres → languages → pick 3 titles. Each PUT advances
// onboardingStep so a member who leaves mid-setup resumes exactly where they
// left, before /browse opens.
const ONBOARD_DEVICES = ['TV', 'Phone or Tablet', 'Computer', 'Game Console', 'Streaming Device', 'TV Set-top Box'];
const ONBOARD_MATURITY = ['Little Kids', 'Older Kids', 'Teens', 'Mature', 'All'];
const ONBOARD_LANGUAGES = ['English', 'Bahasa Melayu', 'Čeština', 'Dansk', 'Deutsch', 'Español', 'Español (España)', 'Filipino', 'Français', 'Hrvatski', 'Indonesia', 'Italiano', 'Magyar', 'Nederlands', 'Urdu', 'Suomi', 'Svenska', 'Tiếng Việt', 'Türkçe', 'Ελληνικά', 'Русский', 'Українська', 'العربية', 'हिन्दी', 'தமிழ்', 'తెలుగు'];

// @route PUT /api/user/onboarding { step, ...payload }
export const saveOnboarding = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (!user.membershipActive) return res.status(403).json({ message: 'Membership is not active' });

    const { step, recoveryPhone, devices, profiles, maturity, dob, gender, genres, languages, picks } = req.body;
    const ob = user.onboarding || {};

    if (step === 1) {
      // Verify card screen — optional recovery phone
      if (recoveryPhone !== undefined) ob.recoveryPhone = String(recoveryPhone).slice(0, 24);
      user.onboardingStep = 2; // → welcome → devices (step index 2 = devices)
    } else if (step === 2) {
      // Choose devices
      if (!Array.isArray(devices) || devices.some((d) => !ONBOARD_DEVICES.includes(d)))
        return res.status(400).json({ message: 'Choose at least one device' });
      ob.devices = devices;
      user.onboardingStep = 3; // → who's watching
    } else if (step === 3) {
      // Who will be watching — create the profiles for real
      if (!Array.isArray(profiles) || !profiles.length)
        return res.status(400).json({ message: 'Add at least one profile' });
      if (profiles.length > 5) return res.status(400).json({ message: 'Maximum 5 profiles' });
      const existing = await Profile.find({ user: user._id }).sort({ createdAt: 1 });
      for (const name of profiles) {
        const clean = String(name).trim().slice(0, 40);
        if (!clean) continue;
        if (existing.some((p) => p.name.toLowerCase() === clean.toLowerCase())) continue; // keep seed profile
        try { await Profile.create({ user: user._id, name: clean, maturityLimit: '18+' }); } catch { /* duplicate name — skip */ }
      }
      ob.profiles = profiles;
      user.onboardingStep = 4; // → maturity
    } else if (step === 4) {
      // Profile details screen (DOB + gender) — maturity optional, defaults to All
      if (maturity && ONBOARD_MATURITY.includes(maturity)) ob.maturity = maturity;
      else if (!ob.maturity) ob.maturity = 'All';
      if (dob && typeof dob === 'object') {
        ob.dob = { day: String(dob.day || '').slice(0, 2), month: String(dob.month || '').slice(0, 2), year: String(dob.year || '').slice(0, 4) };
      }
      if (gender) ob.gender = String(gender).slice(0, 20);
      user.onboardingStep = 6; // → languages (genres screen no longer used)
    } else if (step === 5) {
      if (!Array.isArray(genres) || genres.length < 3)
        return res.status(400).json({ message: 'Pick at least 3 genres' });
      ob.genres = genres;
      user.onboardingStep = 6; // → languages
    } else if (step === 6) {
      if (!Array.isArray(languages) || languages.some((l) => !ONBOARD_LANGUAGES.includes(l)))
        return res.status(400).json({ message: 'Choose valid languages' });
      ob.languages = languages;
      user.onboardingStep = 7; // → pick titles
    } else if (step === 7) {
      // Pick 3 titles — accept title ids, store them, finish the setup
      if (!Array.isArray(picks) || picks.length < 3)
        return res.status(400).json({ message: 'Pick 3 titles you like' });
      ob.picks = picks.slice(0, 3).map((p) => String(p));
      user.onboardingStep = 8;
      user.onboardingDone = true;
      // Resume state fully consumed — the member goes straight to /browse now
      user.signupStep = '';
      user.signupPlan = '';
    } else {
      return res.status(400).json({ message: 'Invalid onboarding step' });
    }

    user.onboarding = ob;
    user.markModified('onboarding');
    await user.save();
    res.json({ ok: true, onboardingStep: user.onboardingStep, onboardingDone: user.onboardingDone });
  } catch (err) {
    console.error('saveOnboarding:', err);
    res.status(500).json({ message: 'Failed to save onboarding progress' });
  }
};

// ---------- MID-SIGNUP RESUME ----------
// Saves where a signed-in user left the signup flow so the "Finish Sign-Up"
// page can drop them back at the exact step (Netflix behaviour).
const RESUME_STEPS = ['plan-intro', 'plan', 'upgrade', 'pay', 'card'];
const PLAN_IDS = ['mobile', 'basic', 'standard', 'premium'];

// @route PUT /api/user/signup-progress { step, plan }
export const saveSignupProgress = async (req, res) => {
  try {
    const { step, plan } = req.body;
    if (!RESUME_STEPS.includes(step)) return res.status(400).json({ message: 'Invalid signup step' });
    const update = { signupStep: step };
    if (plan != null) {
      if (!PLAN_IDS.includes(plan)) return res.status(400).json({ message: 'Invalid plan' });
      update.signupPlan = plan;
    }
    await User.findByIdAndUpdate(req.user._id, update);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ message: 'Failed to save signup progress' });
  }
};
