import cloudinary from '../config/cloudinary.js';
import { cloudinaryFolder } from '../config/cloudinary.js';
import streamifier from 'streamifier';
import multer from 'multer';

// Memory storage — stream straight to Cloudinary
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max per file
});

const uploadToCloudinary = (buffer, folder, resourceType) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });

export const uploadMiddleware = upload.single('file');

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedTypes.includes(file.mimetype)) {
      return callback(new Error('Choose a PNG, JPG, WEBP, or GIF image'));
    }
    callback(null, true);
  },
}).single('file');

export const avatarUploadMiddleware = (req, res, next) => {
  avatarUpload(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be 5 MB or smaller' : err.message;
    res.status(400).json({ message });
  });
};

// @route POST /api/upload/profile-image — authenticated member profile avatar
export const uploadProfileImage = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Choose an image to upload' });
    const result = await uploadToCloudinary(req.file.buffer, cloudinaryFolder.avatars, 'image');
    res.json({ url: result.secure_url });
  } catch (err) {
    console.error('uploadProfileImage:', err);
    res.status(500).json({ message: 'Image upload failed. Please try again.' });
  }
};

// @route POST /api/upload/image (admin) — posters, banners, thumbnails, avatars
export const uploadImage = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const kind = req.query.kind || 'posters'; // posters | banners | thumbnails | avatars
    const folder = cloudinaryFolder[kind] || cloudinaryFolder.posters;
    const result = await uploadToCloudinary(req.file.buffer, folder, 'image');
    res.json({
      url: result.secure_url,
      publicId: result.public_id,
      width: result.width,
      height: result.height,
    });
  } catch (err) {
    console.error('uploadImage:', err);
    const message = err?.message || 'Image upload failed';
    const devMessage = process.env.NODE_ENV !== 'production' ? message : undefined;
    res.status(500).json({
      message: 'Image upload failed',
      ...(devMessage ? { detail: devMessage } : {}),
    });
  }
};

// @route POST /api/upload/video (admin) — main videos, trailers, episodes
export const uploadVideo = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const kind = req.query.kind === 'trailers' ? 'trailers' : 'videos';
    const folder = cloudinaryFolder[kind];
    const result = await uploadToCloudinary(req.file.buffer, folder, 'video');
    res.json({
      url: result.secure_url,
      publicId: result.public_id,
      duration: result.duration,
      format: result.format,
      bytes: result.bytes,
      playbackUrl: result.secure_url, // Cloudinary auto-serves HLS: replace /video/upload/ with /video/upload/sp_auto/ for adaptive
      hlsUrl: result.secure_url.replace('/video/upload/', '/video/upload/sp_auto/'),
    });
  } catch (err) {
    console.error('uploadVideo:', err);
    res.status(500).json({ message: 'Video upload failed' });
  }
};
