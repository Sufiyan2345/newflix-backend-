import 'dotenv/config';
import mongoose from 'mongoose';
import Title from './models/Title.js';
import Genre from './models/Genre.js';

await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });

// id passed -> delete mode
const delId = process.argv[2];
if (delId) {
  await Title.deleteOne({ _id: delId });
  console.log('DELETED', delId);
} else {
  const g = await Genre.findOne().lean();
  const t = await Title.create({
    title: 'QA Playback Test (auto-removed)',
    slug: `qa-playback-test-${Date.now()}`,
    type: 'movie',
    status: 'published',
    releaseYear: 2026,
    ageRating: 'ALL',
    description: 'Temporary QA title used to verify native MP4 playback end-to-end.',
    posterUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/BigBuckBunny.jpg',
    bannerUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/BigBuckBunny.jpg',
    genres: g ? [g._id] : [],
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    videoSourceType: 'mp4',
    durationMinutes: 10,
  });
  console.log('CREATED', t._id.toString());
}
await mongoose.disconnect();
