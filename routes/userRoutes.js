import express from 'express';
import {
  getProfiles, createProfile, updateProfile, deleteProfile, saveSignupProgress, saveOnboarding,
  sendPhoneVerifyOTP, verifyPhoneVerifyOTP,
} from '../controllers/userController.js';
import {
  getWatchlist, addToWatchlist, removeFromWatchlist, watchlistStatus,
} from '../controllers/userWatchlistController.js';
import {
  updateWatchHistory, updateTmdbWatchHistory, continueWatching, getHistory,
  removeHistoryItem, removeTmdbHistoryItem,
  getNotifications, markNotificationsRead,
} from '../controllers/userWatchlistController.js';
import { reportProblem, myReports } from '../controllers/userSupportController.js';
import { protect } from '../middleware/auth.js';
import { profileContext } from '../middleware/profileContext.js';

const router = express.Router();
router.use(protect, profileContext); // resolve active profile for watchlist/history (x-profile-id header)

// Profiles
router.get('/profiles', getProfiles);
router.post('/profiles', createProfile);
router.put('/profiles/:id', updateProfile);
router.delete('/profiles/:id', deleteProfile);

// Watchlist
router.get('/watchlist', getWatchlist);
router.post('/watchlist', addToWatchlist);
router.delete('/watchlist/:titleId', removeFromWatchlist);
router.get('/watchlist/status/:titleId', watchlistStatus);

// Watch history
router.post('/watch-history', updateWatchHistory);
router.post('/tmdb-watch-history', updateTmdbWatchHistory);
router.get('/continue-watching', continueWatching);
router.get('/history', getHistory);
router.delete('/history/tmdb/:tmdbId', removeTmdbHistoryItem);
router.delete('/history/:titleId', removeHistoryItem);

// Notifications
router.get('/notifications', getNotifications);
router.put('/notifications/read-all', markNotificationsRead);

// Mid-signup resume — "Finish Sign-Up" restores the exact step the user left
router.put('/signup-progress', saveSignupProgress);

// Post-payment "Simple setup" — step-by-step screens before /browse opens
router.put('/onboarding', saveOnboarding);

// Recovery-phone SMS OTP verification (Welcome screen)
router.post('/phone/send-otp', sendPhoneVerifyOTP);
router.post('/phone/verify-otp', verifyPhoneVerifyOTP);

// Support — "Report a problem" straight from the video player (SRS §10 / §23)
router.post('/report-problem', reportProblem);
router.get('/reports', myReports);

export default router;
