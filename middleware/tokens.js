import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Generate access (short-lived) + refresh (long-lived, hashed in DB) tokens
export const generateTokens = (user) => {
  const accessToken = jwt.sign(
    { id: user._id.toString(), role: user.role, email: user.email },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: process.env.JWT_ACCESS_EXPIRES || '7d' }
  );
  const refreshToken = jwt.sign(
    { id: user._id.toString(), v: sha256(user.password).slice(0, 8) },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES || '30d' }
  );
  return { accessToken, refreshToken };
};

export const verifyRefreshToken = (token) =>
  jwt.verify(token, process.env.JWT_REFRESH_SECRET);

export const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  path: '/',
};
