// Throw-away probe: which emails already have a (verified) account in Mongo?
// The landing "Get Started" button only mails a sign-up link for addresses that
// do NOT already have a verified account (the API answers 409 otherwise), so this
// tells you which address to type in the box.
import dotenv from 'dotenv';
import mongoose from 'mongoose';

// load backend/.env no matter which directory this probe is launched from
dotenv.config({ path: new URL('./.env', import.meta.url) });

const uri = process.env.MONGO_URI;
if (!uri) {
  console.log('no MONGO_URI in backend/.env');
  process.exit(1);
}
await mongoose.connect(uri);
const users = await mongoose.connection.db
  .collection('users')
  .find({}, { projection: { email: 1, isEmailVerified: 1, createdAt: 1 } })
  .sort({ createdAt: -1 })
  .limit(25)
  .toArray();
console.log(`users: ${users.length}`);
users.forEach((u) => console.log(`  ${u.email} | verified=${u.isEmailVerified} | ${u.createdAt ? new Date(u.createdAt).toISOString() : ''}`));
const otps = await mongoose.connection.db
  .collection('otps')
  .find({}, { projection: { email: 1, purpose: 1, consumed: 1, createdAt: 1 } })
  .sort({ createdAt: -1 })
  .limit(8)
  .toArray();
console.log('\nrecent OTP records:');
otps.forEach((o) => console.log(`  ${o.email} | ${o.purpose} | consumed=${o.consumed} | ${o.createdAt ? new Date(o.createdAt).toISOString() : ''}`));
await mongoose.disconnect();
