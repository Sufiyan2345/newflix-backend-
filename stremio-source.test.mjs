import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSource, buildTmdbEpisodeSourceUrl } from './controllers/titleDetailController.js';

test('Stremio stream URL remains a stream source, not a generic embed fallback', () => {
  const result = resolveSource('https://stremio.com/stream/abc123', 'stremio');
  assert.equal(result.type, 'stremio');
  assert.equal(result.url, 'https://stremio.com/stream/abc123');
});

test('Direct streaming files stay direct and are not forced to iframe mode', () => {
  const result = resolveSource('https://cdn.example.com/live/manifest.mpd', 'mp4');
  assert.equal(result.type, 'mp4');
  assert.equal(result.url, 'https://cdn.example.com/live/manifest.mpd');
});

test('HTTP direct stream URLs are accepted for native playback', () => {
  const result = resolveSource('http://127.0.0.1:8000/video.mp4', 'mp4');
  assert.equal(result.type, 'mp4');
  assert.equal(result.url, 'http://127.0.0.1:8000/video.mp4');
});

test('YouTube embed URLs are accepted as embed sources', () => {
  const result = resolveSource('https://www.youtube.com/embed/juqpXP34V48?si=6NlcZeTdIuV-_fsA', 'embed');
  assert.equal(result.type, 'embed');
  assert.equal(result.url, 'https://www.youtube.com/embed/juqpXP34V48?si=6NlcZeTdIuV-_fsA');
});

test('Stremio URLs are detected even without an explicit source type', () => {
  const result = resolveSource('https://app.stremio.com/stream/xyz789');
  assert.equal(result.type, 'stremio');
  assert.equal(result.url, 'https://app.stremio.com/stream/xyz789');
});

// ---- Any platform link plays inside our own play screen (iframe), never a raw page ----

test('YouTube watch link becomes an embeddable player URL', () => {
  const result = resolveSource('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'mp4');
  assert.equal(result.type, 'embed');
  assert.equal(result.url, 'https://www.youtube.com/embed/dQw4w9WgXcQ');
});

test('YouTube share / shorts emoji links are normalised', () => {
  assert.equal(resolveSource('https://youtu.be/dQw4w9WgXcQ').url, 'https://www.youtube.com/embed/dQw4w9WgXcQ');
  assert.equal(resolveSource('https://www.youtube.com/shorts/abc123?feature=share').url, 'https://www.youtube.com/embed/abc123');
  assert.equal(resolveSource('https://m.youtube.com/watch?v=xyz789&t=30s').url, 'https://www.youtube.com/embed/xyz789');
});

test('Bilibili video links become the Bilibili player', () => {
  const bv = resolveSource('https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=333', 'mp4');
  assert.equal(bv.type, 'embed');
  assert.equal(bv.url, 'https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&autoplay=0&high_quality=1');
  const av = resolveSource('https://www.bilibili.com/video/av170001');
  assert.equal(av.url, 'https://player.bilibili.com/player.html?aid=170001&autoplay=0&high_quality=1');
});

test('Dailymotion links become the Dailymotion player', () => {
  assert.equal(resolveSource('https://www.dailymotion.com/video/x7tgad0').url, 'https://www.dailymotion.com/embed/video/x7tgad0');
  assert.equal(resolveSource('https://dai.ly/x7tgad0').url, 'https://www.dailymotion.com/embed/video/x7tgad0');
});

test('A stale source type can never break a platform link', () => {
  // admin saved "mp4" earlier, then pasted a YouTube link — must still frame it
  assert.equal(resolveSource('https://www.youtube.com/watch?v=abc123', 'mp4').type, 'embed');
  assert.equal(resolveSource('https://www.bilibili.com/video/BV1xx411c7mD', 'hls').type, 'embed');
});

// ---- More platforms: normalised to each provider's embeddable player ----

test('Viki video links resolve to the Viki player', () => {
  const result = resolveSource('https://www.viki.com/videos/1023585v-heirs-episode-14', 'mp4');
  assert.equal(result.type, 'embed');
  assert.equal(result.url, 'https://www.viki.com/player/1023585v');
});

test('OK.ru and Rutube links resolve to their players', () => {
  assert.equal(resolveSource('https://ok.ru/video/1234567890').url, 'https://ok.ru/videoembed/1234567890');
  assert.equal(resolveSource('https://rutube.ru/video/abc123def/').url, 'https://rutube.ru/play/embed/abc123def');
});

test('VK video links resolve to video_ext.php', () => {
  assert.equal(resolveSource('https://vk.com/video-123456_7891011').url, 'https://vk.com/video_ext.php?oid=-123456&id=7891011&hd=2');
});

test('Archive.org, Streamable and Loom links resolve to their embeds', () => {
  assert.equal(resolveSource('https://archive.org/details/BigBuckBunny_124').url, 'https://archive.org/embed/BigBuckBunny_124');
  assert.equal(resolveSource('https://streamable.com/abc123').url, 'https://streamable.com/e/abc123');
  assert.equal(resolveSource('https://www.loom.com/share/abc123def456').url, 'https://www.loom.com/embed/abc123def456');
});

test('MovieNerds watch URLs are remapped to the embeddable Vidsrc player', () => {
  const result = resolveSource('https://movienerds.site/watch/tv/117376?season=1&episode=2', 'mp4');
  assert.equal(result.type, 'embed');
  assert.equal(result.url, 'https://vidsrc.su/embed/tv/117376/1/2');
});

test('Unknown third-party watch pages are not forced into a black iframe', () => {
  const result = resolveSource('https://tmovie.co/series/watch/vincenzo-117376', 'mp4');
  assert.equal(result.type, 'external');
  assert.equal(result.url, 'https://tmovie.co/series/watch/vincenzo-117376');
});

// ---- Zenox: verifiable X-Frame-Options (SAMEORIGIN + frame-ancestors 'self') ----

test('Zenox watch links are marked external so the player offers a new-tab button', () => {
  const result = resolveSource('https://zenox.lol/media/series-117376-1-1', 'embed');
  assert.equal(result.type, 'external');
  assert.equal(result.url, 'https://zenox.lol/media/series-117376-1-1');
  assert.equal(resolveSource('https://media.zenox.cc/media/movie-27205-0-0').type, 'external');
});

test('Direct media files hosted on Zenox stay native (path kept verbatim)', () => {
  const r = resolveSource('https://zenox.lol/hls/vincenzo-s01e01/index.m3u8', 'hls');
  assert.equal(r.type, 'hls');
  assert.equal(r.url, 'https://zenox.lol/hls/vincenzo-s01e01/index.m3u8');
});

test('TMDB episode coordinates build the configured provider player URL', () => {
  const url = buildTmdbEpisodeSourceUrl(117376, 1, 11);
  assert.equal(url, 'https://vidsrc.su/embed/tv/117376/1/11');
  assert.equal(resolveSource(url, 'embed').type, 'embed');
});

test('A custom TMDB source template is supported and invalid coordinates are rejected', () => {
  assert.equal(
    buildTmdbEpisodeSourceUrl(42, 2, 3, 'https://example.test/embed/{tmdbId}/s{season}/e{episode}'),
    'https://example.test/embed/42/s2/e3',
  );
  assert.equal(buildTmdbEpisodeSourceUrl(0, 1, 1), '');
  assert.equal(buildTmdbEpisodeSourceUrl(42, 0, 1), '');
  assert.equal(buildTmdbEpisodeSourceUrl(42, 1, 0), '');
});
