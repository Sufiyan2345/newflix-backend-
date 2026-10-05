// Focused end-to-end check for two features:
//
//  A) Viewer-specific home feed — two profiles of the SAME account must get
//     measurably different rails, and each must be stable across reloads.
//  B) Kids profile — must receive only kid-safe titles, and the watch endpoint
//     must refuse grown-up content even when the URL is pasted directly.
//
// Creates its own user + profiles + titles, then deletes them.
import 'dotenv/config';
import mongoose from 'mongoose';
import User from './models/User.js';
import Profile from './models/Profile.js';
import Title from './models/Title.js';
import Season from './models/Season.js';
import Episode from './models/Episode.js';
import WatchHistory from './models/WatchHistory.js';

const BASE = 'http://localhost:5000/api';
let pass = 0, fail = 0;
const J = (x) => JSON.stringify(x ?? null).slice(0, 240);
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};

const req = async (method, path, { token, body, profile } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (profile) headers['x-profile-id'] = profile;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch { /* no body */ }
  return { status: r.status, data: data ?? {} };
};

const EMAIL = 'e2e-kids@streamflix.test';
const created = { titleIds: [], userId: null };
const unique = Date.now();

const MK = (over) => ({
  type: 'movie',
  description: 'Kids maturity fixture.',
  posterUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
  videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
  videoSourceType: 'mp4',
  language: 'English',
  releaseYear: 2024,
  status: 'published',
  viewCount: 500,
  ...over,
});

// A spread of certificates so the maturity gate has something to bite on.
const KID_TITLES = [
  { title: `K Cartoon ${unique}`, ageRating: '7+', isKids: true, isTrending: true, isTop10: true },
  { title: `K Family ${unique}`, ageRating: 'ALL', isTrending: true },
  // The interesting case: a cartoon certified 13+, reachable only via the flag.
  { title: `K Animation ${unique}`, ageRating: '13+', isKids: true, isTrending: true, isTop10: true },
  { title: `K Teen ${unique}`, ageRating: '13+', isTrending: true, isTop10: true },
  { title: `K Adult ${unique}`, ageRating: '18+', isTrending: true, isTop10: true },
];

// A big pool of ordinary adult titles so the "different rails" check has room to
// differ — with only a handful of titles every viewer would see the same ones.
const filler = Array.from({ length: 40 }, (_, i) => MK({
  title: `ZZ Filler ${unique}-${i}`,
  slug: `zz-filler-${unique}-${i}`,
  ageRating: '18+', isTrending: true, isTop10: true, viewCount: 1000 - i,
}));

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

await mongoose.connect(process.env.MONGO_URI);

let user = await User.findOne({ email: EMAIL });
if (!user) user = await User.create({ name: 'Kids E2E', email: EMAIL, password: 'Tester@12345', isEmailVerified: true });
created.userId = user._id;
await Profile.deleteMany({ user: user._id });

const adult = await Profile.create({ user: user._id, name: 'Adult P', maturityLimit: '18+' });
const kids = await Profile.create({ user: user._id, name: 'Kids P', isKidsProfile: true, maturityLimit: 'ALL' });
const third = await Profile.create({ user: user._id, name: 'Third P', maturityLimit: '18+' });

const docs = await Title.create([
  ...KID_TITLES.map((t) => MK({ ...t, slug: slugify(t.title) })),
  ...filler,
]);
created.titleIds = docs.map((d) => d._id);
const byTitle = (name) => docs.find((d) => d.title.startsWith(name));
const adult18 = byTitle('K Adult');
const kidFlagged13 = byTitle('K Animation');
const kid7 = byTitle('K Cartoon');

let token = null;

