import 'dotenv/config';
import mongoose from 'mongoose';
import User from './models/User.js';
import Profile from './models/Profile.js';

const BASE = 'http://localhost:5000/api';
let pass = 0, fail = 0;
const J = (x) => JSON.stringify(x ?? null).slice(0, 200); // safe stringify (undefined-safe)
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
  try { data = await r.json(); } catch {}
  return { status: r.status, data: data ?? {} }; // never undefined → keeps assertions safe
};

const TEST_EMAIL = 'e2e-tester@streamflix.test';
const cleanup = { tokens: {}, ids: { titles: [] }, tester: null };

// ---- create a real verified test user (bcrypt via model pre-save hook) ----
await mongoose.connect(process.env.MONGO_URI);
let tester = await User.findOne({ email: TEST_EMAIL });
if (!tester) tester = await User.create({ name: 'E2E Tester', email: TEST_EMAIL, password: 'Tester@12345', isEmailVerified: true });
await Profile.deleteMany({ user: tester._id });
await Profile.create({ user: tester._id, name: 'E2E' });
cleanup.tester = tester._id;
await mongoose.disconnect();

try {
  // ================= ADMIN FLOWS =================
  let r = await req('POST', '/auth/login', { body: { email: 'admin@streamflix.com', password: 'Admin@12345' } });
  ok('admin login (seeded super-admin)', r.status === 200 && !!r.data.accessToken, JSON.stringify(r.data).slice(0, 120));
  const at = r.data.accessToken;

  r = await req('GET', '/admin/dashboard');
  ok('admin route protected without token (401)', r.status === 401, `got ${r.status}`);

  r = await req('POST', '/admin/titles', { token: at, body: {
    type: 'movie', title: 'E2E Test Movie', description: 'Created by automated test',
    posterUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    videoSourceType: 'mp4', releaseYear: 2026, language: 'English', ageRating: '13+',
    status: 'published', isTrending: true, isFeatured: true,
  } });
  ok('admin create movie', r.status === 201 && !!r.data.title?.slug, JSON.stringify(r.data).slice(0, 150));
  const movieId = r.data.title?._id; cleanup.ids.titles.push(String(movieId));

  r = await req('POST', `/admin/titles/${movieId}/duplicate`, { token: at });
  ok('duplicate title (SRS 6.2)', r.status === 201 && /Copy/.test(r.data.title?.title || ''), JSON.stringify(r.data).slice(0, 120));
  const copyId = r.data.title?._id;
  cleanup.ids.titles.push(String(copyId));

  // ---- Regression: the admin "Edit Title" screen used to PUT the whole loaded
  // document back (slug, createdAt/updatedAt, viewCount, avgRating …), which wrote
  // stale server-managed values over the live document. Non-editable keys must now
  // be ignored while real edits are still applied.
  r = await req('GET', '/admin/titles?limit=1000', { token: at });
  const loadedDoc = (r.data.items || []).find((x) => String(x._id) === String(movieId)) || {};
  r = await req('PUT', `/admin/titles/${movieId}`, { token: at, body: {
    ...loadedDoc,                                 // exactly what the admin form sent
    description: 'Edited from the admin panel',   // real edits
    releaseYear: 2025,
    durationMinutes: 95,
    genres: (loadedDoc.genres || []).map((g) => g._id),
  } });
  ok('edit title with full document payload (regression)', r.status === 200
    && r.data.title?.description === 'Edited from the admin panel'
    && r.data.title?.releaseYear === 2025
    && r.data.title?.durationMinutes === 95
    && r.data.title?.slug === 'e2e-test-movie', JSON.stringify(r.data).slice(0, 200));
  ok('server-managed fields untouched by title edit', String(r.data.title?.createdAt) === String(loadedDoc.createdAt)
    && r.data.title?.viewCount === loadedDoc.viewCount, `views=${r.data?.title?.viewCount}/${loadedDoc.viewCount}`);

  // Renaming must refresh the public slug (tested on the copy so /titles/e2e-test-movie stays valid)
  r = await req('PUT', `/admin/titles/${copyId}`, { token: at, body: { title: 'E2E Renamed Copy' } });
  ok('title rename regenerates slug (regression)', r.status === 200 && r.data.title?.slug === 'e2e-renamed-copy', `slug=${r.data.title?.slug}`);

  r = await req('POST', '/admin/titles/bulk-csv', { token: at, body: { csv:
    'title,type,releaseYear,language,ageRating,posterUrl,description\n' +
    'E2E CSV Movie,movie,2025,English,7+,https://res.cloudinary.com/demo/image/upload/sample.jpg,from csv\n' +
    'E2E CSV Series,series,2024,Urdu,13+,https://res.cloudinary.com/demo/image/upload/sample2.jpg,from csv too' } });
  ok('CSV bulk import (SRS 6.2)', r.status === 200 && r.data.createdCount === 2, JSON.stringify(r.data).slice(0, 150));

  r = await req('POST', '/admin/titles', { token: at, body: {
    type: 'series', title: 'E2E Test Series', description: 'Series for episodes test',
    posterUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
    seriesStatus: 'ongoing', status: 'published', language: 'Korean',
  } });
  ok('admin create series (ongoing status, SRS 6.3)', r.status === 201 && r.data.title?.seriesStatus === 'ongoing', JSON.stringify(r.data).slice(0, 120));
  const seriesId = r.data.title?._id; cleanup.ids.titles.push(String(seriesId));

  r = await req('POST', `/admin/titles/${seriesId}/seasons`, { token: at, body: { seasonNumber: 1, name: 'Season One' } });
  ok('create season', r.status === 201, JSON.stringify(r.data).slice(0, 120));
  const seasonId = r.data.season?._id;

  r = await req('POST', `/admin/seasons/${seasonId}/episodes`, { token: at, body: {
    episodeNumber: 1, title: 'Pilot',
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
    durationMinutes: 45, status: 'published' } });
  ok('create episode', r.status === 201, JSON.stringify(r.data).slice(0, 120));
  const ep1 = r.data.episode?._id;

  r = await req('POST', `/admin/seasons/${seasonId}/episodes/bulk`, { token: at, body: { items: [
    { episodeNumber: 2, title: 'Second', videoUrl: 'https://cdn.example.com/v2.mp4', durationMinutes: 44 },
    { episodeNumber: 3, title: 'Third', videoUrl: 'https://cdn.example.com/v3.m3u8', videoSourceType: 'hls' } ] } });
  ok('bulk episode upload (SRS 6.3)', r.status === 201 && r.data.createdCount === 2, JSON.stringify(r.data).slice(0, 150));
  const eps = r.data.episodes || [];

  // Smart link handling: a third-party web page link and a YouTube link must both become playable embeds
  r = await req('POST', `/admin/seasons/${seasonId}/episodes`, { token: at, body: {
    episodeNumber: 4, title: 'Pasted Page Link',
    videoUrl: 'https://tmovie.co/series/watch/vincenzo-117376', videoSourceType: 'mp4', status: 'published' } });
  ok('episode created with third-party page link', r.status === 201, JSON.stringify(r.data).slice(0, 120));
  const pageEp = r.data.episode?._id;

  r = await req('POST', `/admin/seasons/${seasonId}/episodes`, { token: at, body: {
    episodeNumber: 5, title: 'YouTube Link',
    videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', videoSourceType: 'mp4', status: 'published' } });
  ok('episode created with YouTube watch link', r.status === 201, JSON.stringify(r.data).slice(0, 120));
  const ytEp = r.data.episode?._id;

  r = await req('PUT', `/admin/seasons/${seasonId}/episodes/reorder`, { token: at, body: { order: [eps[1]?._id, eps[0]?._id, ep1] } });
  ok('reorder episodes (SRS 6.3)', r.status === 200 && String(r.data.episodes?.[0]?._id) === String(eps[1]?._id) && r.data.episodes?.[0]?.episodeNumber === 1, JSON.stringify(r.data).slice(0, 160));

  // ---- Regression: the "Edit Episode" modal posted the whole loaded document back too
  r = await req('GET', `/admin/seasons/${seasonId}/episodes`, { token: at });
  const loadedEp = (r.data.items || []).find((x) => String(x._id) === String(ep1)) || {};
  r = await req('PUT', `/admin/episodes/${ep1}`, { token: at, body: {
    ...loadedEp,                          // _id, season, series, createdAt/updatedAt, __v …
    title: 'Pilot (Remastered)',          // real edits
    durationMinutes: 52,
    releaseDate: '',                      // clearing a date must unset it, not save an invalid one
  } });
  ok('edit episode with full document payload (regression)', r.status === 200
    && r.data.episode?.title === 'Pilot (Remastered)'
    && r.data.episode?.durationMinutes === 52
    && !r.data.episode?.releaseDate
    && String(r.data.episode?.series) === String(seriesId), JSON.stringify(r.data).slice(0, 200));

  // ---- Regression: season edit must ignore server-managed keys as well
  r = await req('GET', `/admin/titles/${seriesId}/seasons`, { token: at });
  const loadedSeason = (r.data.items || []).find((x) => String(x._id) === String(seasonId)) || {};
  r = await req('PUT', `/admin/seasons/${seasonId}`, { token: at, body: { ...loadedSeason, name: 'Season One (Edited)' } });
  ok('edit season with full document payload (regression)', r.status === 200
    && r.data.season?.name === 'Season One (Edited)'
    && String(r.data.season?.title) === String(seriesId), JSON.stringify(r.data).slice(0, 160));

  // Genre homepage-row reorder (SRS 6.4)
  r = await req('GET', '/admin/genres', { token: at });
  const gIds = (r.data.items || []).map((g) => g._id);
  const shuffled = [...gIds.slice(1), gIds[0]];
  r = await req('PUT', '/admin/genres/reorder', { token: at, body: { order: shuffled } });
  ok('reorder genre homepage rows (SRS 6.4)', r.status === 200 && String(r.data.items?.[0]?._id) === String(shuffled[0]), JSON.stringify(r.data).slice(0, 120));

  // ---- Regression: renaming a genre must also refresh its unique slug
  // (idempotent: clear leftovers from an earlier interrupted run first)
  r = await req('GET', '/admin/genres', { token: at });
  for (const g of (r.data.items || []).filter((x) => /^E2E Genre/.test(x.name || ''))) {
    await req('DELETE', `/admin/genres/${g._id}`, { token: at });
  }
  r = await req('POST', '/admin/genres', { token: at, body: { name: 'E2E Genre Temp', order: 99 } });
  const tmpGenreDoc = r.data.genre || {};
  r = await req('PUT', `/admin/genres/${tmpGenreDoc._id}`, { token: at, body: { ...tmpGenreDoc, name: 'E2E Genre Renamed', order: 7 } });
  ok('edit genre updates name + slug (regression)', r.status === 200
    && r.data.genre?.name === 'E2E Genre Renamed'
    && r.data.genre?.slug === 'e2e-genre-renamed', JSON.stringify(r.data).slice(0, 150));
  await req('DELETE', `/admin/genres/${tmpGenreDoc._id}`, { token: at });

  // Create admin account + verify limited role is blocked from settings (SRS 6.8)
  r = await req('POST', '/admin/users/create-admin', { token: at, body: {
    name: 'E2E Manager', email: 'e2e-manager@streamflix.test', password: 'Manager@12345', role: 'content-manager' } });
  ok('create admin account (SRS 6.8)', r.status === 201, JSON.stringify(r.data).slice(0, 120));
  r = await req('POST', '/auth/login', { body: { email: 'e2e-manager@streamflix.test', password: 'Manager@12345' } });
  const mgrToken = r.data.accessToken;
  r = await req('PUT', '/admin/settings', { token: mgrToken, body: { siteName: 'Hacked' } });
  ok('RBAC: content-manager blocked from site settings', r.status === 403, `got ${r.status}`);

  // Analytics ranges + CSV export (SRS 6.11)
  r = await req('GET', '/admin/analytics/top-titles?range=week', { token: at });
  ok('analytics week range + totals', r.status === 200 && Array.isArray(r.data.items) && r.data.totals && Array.isArray(r.data.browsers), JSON.stringify(r.data).slice(0, 120));
  const csvRes = await fetch(BASE + '/admin/analytics/export?range=all', { headers: { Authorization: `Bearer ${at}` } });
  const csvText = await csvRes.text();
  ok('CSV report export (SRS 6.11)', csvRes.status === 200 && csvRes.headers.get('content-type').includes('text/csv') && csvText.includes('title'), csvText.slice(0, 80));

  r = await req('PUT', '/admin/settings', { token: at, body: {
    siteName: 'StreamFlix', accentColor: '#E50914',
    customRows: [{ title: 'E2E Picks', titleIds: [String(movieId), String(seriesId)] }],
    staticPages: [{ slug: 'about', title: 'About StreamFlix', content: 'We are E2E tested.' }],
    socialLinks: { facebook: 'https://facebook.com/streamflix' },
  } });
  ok('update site settings (SRS 6.10)', r.status === 200 && r.data.settings?.customRows?.[0]?.title === 'E2E Picks', JSON.stringify(r.data).slice(0, 160));

  r = await req('GET', '/admin/analytics/top-titles?range=all', { token: at });
  ok('analytics structure (SRS 6.11)', r.status === 200 && Array.isArray(r.data.items) && r.data.totals && Array.isArray(r.data.browsers) && Array.isArray(r.data.devices), JSON.stringify(r.data).slice(0, 100));

  r = await req('GET', '/admin/dashboard', { token: at });
  ok('dashboard stats', r.status === 200 && r.data.stats?.totalMovies >= 3, JSON.stringify(r.data.stats));

  r = await req('GET', '/admin/users', { token: at });
  ok('admin list users', r.status === 200 && Array.isArray(r.data.items));

  r = await req('GET', '/admin/activity-log', { token: at });
  ok('activity log (SRS 6.8)', r.status === 200 && r.data.items?.length > 0);
  // ================= PUBLIC FLOWS =================
  r = await req('GET', '/titles/home');
  const rows = r.data.rows || [];
  const customRow = rows.find((x) => x.title === 'E2E Picks');
  ok('home feed rows built', r.status === 200 && rows.length > 3, `rows=${rows.length}`);
  ok('custom homepage row live (SRS 6.5)', !!customRow && customRow.items.length === 2, JSON.stringify(customRow?.items?.map((i) => i.title)));

  r = await req('GET', '/titles/e2e-test-series');
  ok('title detail: seasons+episodes+moreLikeThis (SRS 4.5)', r.status === 200 && r.data.seasons?.[0]?.episodes?.length >= 3 && Array.isArray(r.data.moreLikeThis), JSON.stringify(r.data).slice(0, 100));

  r = await req('GET', '/settings');
  ok('public settings API (SRS 6.10)', r.status === 200 && r.data.settings?.staticPages?.[0]?.content === 'We are E2E tested.', JSON.stringify(r.data).slice(0, 120));

  r = await req('GET', '/titles/search?q=e2e');
  const allPublished = (r.data.items || []).every((t) => t.status === 'published');
  ok('search by title/keyword, drafts hidden (SRS 4.4)', r.status === 200 && r.data.total >= 2 && allPublished,
    `total=${r.data?.total} publishedOnly=${allPublished}`);

  r = await req('GET', '/genres');
  ok('genres list', r.status === 200 && r.data.items?.length >= 14);

  // ================= USER FLOWS =================
  r = await req('POST', '/auth/login', { body: { email: TEST_EMAIL, password: 'Tester@12345' } });
  ok('user login (bcrypt + JWT)', r.status === 200 && !!r.data.accessToken, JSON.stringify(r.data).slice(0, 100));
  const ut = r.data.accessToken;

  r = await req('GET', '/auth/me', { token: ut });
  ok('auth/me returns profiles (SRS 4.1)', r.status === 200 && r.data.profiles?.length >= 1);
  const pid = r.data.profiles?.[0]?._id;

  r = await req('GET', '/admin/dashboard', { token: ut });
  ok('RBAC: regular user blocked from admin (SRS 12)', r.status === 403, `got ${r.status}`);

  r = await req('POST', '/user/watchlist', { token: ut, profile: pid, body: { titleId: String(movieId) } });
  ok('watchlist add (SRS 4.7)', r.status === 201 || r.status === 200, JSON.stringify(r.data).slice(0, 100));
  r = await req('GET', `/user/watchlist/status/${movieId}`, { token: ut, profile: pid });
  ok('watchlist status', r.data?.inList === true);
  r = await req('GET', '/user/watchlist', { token: ut, profile: pid });
  ok('watchlist list', r.data?.items?.length === 1);

  r = await req('GET', `/titles/${movieId}/watch`, { token: ut, profile: pid });
  ok('watch data playable (SRS 4.6)', r.status === 200 && r.data.video?.url?.includes('.mp4'), JSON.stringify(r.data).slice(0, 120));

  // ---- Regression: the Play buttons on cards / hero / detail page call /watch/:id
  // with NO episode for a series. That used to answer "This title has no video URL."
  // A series must auto-start its first episode instead.
  r = await req('GET', `/titles/${seriesId}/watch`, { token: ut, profile: pid });
  {
    const firstEpId = String(r.data.video?.episodeId || '');
    const expectedFirst = [eps, ep1].flat().find((e) => String(e?._id) === firstEpId);
    ok('series Play without episode auto-starts first episode (regression)',
      r.status === 200 && !!firstEpId && !!expectedFirst && !!r.data.video?.url,
      `status=${r.status} ${J(r.data)}`);
  }

  r = await req('GET', `/titles/${seriesId}/watch?episode=${pageEp}`, { token: ut, profile: pid });
  ok('page link auto-plays as embed (tmovie-style)', r.status === 200 && r.data.video?.type === 'embed' && r.data.video?.url?.includes('tmovie.co'), `status=${r.status} body=${J(r.data)}`);

  r = await req('GET', `/titles/${seriesId}/watch?episode=${ytEp}`, { token: ut, profile: pid });
  ok('YouTube watch link converted to /embed/', r.status === 200 && r.data.video?.type === 'embed' && r.data.video?.url === 'https://www.youtube.com/embed/dQw4w9WgXcQ', `status=${r.status} body=${J(r.data)}`);

  r = await req('POST', '/user/watch-history', { token: ut, profile: pid, body: { titleId: String(movieId), progressSeconds: 120, durationSeconds: 596 } });
  ok('watch-history save (SRS 4.7)', r.status === 200);
  r = await req('GET', '/admin/analytics/top-titles?range=week', { token: at });
  ok('analytics has real data after watch (SRS 6.11)', r.status === 200 && r.data.totals?.sessions >= 1 && r.data.totals?.watchHours >= 0 && (r.data.browsers || []).length > 0, JSON.stringify(r.data.totals));
  r = await req('GET', '/user/continue-watching', { token: ut, profile: pid });
  ok('continue watching with resume position (SRS 4.2)', r.status === 200 && r.data.items?.length === 1 && r.data.items[0].progressSeconds === 120, JSON.stringify(r.data).slice(0, 150));
  r = await req('GET', '/user/history', { token: ut, profile: pid });
  ok('history list', r.data?.items?.length === 1);

  r = await req('GET', '/user/notifications', { token: ut, profile: pid });
  ok('notifications endpoint (SRS 4.8)', r.status === 200 && typeof r.data.unread === 'number');

  r = await req('DELETE', `/user/watchlist/${movieId}`, { token: ut, profile: pid });
  ok('watchlist remove', r.status === 200);

  // Rating flow (SRS 4.5 + 6.9)
  r = await req('POST', `/titles/${movieId}/rate`, { token: ut, profile: pid, body: { rating: 9 } });
  ok('user rates title 9/10', r.status === 200 && r.data.yourRating === 9 && r.data.avgRating > 0, JSON.stringify(r.data).slice(0, 120));
  r = await req('GET', '/titles/e2e-test-movie', { token: ut, profile: pid });
  ok('avg rating recomputed & shown', r.status === 200 && r.data.title?.avgRating === 9 && r.data.yourRating === 9, `avg=${r.data?.title?.avgRating} yours=${r.data?.yourRating}`);
  r = await req('GET', '/admin/ratings', { token: at });
  // The DB may hold ratings for other (real) titles too — the SRS requirement is that
  // this profile's rating shows up and orphaned ratings (deleted titles) never do.
  const mine = (r.data.items || []).find((x) => x.profile?.name === 'E2E' && x.rating === 9);
  const ratingId = mine?._id;
  const allIntact = (r.data.items || []).every((x) => x.title && x.profile);
  ok('admin ratings moderation list (SRS 6.9)', r.status === 200 && !!mine && allIntact, JSON.stringify(r.data).slice(0, 100));
  r = await req('DELETE', `/admin/ratings/${ratingId}`, { token: at });
  ok('admin removes rating, avg recomputed', r.status === 200 && Number.isFinite(r.data.avgRating) && Number.isFinite(r.data.ratingCount), JSON.stringify(r.data).slice(0, 100));
} catch (e) {
  fail++;
  console.log('FAIL  UNEXPECTED ERROR:', e.message);
} finally {
  // ---- remove all test data so your DB stays clean (by title prefix + test user) ----
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const db = mongoose.connection.db;
    const docs = await db.collection('titles').find({ title: /^E2E/ }).project({ _id: 1 }).toArray();
    const ids = docs.map((d) => d._id);
    if (ids.length) {
      await db.collection('titles').deleteMany({ _id: { $in: ids } });
      await db.collection('seasons').deleteMany({ title: { $in: ids } });
      await db.collection('episodes').deleteMany({ series: { $in: ids } });
      await db.collection('watchhistories').deleteMany({ title: { $in: ids } });
      await db.collection('watchlists').deleteMany({ title: { $in: ids } });
      console.log(`cleanup: removed ${ids.length} E2E titles + related seasons/episodes/history/watchlist`);
    }
    await db.collection('users').deleteOne({ email: TEST_EMAIL });
    await db.collection('users').deleteOne({ email: 'e2e-manager@streamflix.test' });
    if (cleanup.tester) await db.collection('profiles').deleteMany({ user: cleanup.tester });
  } catch (e) { console.log('cleanup warning:', e.message); }
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
}