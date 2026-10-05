import crypto from 'crypto';

// Signed expiring stream URLs — raw video links can't be freely shared (SRS §12)
// Format: <baseUrl>?exp=<unix>&sig=<hmac>
export const signVideoUrl = (baseUrl, { ttlMinutes = 120, profileId = '' } = {}) => {
  try {
    const url = new URL(baseUrl);
    if (url.protocol.startsWith('blob:') || url.hostname.includes('cloudinary.com')) {
      // Cloudinary URLs are already protected by their own delivery config;
      // we still add a short-lived signature query for defense-in-depth.
      const exp = Math.floor(Date.now() / 1000) + ttlMinutes * 60;
      const payload = `${url.pathname}:${exp}:${profileId}`;
      const sig = crypto
        .createHmac('sha256', process.env.SIGNED_URL_SECRET || 'fallback-secret')
        .update(payload)
        .digest('hex')
        .slice(0, 32);
      url.searchParams.set('exp', exp);
      url.searchParams.set('sig', sig);
      return url.toString();
    }
    return baseUrl; // external CDNs handle their own signatures
  } catch {
    return baseUrl;
  }
};

export const verifyVideoSignature = (req) => {
  const { exp, sig } = req.query;
  if (!exp || !sig) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const payload = `${req.path}:${exp}:${req.query.pid || ''}`;
  const expected = crypto
    .createHmac('sha256', process.env.SIGNED_URL_SECRET || 'fallback-secret')
    .update(payload)
    .digest('hex')
    .slice(0, 32);
  return sig === expected;
};
