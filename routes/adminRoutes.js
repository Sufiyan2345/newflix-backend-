import express from 'express';
import {
  dashboard, adminListTitles, createTitle, updateTitle, deleteTitle, toggleFlags,
  duplicateTitle, bulkImportCsv, resolveVideoLink, checkEmbeddable,
} from '../controllers/adminController.js';
import {
  adminListGenres, createGenre, updateGenre, deleteGenre, reorderGenres,
} from '../controllers/adminGenreController.js';
import {
  listSeasons, createSeason, updateSeason, deleteSeason,
  listEpisodes, createEpisode, updateEpisode, deleteEpisode, bulkCreateEpisodes, reorderEpisodes,
} from '../controllers/adminEpisodeController.js';
import {
  listUsers, getUserDetail, suspendUser, changeUserRole, deleteUser, activityLog, adminResetPassword, createAdmin,
} from '../controllers/adminUserController.js';
import { getSettings, updateSettings } from '../controllers/adminSettingsController.js';
import { topTitles, exportCsv } from '../controllers/adminAnalyticsController.js';
import { listPlaybackReports, updatePlaybackReportStatus } from '../controllers/adminSupportController.js';
import { listRatings, deleteRating } from '../controllers/adminRatingController.js';
import {
  adminTmdbCatalog, adminTmdbOverrides, adminTmdbOverrideSave, adminTmdbOverrideDelete,
  adminTmdbOverridesRestore,
} from '../controllers/adminTmdbController.js';
import { protect, isAdmin, isSuperAdmin } from '../middleware/auth.js';
import { adminListPayments, adminUpdatePaymentStatus } from '../controllers/paymentController.js';

const router = express.Router();
router.use(protect, isAdmin); // everything below requires an admin role (RBAC)

// Dashboard
router.get('/dashboard', dashboard);

// Titles
router.get('/titles', adminListTitles);
router.post('/titles/bulk-csv', bulkImportCsv); // must be above any conflicting route
router.post('/titles', createTitle);
router.post('/titles/:id/duplicate', duplicateTitle);
router.put('/titles/:id', updateTitle);
router.delete('/titles/:id', isSuperAdmin, deleteTitle);
router.put('/titles/:id/flags', toggleFlags);

// Video link resolver — powers the in-panel preview player (admin only)
router.get('/video/resolve', resolveVideoLink);
router.get('/video/embeddable', checkEmbeddable);

// Genres
router.get('/genres', adminListGenres);
router.post('/genres', createGenre);
router.put('/genres/reorder', reorderGenres); // must be above /genres/:id
router.put('/genres/:id', updateGenre);
router.delete('/genres/:id', isSuperAdmin, deleteGenre);

// Seasons & Episodes
router.get('/titles/:id/seasons', listSeasons);
router.post('/titles/:id/seasons', createSeason);
router.put('/seasons/:id', updateSeason);
router.delete('/seasons/:id', deleteSeason);
router.get('/seasons/:id/episodes', listEpisodes);
router.post('/seasons/:id/episodes/bulk', bulkCreateEpisodes);
router.put('/seasons/:id/episodes/reorder', reorderEpisodes);
router.post('/seasons/:id/episodes', createEpisode);
router.put('/episodes/:id', updateEpisode);
router.delete('/episodes/:id', deleteEpisode);

// Users (super-admin only for moderation actions)
router.post('/users/create-admin', isSuperAdmin, createAdmin); // must be above /users/:id
router.get('/users', listUsers);
router.get('/users/:id', getUserDetail);
router.put('/users/:id/suspend', isSuperAdmin, suspendUser);
router.put('/users/:id/role', isSuperAdmin, changeUserRole);
router.put('/users/:id/reset-password', isSuperAdmin, adminResetPassword);
router.delete('/users/:id', isSuperAdmin, deleteUser);

// Activity log (super-admin)
router.get('/activity-log', isSuperAdmin, activityLog);

// Site settings (SRS §6.10) — read for any admin, update super-admin only
router.get('/settings', getSettings);
router.put('/settings', isSuperAdmin, updateSettings);

// Analytics (SRS §6.11)
router.get('/analytics/top-titles', topTitles);
router.get('/analytics/export', exportCsv);

// Ratings moderation (SRS §6.9)
router.get('/ratings', listRatings);
router.delete('/ratings/:id', deleteRating);

// Support tickets — playback reports filed from the user player (SRS §24 Admin 32)
router.get('/reports', listPlaybackReports);
router.put('/reports/:id/status', updatePlaybackReportStatus);

// Payment records from the signup checkout
router.get('/payments', adminListPayments);
router.put('/payments/:id/status', isSuperAdmin, adminUpdatePaymentStatus);

// TMDB catalogue — browse the live TMDB movies/series/dramas and edit their
// artwork & metadata (edits are stored as overrides and served on the site)
router.get('/tmdb/catalog', adminTmdbCatalog);
router.get('/tmdb/overrides', adminTmdbOverrides);
router.put('/tmdb/overrides', adminTmdbOverrideSave);
router.post('/tmdb/overrides/restore', adminTmdbOverridesRestore);
router.delete('/tmdb/overrides/:mediaType/:tmdbId', adminTmdbOverrideDelete);

export default router;
