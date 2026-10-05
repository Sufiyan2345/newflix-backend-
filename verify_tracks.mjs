// Live end-to-end check: an admin creates a published title carrying the new fields
// (logoUrl, tagline, audioLanguages, audioTracks, subtitleTracks), the public API must
// return every one of them, the update path must stick, then the script deletes the
// test title — leaving the database exactly as it was.
const BASE = 'http://localhost:5000/api';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};
const req = async (method, path, { token, body } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data: data ?? {} };
};

const login = await req('POST', '/auth/login', { body: { email: 'admin@streamflix.com', password: 'Admin@12345' } });
ok('admin login', login.status === 200 && !!login.data.accessToken, JSON.stringify(login.data).slice(0, 120));
const at = login.data.accessToken;
if (!at) process.exit(1);

const payload = {
  type: 'movie', title: 'ZZZ Verify Tracks (auto-delete)', status: 'published',
  description: 'Temporary title created by verify_tracks.mjs and deleted right after.',
  posterUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
  videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
  videoSourceType: 'mp4', releaseYear: 2026, language: 'English', ageRating: '13+',
  logoUrl: 'https://res.cloudinary.com/demo/image/upload/logo.png',
  tagline: 'Watch in Tamil, Telugu, Hindi, Malayalam',
  audioLanguages: ['Tamil', 'Telugu', 'Hindi'],
  audioTracks: [{ language: 'Hindi', label: 'Hindi 5.1', url: 'https://example.com/hindi.m3u8' }],
  subtitleTracks: [{ language: 'English', label: 'English CC', url: 'https://example.com/en.vtt', isDefault: true }],
};

const created = await req('POST', '/admin/titles', { token: at, body: payload });
const cTitle = created.data?.title || created.data?.item || created.data;
const id = cTitle?._id;
ok('admin create (with tracks)', (created.status === 200 || created.status === 201) && !!id, JSON.stringify(created.data).slice(0, 160));

if (id) {
  const pub = await req('GET', `/titles/${cTitle.slug}`);
  const t = pub.data?.title || {};
  ok('public detail returns title', pub.status === 200 && !!t._id, `status=${pub.status}`);
  ok('logoUrl round-trip', t.logoUrl === payload.logoUrl, String(t.logoUrl));
  ok('tagline round-trip', t.tagline === payload.tagline, String(t.tagline));
  ok('audioLanguages round-trip', JSON.stringify(t.audioLanguages || []) === JSON.stringify(payload.audioLanguages), JSON.stringify(t.audioLanguages));
  ok('audioTracks round-trip (real URL)', t.audioTracks?.[0]?.url === payload.audioTracks[0].url, JSON.stringify(t.audioTracks));
  ok('subtitleTracks round-trip + default flag', t.subtitleTracks?.[0]?.url === payload.subtitleTracks[0].url && t.subtitleTracks?.[0]?.isDefault === true, JSON.stringify(t.subtitleTracks));

  const upd = await req('PUT', `/admin/titles/${id}`, { token: at, body: { tagline: 'Updated tagline live' } });
  const pub2 = await req('GET', `/titles/${cTitle.slug}`);
  ok('admin update reflects publicly', upd.status === 200 && pub2.data?.title?.tagline === 'Updated tagline live', String(pub2.data?.title?.tagline));

  const del = await req('DELETE', `/admin/titles/${id}`, { token: at });
  ok('cleanup delete (super-admin)', del.status === 200 || del.status === 204 || del.status === 404, `status=${del.status}`);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);