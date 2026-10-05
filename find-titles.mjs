import 'dotenv/config';
import mongoose from 'mongoose';
import Title from './models/Title.js';

await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
const titles = await Title.find({ videoUrl: { $exists: true, $ne: '' } }).select('title slug videoUrl videoSourceType status').lean();
const interesting = titles.filter((t) => /youtube|youtu\.be|zenox|nebula|videasy|\.mp4|\.m3u8/i.test(t.videoUrl || ''));
for (const t of interesting.slice(0, 20)) {
  console.log(`${t.status} | ${t._id} | ${t.slug} | ${t.videoSourceType || '-'} | ${String(t.videoUrl).slice(0, 80)}`);
}
console.log('TOTAL with videoUrl:', titles.length, '| matching:', interesting.length);
await mongoose.disconnect();
