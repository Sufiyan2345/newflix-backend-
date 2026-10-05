import assert from 'node:assert/strict';
import { parsePlaylistUrlIntoEpisodes } from './controllers/adminEpisodeController.js';

const manifest = `#EXTM3U
#EXTINF:-1, Episode 1
https://cdn.example.com/episodes/1.m3u8
#EXTINF:-1, Episode 2
https://cdn.example.com/episodes/2.m3u8
`;

const dataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(manifest)}`;
const items = await parsePlaylistUrlIntoEpisodes(dataUrl, 1);

assert.equal(items.length, 2);
assert.equal(items[0].title, 'Episode 1');
assert.equal(items[1].videoUrl, 'https://cdn.example.com/episodes/2.m3u8');
assert.equal(items[0].videoSourceType, 'hls');
console.log('playlist parser ok');
