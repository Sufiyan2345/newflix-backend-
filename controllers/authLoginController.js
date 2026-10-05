import { otpLimiter } from '../middleware/rateLimiters.js';
import { generateTokens, verifyRefreshToken, cookieOptions } from '../middleware/tokens.js';
import crypto from 'crypto';
import User from '../models/User.js';
import Payment from '../models/Payment.js';
import Profile from '../models/Profile.js';
import OTP from '../models/OTP.js';
import { sendPasswordResetEmail, sendPasswordUpdatedEmail } from '../config/mailer.js';
import { normalizePhone, sendOTPSMS } from '../config/sms.js';

const generateOTP = () => String(crypto.randomInt(100000, 999999));
const hashOTP = (code) => crypto.createHash('sha256').update(code).digest('hex');
const otpExpiry = () => new Date(Date.now() + 10 * 60 * 1000);

const issueTokens = (user, res) => {
  const { accessToken, refreshToken } = generateTokens(user);
  res.cookie('sf_access', accessToken, cookieOptions);
  res.cookie('sf_refresh', refreshToken, cookieOptions);
  return accessToken;
};

// A user is a member once a paid payment exists. Accounts created before the
// membershipActive flag existed are migrated lazily the first time they sign in.
const membershipState = async (user) => {
  if (user.membershipActive) return true;
  const paid = await Payment.exists({ user: user._id, status: 'paid' });
  if (!paid) return false;
  await User.findByIdAndUpdate(user._id, { membershipActive: true });
  return true;
};

// @route POST /api/auth/login  { email, password }
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });

    const user = await User.findOne({ email: email.toLowerCase() }).select('+password +loginAttempts +lockUntil');
    if (!user) return res.status(401).json({ message: 'Invalid email or password' });

    // Account lock after 5 failed attempts for 15 minutes
    if (user.isLocked()) {
      const mins = Math.ceil((user.lockUntil - Date.now()) / 60000);
      return res.status(423).json({ message: `Account temporarily locked. Try again in ${mins} minute(s).` });
    }
    if (user.isSuspended) {
      return res.status(403).json({ message: `Account suspended. ${user.suspendedReason || 'Contact support.'}` });
    }

    // Passwordless member (created by the emailed "Create Your Account" link):
    // there is no password to compare, so point them at the way back in.
    if (user.passwordless) {
      return res.status(400).json({
        message: 'This account signs you in with an email link instead of a password. Use "Forgot password" to set one.',
      });
    }


    const ok = await user.comparePassword(password);
    if (!ok) {
      user.loginAttempts += 1;
      if (user.loginAttempts >= 5) {
        user.lockUntil = new Date(Date.now() + 15 * 60 * 1000);
        user.loginAttempts = 0;
      }
      await user.save();
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    user.loginAttempts = 0;
    user.lockUntil = null;
    user.lastLoginAt = new Date();
    user.isOnline = true;
    await user.save();

    const accessToken = issueTokens(user, res);
    res.json({
      message: 'Login successful',
      accessToken,
      user: {
        id: user._id, name: user.name, email: user.email, role: user.role,
        isEmailVerified: user.isEmailVerified,
        phone: user.phone || '', phoneVerified: Boolean(user.phoneVerified),
        createdAt: user.createdAt, lastLoginAt: user.lastLoginAt,
        membershipActive: await membershipState(user),
        signupStep: user.signupStep, signupPlan: user.signupPlan,
        onboardingDone: user.onboardingDone, onboardingStep: user.onboardingStep,
      },
    });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ message: 'Login failed' });
  }
};

// @route POST /api/auth/send-phone-otp { phone }
export const sendPhoneOTP = async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ message: 'Enter a valid mobile number, including country code.' });

    const user = await User.findOne({ phone });
    // Do not reveal whether a phone number is registered.
    if (!user) return res.json({ message: 'If that mobile number exists, an OTP has been sent.' });
    if (user.isSuspended) return res.status(403).json({ message: 'This account is suspended. Contact support.' });

    const code = generateOTP();
    const otpDoc = await OTP.create({ phone, codeHash: hashOTP(code), purpose: 'phone-login', expiresAt: otpExpiry() });
    try {
      await sendOTPSMS(phone, code);
    } catch (err) {
      otpDoc.consumed = true;
      await otpDoc.save();
      throw err;
    }
    res.json({ message: 'If that mobile number exists, an OTP has been sent. It expires in 10 minutes.' });
  } catch (err) {
    console.error('sendPhoneOTP error:', err);
    res.status(503).json({ message: 'Could not send the SMS OTP. Check SMS provider settings and try again.' });
  }
};

