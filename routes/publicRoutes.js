import express from 'express';
import {
  listTitles, homeFeed,
} from '../controllers/titleController.js';
import {
  searchTitles, getTitleBySlug, getWatchData, listGenres,
} from '../controllers/titleDetailController.js';
import { optionalAuth, protect } from '../middleware/auth.js';
import { profileContext } from '../middleware/profileContext.js';
import { getPublicSettings } from '../controllers/adminSettingsController.js';
import { speedTest } from '../controllers/speedTestController.js';
import { getTitleRating, rateTitle, unrateTitle } from '../controllers/userRatingController.js';
import { tmdbHome, tmdbSearch, tmdbDetail, tmdbTrailer, tmdbTitleMedia, tmdbSeason, tmdbWatch, tmdbMovieWatch, tmdbBrowse, tmdbExplore, tmdbGenreCards, tmdbKids, tmdbNewPopular, tmdbOnlyOnNetflix } from '../controllers/tmdbController.js';

const router = express.Router();

router.get('/titles', optionalAuth, profileContext, listTitles);
// profileContext on the feed: it is what makes the rails viewer-specific and what
// lets a Kids profile receive only kid-safe rows.
router.get('/titles/home', optionalAuth, profileContext, homeFeed);
router.get('/tmdb/home', optionalAuth, profileContext, tmdbHome);
router.get('/tmdb/browse/:type', optionalAuth, profileContext, tmdbBrowse);
// The public "Only on Netflix" marketing page (footer link). Public on purpose:
// the footer prints that link on the landing page too, where nobody is signed in.
router.get('/tmdb/only-on-netflix', optionalAuth, profileContext, tmdbOnlyOnNetflix);
router.get('/tmdb/explore/:type', optionalAuth, profileContext, tmdbExplore);
// The navbar KIDS button. profileContext is here for the same reason as
// /tmdb/home: the active profile still decides what the member may play.
router.get('/tmdb/kids', optionalAuth, profileContext, tmdbKids);
// The navbar "New & Popular" button. Same profileContext reason as /tmdb/home:
// the active profile still decides what the member may play.
router.get('/tmdb/new-popular', optionalAuth, profileContext, tmdbNewPopular);
router.get('/tmdb/search', optionalAuth, profileContext, tmdbSearch);
router.get('/tmdb/detail/:type/:id', optionalAuth, profileContext, tmdbDetail);
// Lazily fetched by the hover preview card. profileContext keeps the kids gate
// consistent with /tmdb/detail so a kids profile cannot pull a trailer for a
// title it is not allowed to see.
router.get('/tmdb/trailer/:type/:id', optionalAuth, profileContext, tmdbTrailer);
// Title treatment + the full teaser/trailer list, used ONLY by the public title
// page a card on /p/only-on-netflix opens. Additive on purpose: /tmdb/detail is
// untouched, so the member modal's payload and every rail stay exactly as they
// were. optionalAuth/profileContext keep the route on the same footing as the
// trailer lookup beside it.
router.get('/tmdb/title-media/:type/:id', optionalAuth, profileContext, tmdbTitleMedia);
router.get('/tmdb/season/:id/:season', optionalAuth, profileContext, tmdbSeason);
router.get('/tmdb/tv/:id/watch', protect, profileContext, tmdbWatch);
router.get('/tmdb/movie/:id/watch', protect, profileContext, tmdbMovieWatch);
router.get('/tmdb/genre-cards', optionalAuth, tmdbGenreCards);
router.get('/titles/search', optionalAuth, profileContext, searchTitles);
router.get('/titles/:slug', optionalAuth, profileContext, getTitleBySlug);
router.get('/titles/:id/watch', protect, profileContext, getWatchData); // login required to play (SRS configurable)
router.get('/titles/:id/rating', protect, profileContext, getTitleRating);
router.post('/titles/:id/rate', protect, profileContext, rateTitle); // user rating 1-10 (SRS §4.5/§6.9)
router.delete('/titles/:id/rate', protect, profileContext, unrateTitle); // remove own rating (reversible "like")
router.get('/genres', listGenres);
router.get('/settings', getPublicSettings); // branding + static pages for the user site (SRS §6.10)
// Backs the footer's "Speed Test" link: the page times a real transfer of this
// stream rather than printing a made-up number. Public on purpose — a member
// running a speed test is exactly who should be able to reach it.
router.get('/speed-test', speedTest);

export default router;