try {
  const login = await req('POST', '/auth/login', { body: { email: EMAIL, password: 'Tester@12345' } });
  ok('login', login.status === 200 && !!login.data.accessToken, J(login.data));
  token = login.data.accessToken;

  // ---------- A) viewer-specific feed ----------
  const idsOf = (feed) => (feed.rows || [])
    .map((row) => `${row.key}:${(row.items || []).map((i) => i._id).join(',')}`).join('|');

  const a1 = await req('GET', '/titles/home', { token, profile: String(adult._id) });
  const a2 = await req('GET', '/titles/home', { token, profile: String(adult._id) });
  const b1 = await req('GET', '/titles/home', { token, profile: String(kids._id) });
  const c1 = await req('GET', '/titles/home', { token, profile: String(third._id) });

  ok('home feed 200 (adult)', a1.status === 200, `got ${a1.status} ${J(a1.data)}`);
  ok('home feed 200 (kids)', b1.status === 200, `got ${b1.status} ${J(b1.data)}`);
  ok('same profile is STABLE across reloads', idsOf(a1.data) === idsOf(a2.data));
  ok('two adult profiles get DIFFERENT rails', idsOf(a1.data) !== idsOf(c1.data));
  ok('adult vs kids feed differ', idsOf(a1.data) !== idsOf(b1.data));

  // ---------- B) kids filtering ----------
  const kidsItems = (b1.data.rows || []).flatMap((row) => row.items || []);
  const kidIds = new Set(kidsItems.map((i) => String(i._id)));
  const adultIds = new Set((a1.data.rows || []).flatMap((x) => x.items || []).map((i) => String(i._id)));

  ok('kids feed is not empty', kidIds.size > 0, `size=${kidIds.size}`);
  ok('kids CAN see its 7+ cartoon', kidIds.has(String(kid7._id)));
  ok('kids CAN see a 13+ title flagged isKids', kidIds.has(String(kidFlagged13._id)));
  ok('kids CANNOT see the 18+ title', !kidIds.has(String(adult18._id)));
  ok('adult CAN see the 18+ title', adultIds.has(String(adult18._id)));
  ok('no disallowed title leaked into the kids payload',
    !kidsItems.some((i) => i.ageRating === '18+' && !i.isKids));
  ok('viewer.isKids reported for kids profile', b1.data.viewer?.isKids === true, J(b1.data.viewer));
  ok('viewer.isKids false for adult', a1.data.viewer?.isKids === false, J(a1.data.viewer));

  // ---------- B2) the real gates ----------
  const w1 = await req('GET', `/titles/${adult18._id}/watch`, { token, profile: String(kids._id) });
  ok('kids WATCH on 18+ title is refused (403)', w1.status === 403, `got ${w1.status} ${J(w1.data)}`);

  const w2 = await req('GET', `/titles/${adult18._id}/watch`, { token, profile: String(adult._id) });
  ok('adult WATCH on same title is allowed', w2.status === 200, `got ${w2.status} ${J(w2.data)}`);

  const w3 = await req('GET', `/titles/${kidFlagged13._id}/watch`, { token, profile: String(kids._id) });
  ok('kids WATCH on isKids 13+ title is allowed', w3.status === 200, `got ${w3.status} ${J(w3.data)}`);

  const d1 = await req('GET', `/titles/${adult18.slug}`, { token, profile: String(kids._id) });
  ok('kids DETAIL page for 18+ title is 404', d1.status === 404, `got ${d1.status}`);

  const d2 = await req('GET', `/titles/${kid7.slug}`, { token, profile: String(kids._id) });
  ok('kids DETAIL page for own title is 200', d2.status === 200, `got ${d2.status}`);

  const s1 = await req('GET', '/titles/search?q=Adult', { token, profile: String(kids._id) });
  ok('kids SEARCH does not return the 18+ title',
    !(s1.data.items || []).some((i) => String(i._id) === String(adult18._id)), J(s1.data));

  const l1 = await req('GET', '/titles?limit=60', { token, profile: String(kids._id) });
  ok('kids BROWSE list excludes the 18+ title',
    !(l1.data.items || []).some((i) => String(i._id) === String(adult18._id)));
  ok('kids BROWSE list includes the flagged 13+ cartoon',
    (l1.data.items || []).some((i) => String(i._id) === String(kidFlagged13._id)));
} catch (err) {
  fail++;
  console.log(`FAIL  harness error: ${err.message}`);
} finally {
  try {
    await Episode.deleteMany({ series: { $in: created.titleIds } });
    await Season.deleteMany({ title: { $in: created.titleIds } });
    await WatchHistory.deleteMany({ title: { $in: created.titleIds } });
    await Title.deleteMany({ _id: { $in: created.titleIds } });
    if (created.userId) {
      await Profile.deleteMany({ user: created.userId });
      await User.deleteOne({ _id: created.userId });
    }
    console.log('cleanup: removed test titles + profiles + user');
  } catch (e) { console.log('cleanup failed:', e.message); }
  await mongoose.disconnect();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