// @route POST /api/auth/verify-phone-otp { phone, otp }
export const verifyPhoneOTP = async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const otp = String(req.body?.otp || '');
    if (!phone || !/^\d{6}$/.test(otp)) return res.status(400).json({ message: 'Mobile number and 6-digit OTP are required.' });

    const otpDoc = await OTP.findOne({ phone, purpose: 'phone-login', consumed: false, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
    if (!otpDoc) return res.status(400).json({ message: 'OTP expired or not found. Request a new one.' });
    otpDoc.attempts += 1;
    await otpDoc.save();
    if (otpDoc.attempts > 5) return res.status(429).json({ message: 'Too many wrong OTP attempts. Request a new one.' });
    if (otpDoc.codeHash !== hashOTP(otp)) return res.status(400).json({ message: 'Invalid OTP.' });

    const user = await User.findOne({ phone });
    if (!user || user.isSuspended) return res.status(401).json({ message: 'Unable to sign in with that mobile number.' });
    otpDoc.consumed = true;
    await otpDoc.save();
    user.loginAttempts = 0;
    user.lockUntil = null;
    user.lastLoginAt = new Date();
    user.isOnline = true;
    await user.save();

    const accessToken = issueTokens(user, res);
    res.json({ message: 'Login successful', accessToken, user: {
      id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role,
      isEmailVerified: user.isEmailVerified,
      membershipActive: await membershipState(user),
      signupStep: user.signupStep, signupPlan: user.signupPlan,
    } });
  } catch (err) {
    console.error('verifyPhoneOTP error:', err);
    res.status(500).json({ message: 'Phone verification failed.' });
  }
};

// @route POST /api/auth/refresh
export const refresh = async (req, res) => {
  try {
    const token = req.cookies?.sf_refresh || req.body?.refreshToken;
    if (!token) return res.status(401).json({ message: 'No refresh token' });
    const decoded = verifyRefreshToken(token);
    const user = await User.findById(decoded.id);
    if (!user || user.isSuspended) return res.status(401).json({ message: 'Invalid refresh token' });
    issueTokens(user, res);
    res.json({ message: 'Token refreshed' });
  } catch {
    res.status(401).json({ message: 'Refresh token expired. Please log in again.' });
  }
};

// @route POST /api/auth/logout
export const logout = async (req, res) => {
  if (req.user) {
    req.user.isOnline = false;
    await req.user.save();
  }
  res.clearCookie('sf_access', { path: '/' });
  res.clearCookie('sf_refresh', { path: '/' });
  res.json({ message: 'Logged out' });
};

// @route POST /api/auth/forgot-password  { email }
export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() });
    if (!user) return res.json({ message: 'If that email exists, an OTP has been sent.' });

    const code = generateOTP();
    await OTP.create({
      email: user.email,
      codeHash: hashOTP(code),
      purpose: 'forgot-password',
      expiresAt: otpExpiry(),
    });
    const resetUrl = `${(process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '')}/login/help?reset=${encodeURIComponent(user.email)}&code=${encodeURIComponent(code)}`;
    await sendPasswordResetEmail(user.email, resetUrl, user.name);
    res.json({ message: 'If that email exists, an OTP has been sent.' });
  } catch (err) {
    console.error('forgotPassword error:', err);
    res.status(500).json({ message: 'Failed to process request' });
  }
};

// @route POST /api/auth/reset-password  { email, otp, newPassword }
export const resetPassword = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword)
      return res.status(400).json({ message: 'Email, OTP and new password are required' });
    if (newPassword.length < 8)
      return res.status(400).json({ message: 'Password must be at least 8 characters' });

    const otpDoc = await OTP.findOne({
      email: email.toLowerCase(), purpose: 'forgot-password', consumed: false, expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });
    if (!otpDoc) return res.status(400).json({ message: 'OTP expired or not found. Request a new one.' });

    otpDoc.attempts += 1;
    await otpDoc.save();
    if (otpDoc.attempts > 5) return res.status(429).json({ message: 'Too many wrong attempts. Request a new OTP.' });
    if (otpDoc.codeHash !== hashOTP(otp)) return res.status(400).json({ message: 'Invalid OTP' });
    otpDoc.consumed = true;
    await otpDoc.save();

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ message: 'User not found' });
    user.password = newPassword; // hashed by pre-save hook
    user.passwordless = false;   // a real password now exists → password login works
    await user.save();

    // The password is already changed; notification delivery must not make the
    // reset endpoint report a false failure if Gmail is temporarily unavailable.
    try { await sendPasswordUpdatedEmail(user.email, user.name); }
    catch (notifyErr) { console.error('password-updated email error:', notifyErr); }

    res.json({ message: 'Password reset successful. You can now log in.', email: user.email });
  } catch (err) {
    console.error('resetPassword error:', err);
    res.status(500).json({ message: 'Password reset failed' });
  }
};
// @route POST /api/auth/send-phone-reset-otp { phone }
export const sendPhonePasswordResetOTP = async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ message: 'Enter a valid mobile number, including country code.' });

    const user = await User.findOne({ $or: [{ phone }, { 'onboarding.recoveryPhone': phone }] });
    if (!user || user.isSuspended) {
      return res.json({ message: 'If an account matches that mobile number, a reset code has been sent.' });
    }

    const code = generateOTP();
    const otpDoc = await OTP.create({
      phone,
      codeHash: hashOTP(code),
      purpose: 'forgot-password',
      expiresAt: otpExpiry(),
    });
    try {
      await sendOTPSMS(phone, code);
    } catch (err) {
      otpDoc.consumed = true;
      await otpDoc.save();
      throw err;
    }

    res.json({ message: 'If an account matches that mobile number, a reset code has been sent.' });
  } catch (err) {
    console.error('sendPhonePasswordResetOTP error:', err);
    res.status(503).json({ message: 'Could not send the SMS reset code. Please try again later.' });
  }
};

