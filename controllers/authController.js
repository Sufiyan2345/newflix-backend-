import crypto from 'crypto';
import User from '../models/User.js';
import Profile from '../models/Profile.js';
import OTP from '../models/OTP.js';
import { sendSignupLinkEmail, sendFinishSignupEmail, sendVerificationCodeEmail } from '../config/mailer.js';
import { generateTokens, verifyRefreshToken, cookieOptions } from '../middleware/tokens.js';
import { otpLimiter } from '../middleware/rateLimiters.js';
import { normalizePhone } from '../config/sms.js';

const generateOTP = () => String(crypto.randomInt(100000, 999999));
const hashOTP = (code) => crypto.createHash('sha256').update(code).digest('hex');
const otpExpiry = () => new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

export const buildSignupLinkUrl = (email, otp, variant = 'create') => {
  const base = (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');
  return `${base}/finish-signup?variant=${encodeURIComponent(variant)}&email=${encodeURIComponent(String(email).toLowerCase())}&otp=${encodeURIComponent(String(otp))}`;
};

// The user object every auth response returns (same shape as /auth/signup).
const publicUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  phone: user.phone || '',
  role: user.role,
  isEmailVerified: Boolean(user.isEmailVerified),
  phoneVerified: Boolean(user.phoneVerified),
  createdAt: user.createdAt,
  lastLoginAt: user.lastLoginAt,
  membershipActive: Boolean(user.membershipActive),
  signupStep: user.signupStep || '',
  signupPlan: user.signupPlan || '',
  onboardingDone: Boolean(user.onboardingDone),
  onboardingStep: user.onboardingStep || 0,
});


const issueTokens = (user, res) => {
  const { accessToken, refreshToken } = generateTokens(user);
  res.cookie('sf_access', accessToken, cookieOptions);
  res.cookie('sf_refresh', refreshToken, cookieOptions);
  return accessToken;
};

// @route POST /api/auth/send-otp  { email, purpose: 'signup' | 'forgot-password', delivery: 'code' | 'link' | 'finish' }
export const sendOTP = async (req, res) => {
  try {
    const { email, purpose = 'signup', delivery = 'code' } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required' });

    const existingUser = await User.findOne({ email: email.toLowerCase() });

    if (purpose === 'signup' && existingUser && existingUser.isEmailVerified && delivery !== 'finish') {
      return res.status(409).json({ message: 'An account with this email already exists. Please log in.' });
    }
    if (purpose === 'forgot-password' && !existingUser) {
      // Never reveal whether an email exists (user-enumeration protection)
      return res.json({ message: 'If that email exists, an OTP has been sent.' });
    }

    const code = generateOTP();
    await OTP.create({
      email: email.toLowerCase(),
      codeHash: hashOTP(code),
      purpose,
      expiresAt: otpExpiry(),
    });

    if (purpose === 'signup' && delivery === 'link') {
      const linkUrl = buildSignupLinkUrl(email, code, 'create');
      await sendSignupLinkEmail(email, linkUrl, 'create');
      return res.json({ message: 'A sign-up link has been sent to your email.' });
    }

    if (purpose === 'signup' && delivery === 'finish') {
      const linkUrl = buildSignupLinkUrl(email, code, 'finish');
      await sendFinishSignupEmail(email, linkUrl);
      return res.json({ message: 'A finish-signup link has been sent to your email.' });
    }

    await sendVerificationCodeEmail(
      email,
      code,
      purpose === 'signup'
        ? `Confirm your account change with this code: ${code}`
        : `Confirm your password reset with this code: ${code}`
    );

    res.json({ message: 'OTP sent to your email. It expires in 10 minutes.' });
  } catch (err) {
    console.error('sendOTP error:', err);
    const message = err?.message?.includes('Gmail SMTP') || err?.message?.includes('SMTP')
      ? err.message
      : 'Failed to send OTP. Check Gmail SMTP settings.';
    res.status(500).json({ message });
  }
};

