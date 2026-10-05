import express from 'express';
import { avatarUploadMiddleware, uploadMiddleware, uploadImage, uploadProfileImage, uploadVideo } from '../controllers/uploadController.js';
import { protect, isAdmin } from '../middleware/auth.js';

const router = express.Router();

router.post('/profile-image', protect, avatarUploadMiddleware, uploadProfileImage);

// Catalog media uploads are admin-only; member profile photos use the route above.
router.post('/image', protect, isAdmin, uploadMiddleware, uploadImage);
router.post('/video', protect, isAdmin, uploadMiddleware, uploadVideo);

export default router;
