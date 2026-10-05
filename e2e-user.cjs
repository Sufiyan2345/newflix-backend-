// Creates a throwaway verified user + profile for browser E2E tests (same pattern as e2e_test.mjs)
import 'dotenv/config';
import mongoose from 'mongoose';
import User from './models/User.js';
import Profile from './models/Profile.js';

const EMAIL = 'e2e-browser@streamflix.test';
await mongoose.connect(process.env.MONGO_URI);
let u = await User.findOne({ email: EMAIL });
if (!u) u = await User.create({ name: 'Browser E2E', email: EMAIL, password: 'Tester@12345', isEmailVerified: true });
await Profile.deleteMany({ user: u._id });
const p = await Profile.create({ user: u._id, name: 'E2E' });
console.log('USER_ID=' + u._id);
console.log('PROFILE_ID=' + p._id);
await mongoose.disconnect();
