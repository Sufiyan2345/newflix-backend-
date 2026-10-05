import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSource, resolveVidplay, VIDPLAY_HOSTS } from './controllers/titleDetailController.js';

// ---- VidPlay watch pages (vidplay.top / .tv / .org) ----
// The watch page itself is X-Frame-Options, so it must NEVER resolve as a plain
// embed — it has to be resolved server-side to its real ajax-loaded player.

test('VidPlay watch page host is detected on every official domain', () => {
  assert.equal(VIDPLAY_HOSTS.test('vidplay.top'), true);
  assert.equal(VIDPLAY_HOSTS.test('www.vidplay.tv'), true);
  assert.equal(VIDPLAY_HOSTS.test('vidplay.org'), true);
  assert.equal(VIDPLAY_HOSTS.test('vidplay.top.evil.example'), false);
  assert.equal(VIDPLAY_HOSTS.test('notvidplay.top'), false);
});

test('VidPlay backend players (ythd/vidfast/peachify) are accepted as embed sources', () => {
  assert.equal(resolveSource('https://ythd.org/embed/117376/1-1/color-000000', 'embed').type, 'embed');
  assert.equal(resolveSource('https://vidfast.pro/tv/117376/1/1?autoPlay=true', 'embed').type, 'embed');
  assert.equal(resolveSource('https://peachify.top/embed/tv/117376/1/1', 'embed').type, 'embed');
});

// Live network test — exercises the real resolver end to end:
// watch page → ajax endpoint → actual frameable player URL.
test('VidPlay Vincenzo S1E1 watch page resolves to its real frameable player (live)', async () => {
  const url = 'https://vidplay.top/watchseries/vincenzo-online-free/season/1/episode/1';
  const result = await resolveVidplay(url);
  console.log('  resolved →', JSON.stringify(result));
  assert.equal(result.type, 'embed');
  assert.match(
    result.url,
    /^https:\/\/(?:www\.)?(ythd\.org|vidfast\.pro|peachify\.top)\//i,
    `expected one of the real VidPlay players, got: ${result.url}`,
  );
});
