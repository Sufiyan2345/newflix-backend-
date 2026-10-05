import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
const users = mongoose.connection.collection('users');
const email = 'e2e-browser@streamflix.test';
const hash = await bcrypt.hash('Tester@12345', 10);
const r = await users.updateOne(
  { email },
  { $set: { password: hash, role: 'user' }, $setOnInsert: { name: 'E2E Browser', createdAt: new Date() } },
  { upsert: true },
);
const u = await users.findOne({ email });
// ensure at least one profile so the profile gate lets us through
const prof = mongoose.connection.collection('profiles');
const existing = await prof.findOne({ user: u._id });
if (!existing) {
  await prof.insertOne({ user: u._id, name: 'Ahmed', avatar: 'https://api.dicebear.com/9.x/bottts/svg?seed=ahmed', maturityRating: '18+', language: 'English', autoplayNext: true, autoplayPreviews: true, createdAt: new Date() });
  console.log('profile created');
} else { console.log('profile exists:', existing.name); }
console.log('user upserted:', u.email, 'modified:', r.modifiedCount, 'upserted:', r.upsertedCount);
await mongoose.disconnect();
