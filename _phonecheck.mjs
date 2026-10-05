// Throw-away, READ-ONLY: is the SMS-OTP test number registered, and are phones
// stored as E.164? Usage: Push-Location backend; node _phonecheck.mjs
import 'dotenv/config';
import mongoose from 'mongoose';

const uri = process.env.MONGO_URI;
if (!uri) { console.log('MONGO_URI missing'); process.exit(1); }
await mongoose.connect(uri);
const users = mongoose.connection.collection('users');

console.log('total users      :', await users.countDocuments());
console.log('users with phone :', await users.countDocuments({ phone: { $exists: true, $ne: null } }));

const test = await users.find({ phone: /3136498769$/ })
  .project({ name: 1, email: 1, phone: 1, phoneVerified: 1, role: 1 }).toArray();
console.log('matches for +923136498769:', JSON.stringify(test, null, 1));

const sample = await users.find({ phone: { $exists: true, $ne: null } })
  .project({ phone: 1 }).limit(8).toArray();
console.log('stored phone samples:', JSON.stringify(sample));

await mongoose.disconnect();