// @route POST /api/auth/signup  { name, email, password, otp }
export const signup = async (req, res) => {
  try {
    const { name, email, password, otp, phone } = req.body;
    if (!name || !email || !password || !otp)
      return res.status(400).json({ message: 'Name, email, password and OTP are required' });
    if (password.length < 8)
      return res.status(400).json({ message: 'Password must be at least 8 characters' });

    const emailLower = email.toLowerCase();
    const phoneNormalized = phone ? normalizePhone(phone) : null;
    if (phone && !phoneNormalized) return res.status(400).json({ message: 'Please enter a valid international mobile number.' });
    const existing = await User.findOne({ email: emailLower });
    if (existing && existing.isEmailVerified)
      return res.status(409).json({ message: 'Account already exists. Please log in.' });
    if (phoneNormalized) {
      const phoneOwner = await User.findOne({ phone: phoneNormalized, ...(existing ? { _id: { $ne: existing._id } } : {}) });
      if (phoneOwner) return res.status(409).json({ message: 'That mobile number is already linked to an account.' });
    }

    const otpDoc = await OTP.findOne({
      email: emailLower, purpose: 'signup', consumed: false, expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });
    if (!otpDoc) return res.status(400).json({ message: 'OTP expired or not found. Request a new one.' });

    otpDoc.attempts += 1;
    await otpDoc.save();
    if (otpDoc.attempts > 5) return res.status(429).json({ message: 'Too many wrong OTP attempts. Request a new one.' });
    if (otpDoc.codeHash !== hashOTP(otp))
      return res.status(400).json({ message: 'Invalid OTP. Please check and try again.' });
    otpDoc.consumed = true;
    await otpDoc.save();

    let user = existing;
    if (user) {
      user.name = name;
      user.password = password; // hashed by pre-save hook
      user.phone = phoneNormalized || user.phone;
      user.isEmailVerified = true;
      user.isOnline = true;
      await user.save();
    } else {
      user = await User.create({ name, email: emailLower, phone: phoneNormalized || undefined, password, isEmailVerified: true, isOnline: true, role: 'user' });
    }

    await Profile.create({ user: user._id, name: (name.split(' ')[0] || name).slice(0, 40) });

    const accessToken = issueTokens(user, res);
    res.status(201).json({
      message: 'Account created successfully',
      accessToken,
      user: { id: user._id, name: user.name, email: user.email, phone: user.phone || '', role: user.role, isEmailVerified: true, phoneVerified: Boolean(user.phoneVerified), createdAt: user.createdAt, lastLoginAt: user.lastLoginAt, membershipActive: false, signupStep: '', signupPlan: '', onboardingDone: false, onboardingStep: 0 },
    });
  } catch (err) {
    console.error('signup error:', err);
    res.status(500).json({ message: 'Signup failed' });
  }
};


// @route POST /api/auth/signup-link  { email, otp }
// The red "Create Your Account" button in the sign-up email. Tapping it finishes
// the passwordless sign-up Netflix promises in that mail ("No password needed"):
// the account is created (or an unfinished one completed) and the member is
// signed in, so the next screen is Netflix's "Choose the plan". Re-clicking an
// already-used link simply signs the member back in.
export const signupWithLink = async (req, res) => {
  try {
    const { email, otp } = req.body || {};
    if (!email || !otp)
      return res.status(400).json({ message: 'This sign-up link is incomplete. Request a new one.' });

    const emailLower = String(email).toLowerCase().trim();
    // +password: the refresh token is versioned with a hash of it (middleware/tokens.js)
    const existing = await User.findOne({ email: emailLower }).select('+password');

    const otpDoc = await OTP.findOne({
      email: emailLower, purpose: 'signup', consumed: false, expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });

    if (!otpDoc) {
      // Already used or expired: a verified member is simply signed back in.
      if (existing && existing.isEmailVerified) {
        if (existing.isSuspended)
          return res.status(403).json({ message: `Account suspended. ${existing.suspendedReason || 'Contact support.'}` });
        existing.lastLoginAt = new Date();
        existing.isOnline = true;
        await existing.save();
        const accessToken = issueTokens(existing, res);
        return res.json({ message: 'Signed in with your email link', accessToken, user: publicUser(existing) });
      }
      return res.status(400).json({ message: 'This sign-up link has expired. Request a new one.' });
    }

    otpDoc.attempts += 1;
    await otpDoc.save();
    if (otpDoc.attempts > 5)
      return res.status(429).json({ message: 'Too many tries on this link. Request a new one.' });
    if (otpDoc.codeHash !== hashOTP(otp))
      return res.status(400).json({ message: 'This sign-up link is no longer valid. Request a new one.' });
    otpDoc.consumed = true;
    await otpDoc.save();

    let user = existing;
    let shouldSendFinishEmail = false;
    if (user) {
      // An unfinished sign-up for this address — finish it in place.
      if (!user.isEmailVerified) {
        user.isEmailVerified = true;
        shouldSendFinishEmail = true;
      }
    } else {
      // Passwordless account. The schema needs *a* password value, so a random
      // one nobody ever types is stored; "Forgot password" can set a real one.
      user = await User.create({
        name: (emailLower.split('@')[0] || 'member').slice(0, 40),
        email: emailLower,
        password: crypto.randomBytes(24).toString('hex'),
        isEmailVerified: true,
        passwordless: true,
        role: 'user',
        isOnline: true,
      });
      await Profile.create({ user: user._id, name: (user.name || 'Member').slice(0, 40) });
      shouldSendFinishEmail = true;
    }

    user.lastLoginAt = new Date();
    user.isOnline = true;
    await user.save();

    // After the account is created, send the separate "Finish signing up"
    // message shown in the reference inbox. It gets its own one-time link.
    if (shouldSendFinishEmail) {
      try {
        const finishCode = generateOTP();
        await OTP.create({
          email: emailLower,
          codeHash: hashOTP(finishCode),
          purpose: 'signup',
          expiresAt: otpExpiry(),
        });
        await sendFinishSignupEmail(emailLower, buildSignupLinkUrl(emailLower, finishCode, 'finish'));
      } catch (finishMailErr) {
        // Account creation is already complete; do not turn a mail outage into
        // a failed signup response.
        console.error('finish-signup email error:', finishMailErr);
      }
    }

    const accessToken = issueTokens(user, res);
    res.status(201).json({ message: 'Account created successfully', accessToken, user: publicUser(user) });
  } catch (err) {
    console.error('signupWithLink error:', err);
    res.status(500).json({ message: 'Could not finish signing up. Please request a new link.' });
  }
};
