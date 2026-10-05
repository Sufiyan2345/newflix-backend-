import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import mongoSanitize from 'express-mongo-sanitize';
import connectDB from './config/db.js';
import User from './models/User.js';
import Genre from './models/Genre.js';
import SiteSettings from './models/SiteSettings.js';
import { apiLimiter } from './middleware/rateLimiters.js';

import authRoutes from './routes/authRoutes.js';
import publicRoutes from './routes/publicRoutes.js';
import userRoutes from './routes/userRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import uploadRoutes from './routes/uploadRoutes.js';
import paymentRoutes from './routes/paymentRoutes.js';

const app = express();
app.set('trust proxy', 1);

// ================= SECURITY HEADERS =================
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow Cloudinary/streaming media
  contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false,
  // helmet's default is `no-referrer`, which strips the Referer header. Embedded
  // players (YouTube et al.) require a Referer — without it YouTube fails with
  // "Error 153: Video player configuration error". Use YouTube's recommended policy.
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());
// Prevent NoSQL injection ($gt, $ne operators in body/query)
app.use((req, res, next) => {
  const sanitize = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    for (const key of Object.keys(obj)) {
      if (key.startsWith('$') || key.includes('.')) delete obj[key];
      else sanitize(obj[key]);
    }
    return obj;
  };
  sanitize(req.body); sanitize(req.query); sanitize(req.params);
  next();
});
app.use(mongoSanitize());

// ================= CORS (whitelist) =================
const allowedOrigins = [process.env.CLIENT_URL, process.env.ADMIN_URL].filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// ================= RATE LIMITING =================
app.use('/api', apiLimiter);

// ================= HEALTH =================
app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'streamflix-api' }));

// ================= ROUTES =================
app.use('/api/auth', authRoutes);
app.use('/api', publicRoutes);
app.use('/api/user', userRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/user', paymentRoutes); // checkout payment records (mounted on /api/user to reuse auth)

// 404
app.use((req, res) => res.status(404).json({ message: 'Route not found' }));

// Global error handler (never leak stack traces to clients)
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(err.status || 500).json({ message: err.message || 'Internal server error' });
});

// ================= SEEDS =================
const DEFAULT_GENRES = [
  'Action', 'Adventure', 'Comedy', 'Drama', 'Horror', 'Thriller', 'Romance',
  'Sci-Fi', 'Crime', 'Documentary', 'Korean Dramas', 'Anime', 'Mystery', 'Fantasy',
];

const bootstrap = async () => {
  // Super admin from env
  const saEmail = process.env.SUPER_ADMIN_EMAIL;
  const saPass = process.env.SUPER_ADMIN_PASSWORD;
  if (saEmail && saPass) {
    const exists = await User.findOne({ email: saEmail.toLowerCase() });
    if (!exists) {
      await User.create({
        name: 'Super Admin', email: saEmail.toLowerCase(),
        password: saPass, role: 'super-admin', isEmailVerified: true,
      });
      console.log(`👑 Super admin created: ${saEmail}`);
    }
  }
  // Default genres
  const gCount = await Genre.countDocuments();
  if (gCount === 0) {
    await Genre.insertMany(DEFAULT_GENRES.map((name, i) => ({ name, slug: name.toLowerCase().replace(/\s+/g, '-'), order: i })));
    console.log('🎬 Default genres seeded');
  }
  // Site settings
  if (!(await SiteSettings.findOne())) await SiteSettings.create({});
};

const PORT = process.env.PORT || 5000;

// Safety net — log unhandled errors instead of crashing
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

connectDB().then(async () => {
  await bootstrap();
  const server = app.listen(PORT, () =>
    console.log(`🚀 StreamFlix API running on http://localhost:${PORT} [${process.env.NODE_ENV || 'development'}]`));
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. The backend may already be running.`);
      process.exit(0);
    }
    console.error('Server failed to start:', err.message);
    process.exit(1);
  });
}).catch((err) => {
  console.error('MongoDB connection failed:', err.message);
  process.exit(1);
});
