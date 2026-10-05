import 'dotenv/config';
import cloudinary from './config/cloudinary.js';

// Quick self-test: uploads a 1x1 px PNG to Cloudinary and prints the REAL result.
// Run:  node test_cloudinary.mjs
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

try {
  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'streamflix/posters', resource_type: 'image' },
      (err, r) => (err ? reject(err) : resolve(r))
    );
    stream.end(PNG_1PX);
  });
  console.log('✅ CLOUDINARY IS WORKING — uploaded:', result.secure_url);
  process.exit(0);
} catch (err) {
  console.log('❌ CLOUDINARY UPLOAD FAILED:', err?.message || err);
  if (String(err?.message).toLowerCase().includes('api key')) {
    console.log('→ Your CLOUDINARY_API_KEY in backend/.env is wrong. Copy the numeric API Key from https://console.cloudinary.com → Settings → Access Keys, paste it on the CLOUDINARY_API_KEY line, save, restart the backend, and run this test again.');
  }
  process.exit(1);
}