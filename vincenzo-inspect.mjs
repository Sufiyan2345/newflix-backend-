// Read-only: what does Vincenzo have in the DB right now?
import mongoose from 'mongoose';
import 'dotenv/config';

const { MONGO_URI } = process.env;
await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15000 });

const titles = mongoose.connection.collection('titles');
const eps = mongoose.connection.collection('episodes');

const title = await titles.findOne({ title: /vincenzo/i }, { projection: { title: 1, type: 1, status: 1 } });
console.log('TITLE:', title ? `${title._id} | ${title.title} | type=${title.type} | status=${title.status}` : 'NOT FOUND');

if (title) {
  const list = await eps.find({ series: title._id }).sort({ episodeNumber: 1 }).toArray();
  console.log(`EPISODES for this title: ${list.length}`);
  for (const e of list) {
    console.log(`E${e.episodeNumber} | status=${e.status} | hasVideo=${Boolean(e.videoUrl)} | src=${e.videoSourceType || '-'} | ${String(e.videoUrl || '').slice(0, 70)} | "${e.title}"`);
  }
}

await mongoose.disconnect();
