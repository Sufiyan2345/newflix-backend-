import { v2 as cloudinary } from 'cloudinary';

const getCloudinaryConfigFromUrl = () => {
  const url = process.env.CLOUDINARY_URL;
  if (!url) return null;

  try {
    const parsed = new URL(url);
    return {
      cloud_name: parsed.hostname || '',
      api_key: parsed.username || '',
      api_secret: parsed.password || '',
    };
  } catch {
    return null;
  }
};

const sanitizeValue = (val) => String(val || '').trim();
const cloudinaryApiKey = sanitizeValue(process.env.CLOUDINARY_API_KEY);
const cloudinaryApiSecret = sanitizeValue(process.env.CLOUDINARY_API_SECRET);
const cloudinaryUrlConfig = getCloudinaryConfigFromUrl();
const cloudConfig = {
  cloud_name: sanitizeValue(process.env.CLOUDINARY_CLOUD_NAME) || cloudinaryUrlConfig?.cloud_name || '',
  api_key: cloudinaryApiKey || cloudinaryUrlConfig?.api_key || '',
  api_secret: cloudinaryApiSecret || cloudinaryUrlConfig?.api_secret || '',
  secure: true,
};

const hasPlaceholderCloudinaryValue = [
  cloudinaryApiKey,
  cloudinaryApiSecret,
  process.env.CLOUDINARY_URL || '',
].some((value) =>
  value.includes('<your_') ||
  value.includes('your_actual_') ||
  value.includes('cloudinary://') ||
  value.includes('CLOUDINARY_URL=') ||
  value.toUpperCase().includes('PASTE_YOUR')
);

const keyLooksInvalid = cloudinaryApiKey && !/^\d{10,20}$/.test(cloudinaryApiKey);

if (hasPlaceholderCloudinaryValue || keyLooksInvalid) {
  console.error(
    '❌ CLOUDINARY_API_KEY is invalid. Open https://console.cloudinary.com → Settings → Access Keys, ' +
    'copy the numeric "API Key" and paste it into backend/.env on the CLOUDINARY_API_KEY line, then restart the backend.'
  );
}

if (!cloudConfig.cloud_name || !cloudConfig.api_key || !cloudConfig.api_secret) {
  console.error('Cloudinary configuration is incomplete. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET or CLOUDINARY_URL.');
}

cloudinary.config(cloudConfig);

export const cloudinaryFolder = {
  posters: 'streamflix/posters',
  banners: 'streamflix/banners',
  videos: 'streamflix/videos',
  trailers: 'streamflix/trailers',
  avatars: 'streamflix/avatars',
  thumbnails: 'streamflix/thumbnails',
  logos: 'streamflix/logos', // transparent title wordmarks (hero + detail modal)
};

export default cloudinary;