// @route POST /api/auth/reset-password-sms { phone, otp, newPassword }
export const resetPasswordSms = async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const otp = String(req.body?.otp || '');
    const newPassword = String(req.body?.newPassword || '');

    if (!phone || !/^\d{6}$/.test(otp) || !newPassword)
      return res.status(400).json({ message: 'Mobile number, 6-digit code and new password are required.' });
    if (newPassword.length < 8)
      return res.status(400).json({ message: 'Password must be at least 8 characters' });

    const otpDoc = await OTP.findOne({
      phone, purpose: 'forgot-password', consumed: false, expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });
    if (!otpDoc) return res.status(400).json({ message: 'Code expired or not found. Request a new code.' });
    otpDoc.attempts += 1;
    await otpDoc.save();
    if (otpDoc.attempts > 5) return res.status(429).json({ message: 'Too many wrong attempts. Request a new code.' });
    if (otpDoc.codeHash !== hashOTP(otp)) return res.status(400).json({ message: 'Invalid code. Please check and try again.' });

    const user = await User.findOne({
      $or: [{ phone }, { 'onboarding.recoveryPhone': phone }],
    }).select('+loginAttempts +lockUntil');
    if (!user) return res.status(404).json({ message: "We couldn't find an account with that mobile number." });
    if (user.isSuspended)
      return res.status(403).json({ message: `Account suspended. ${user.suspendedReason || 'Contact support.'}` });

    otpDoc.consumed = true;
    await otpDoc.save();
    user.password = newPassword; // hashed by the pre-save hook
    user.passwordless = false;
    user.loginAttempts = 0;
    user.lockUntil = null;
    await user.save();

    await OTP.updateMany(
      { email: user.email, purpose: 'forgot-password', consumed: false },
      { $set: { consumed: true } },
    );
    await OTP.updateMany(
      { phone, purpose: 'forgot-password', consumed: false },
      { $set: { consumed: true } },
    );

    try { await sendPasswordUpdatedEmail(user.email, user.name); }
    catch (notifyErr) { console.error('password-updated email error:', notifyErr); }

    res.json({ message: 'Password reset successful. You can now log in.', email: user.email });
  } catch (err) {
    console.error('resetPasswordSms error:', err);
    res.status(500).json({ message: 'Password reset failed' });
  }
};



// @route POST /api/auth/find-account  { firstName, lastName }
// Netflix's "Forgot email or mobile number" — locate an account by the name on
// it and reply with a masked email (never the full address, anti-enumeration).
export const findAccount = async (req, res) => {
  try {
    const { firstName, lastName } = req.body;
    if (!firstName?.trim() || !lastName?.trim())
      return res.status(400).json({ message: 'First name and last name are required' });

    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const user = await User.findOne({
      name: { $regex: `^${esc(firstName.trim())}\\s+${esc(lastly(lastName.trim()))}`, $options: 'i' },
    });
    if (!user) return res.status(404).json({ message: "We couldn't find an account with that information. Please double-check and try again." });

    const [local, domain] = user.email.split('@');
    res.json({ emailMasked: `${local.slice(0, 2)}******@${domain}` });
  } catch (err) {
    console.error('findAccount error:', err);
    res.status(500).json({ message: 'Search failed' });
  }
};

// small helper — last name may contain spaces; match it as a prefix of the remainder
const lastly = (ln) => ln.split(/\s+/).join('\\s+');

// @route GET /api/auth/me
export const getMe = async (req, res) => {
  try {
    const user = req.user;
    const profiles = await Profile.find({ user: user._id }).sort({ createdAt: 1 });
    res.json({
      user: {
        id: user._id, name: user.name, email: user.email, role: user.role,
        isEmailVerified: user.isEmailVerified,
        phone: user.phone || '', phoneVerified: Boolean(user.phoneVerified),
        createdAt: user.createdAt, lastLoginAt: user.lastLoginAt,
        membershipActive: await membershipState(user),
        signupStep: user.signupStep, signupPlan: user.signupPlan,
        onboardingDone: user.onboardingDone, onboardingStep: user.onboardingStep,
      },
      profiles,
    });
  } catch (err) {
    console.error('getMe:', err);
    res.status(500).json({ message: 'Failed to load profile data' });
  }
};

export { otpLimiter };
