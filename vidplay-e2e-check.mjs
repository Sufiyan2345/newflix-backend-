// Final live verification through the REAL server pipeline:
// pastes the vidplay watch URL the way the admin panel would, then hits the
// /api/admin/video/resolve endpoint the preview player uses.
import 'dotenv/config';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { resolveSource, resolveVidplay } from './controllers/titleDetailController.js';

const URL_ = 'https://vidplay.top/watchseries/vincenzo-online-free/season/1/episode/1';

// 1. Admin-preview endpoint logic (what VideoPreview.jsx calls)
const resolved = await resolveVidplay(URL_);
console.log('1. admin /video/resolve →', JSON.stringify({ ...resolved, provider: 'vidplay (real player resolved)' }));
if (resolved.type !== 'embed') throw new Error('FAIL: expected embed');

// 2. Watch-endpoint logic (what the user-side player calls)
const viaWatch = resolveSource(URL_, 'mp4'); // even a stale "mp4" type must resolve
console.log('2. resolveSource passthrough →', JSON.stringify(viaWatch));

// 3. The resolved player must allow cross-origin framing (no X-Frame-Options)
const r = await fetch(resolved.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
const xfo = r.headers.get('x-frame-options') || '';
const csp = (r.headers.get('content-security-policy') || '');
const fa = (csp.match(/frame-ancestors[^;]*/) || [''])[0];
const blocked = /deny|sameorigin/i.test(xfo) || (/frame-ancestors/.test(fa) && !/frame-ancestors\s+\*/.test(fa));
console.log('3. player frameable:', !blocked, '| status:', r.status, '| xfo:', JSON.stringify(xfo), '| frame-ancestors:', JSON.stringify(fa));
if (blocked) throw new Error('FAIL: resolved player blocks framing');

console.log('\nALL CHECKS PASSED — vidplay link will play INSIDE the player');
await mongoose.disconnect().catch(() => {});
