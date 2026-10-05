import express from 'express';
import {
  sendOTP, signup, signupWithLink,
} from '../controllers/authController.js';
import {
  login, sendPhoneOTP, verifyPhoneOTP, refresh, logout, forgotPassword, sendPhonePasswordResetOTP, resetPassword, resetPasswordSms, getMe, otpLimiter, findAccount,
} from '../controllers/authLoginController.js';
import { protect, optionalAuth } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimiters.js';

const router = express.Router();

// OTP (strictly rate-limited to prevent email bombing)
router.post('/send-otp', otpLimiter, sendOTP);
// Red "Create Your Account" button in the sign-up email — creates the
// passwordless account and signs the member in (no password step, like Netflix)
router.post('/signup-link', authLimiter, signupWithLink);
router.post('/signup', authLimiter, signup);
router.post('/login', authLimiter, login);
router.post('/send-phone-otp', otpLimiter, sendPhoneOTP);
router.post('/verify-phone-otp', authLimiter, verifyPhoneOTP);
router.post('/refresh', refresh);
router.post('/logout', optionalAuth, logout);
router.post('/forgot-password', otpLimiter, forgotPassword);
router.post('/send-phone-reset-otp', otpLimiter, sendPhonePasswordResetOTP);
router.post('/reset-password', authLimiter, resetPassword);
router.post('/reset-password-sms', authLimiter, resetPasswordSms);
router.post('/find-account', authLimiter, findAccount);
router.get('/me', protect, getMe);

export default router;
