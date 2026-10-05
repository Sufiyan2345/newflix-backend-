// Read-only DB inspection: what video sources exist right now?
import mongoose from 'mongoose';
import 'dotenv/config';

const { MONGO_URI } = process.env;
await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15000 });

const Title = mongoose.connection.collection('titles');
const Episode = mongoose.connection.collection('episodes');

const titles = await Title.find({}, { projection: { title: 1, videoUrl: 1, videoSourceType: 1, status: 1, type: 1 } }).sort({ _id: -1 }).limit(15).toArray();
console.log('=== TITLES (newest 15) ===');
for (const t of titles) console.log(`${t._id} | ${t.status} | ${t.type} | src=${t.videoSourceType} | ${String(t.videoUrl).slice(0, 90)}`);

const eps = await Episode.find({}, { projection: { videoUrl: 1, videoSourceType: 1, status: 1, title: 1 } }).sort({ _id: -1 }).limit(10).toArray();
console.log('=== EPISODES (newest 10) ===');
for (const e of eps) console.log(`${e._id} | title=${e.title} | ${e.status} | src=${e.videoSourceType} | ${String(e.videoUrl).slice(0, 80)}`);

await mongoose.disconnect();