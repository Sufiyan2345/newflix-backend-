// Debug: what does the vidplay watch page look like when fetched from Node?
import { resolveVidplay } from './controllers/titleDetailController.js';

const url = 'https://vidplay.top/watchseries/vincenzo-online-free/season/1/episode/1';
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 10000);
const r = await fetch(url, {
  signal: ac.signal,
  redirect: 'follow',
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'text/html,*/*',
    Referer: 'https://vidplay.top/',
  },
});
clearTimeout(timer);
const html = await r.text();
console.log('status:', r.status, 'final url:', r.url, 'length:', html.length);

// Dump every $.get( occurrence with 220 chars of context
for (const m of html.matchAll(/\$\.get\(/g)) {
  console.log('--- $.get at', m.index, '---');
  console.log(html.slice(m.index, m.index + 220).replace(/\s+/g, ' '));
}

// Also dump anything mentioning tv_vplay or vplay
for (const m of html.matchAll(/vplay[^"'`]*|\/ajax\/[^"'`]*/gi)) {
  console.log('vplay/ajax mention:', JSON.stringify(m[0]));
}

console.log('resolveVidplay result:', JSON.stringify(await resolveVidplay(url)));
