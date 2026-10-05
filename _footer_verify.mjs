// Checks the rebuilt footer / help pages:
//   1. every footer link resolves to a slug that actually has content
//      (or is a real in-app route), so no link is a dead end
//   2. the content module covers every slug the help pages link to
//   3. GET /api/speed-test streams the byte count it claims, with no-store
import { CONTENT } from '../frontend/src/utils/legalContent.js';
import { FOOTER_ROWS } from '../frontend/src/utils/footerLinks.js';

const BASE = 'http://localhost:5000/api';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};

// In-app routes the footer links to that are NOT static pages.
const APP_ROUTES = new Set(['/account']);

const links = FOOTER_ROWS.flat();
console.log(`footer links: ${links.length}\n`);

const deadEnds = [];
for (const l of links) {
  if (APP_ROUTES.has(l.to)) { console.log(`  [app]  ${l.label} -> ${l.to}`); continue; }
  if (!l.to.startsWith('/p/')) { deadEnds.push(`${l.label} -> ${l.to} (not /p/)`); continue; }
  const slug = l.to.slice(3);
  if (!CONTENT[slug]) { deadEnds.push(`${l.label} -> ${l.to} (no content)`); continue; }
  console.log(`  [page] ${l.label.padEnd(22)} -> ${l.to}  (${CONTENT[slug].title})`);
}
ok('every footer link resolves', deadEnds.length === 0, deadEnds.join('; '));

// Netflix's exact labels, in order — guards against a rename drifting the footer.
// Counted off netflix.com/pk: 4 + 4 + 4 + 3 = 15.
const EXPECTED = [
  'FAQ', 'Help Center', 'Account', 'Media Center',
  'Investor Relations', 'Jobs', 'Ways to Watch', 'Terms of Use',
  'Privacy', 'Cookie Preferences', 'Corporate Information', 'Contact Us',
  'Speed Test', 'Legal Notices', 'Only on Netflix',
];
const actual = links.map((l) => l.label);
ok('labels + order match netflix.com exactly',
  JSON.stringify(actual) === JSON.stringify(EXPECTED),
  actual.join(' | '));
ok('footer has the same 15 links as the real site', links.length === 15, `got ${links.length}`);

// Every internal link used INSIDE the page copy must resolve too, or an article
// sends the reader to a 404.
const used = new Set();
Object.values(CONTENT).forEach((p) => {
  (p.related || []).forEach((r) => used.add(r.to));
  (p.index || []).forEach((g) => g.items.forEach((i) => used.add(i.to)));
  const bodyLinks = (p.body || '').match(/\]\((\/[^)]+)\)/g) || [];
  bodyLinks.forEach((m) => used.add(m.slice(2, -1)));
});
const brokenBodyLinks = [...used].filter((to) => {
  if (APP_ROUTES.has(to)) return false;
  if (!to.startsWith('/p/')) return false;
  return !CONTENT[to.slice(3)];
});
ok(`all ${used.size} in-content links resolve`, brokenBodyLinks.length === 0, brokenBodyLinks.join(', '));

// ---- speed test endpoint ----
try {
  const want = 256 * 1024;
  const t0 = Date.now();
  const r = await fetch(`${BASE}/speed-test?bytes=${want}`);
  const buf = await r.arrayBuffer();
  const ms = Date.now() - t0;
  ok('GET /api/speed-test is 200', r.status === 200, `got ${r.status}`);
  ok('streams exactly the requested bytes', buf.byteLength === want,
    `got ${buf.byteLength}, wanted ${want}`);
  ok('sends no-store (a cached body would void the measurement)',
    /no-store/.test(r.headers.get('cache-control') || ''),
    r.headers.get('cache-control') || 'none');
  const mbps = (buf.byteLength * 8) / (ms / 1000) / 1e6;
  console.log(`\n  ${(buf.byteLength / 1024).toFixed(0)} KB in ${ms} ms  ≈  ${mbps.toFixed(1)} Mbps`);
  ok('measurement completes quickly', ms < 15000, `${ms} ms`);

  // The clamp must hold: a huge ?bytes must not be honoured.
  const r2 = await fetch(`${BASE}/speed-test?bytes=999999999`);
  const b2 = await r2.arrayBuffer();
  ok('oversized ?bytes is clamped to 8 MB', b2.byteLength === 8 * 1024 * 1024,
    `got ${b2.byteLength}`);
} catch (err) {
  fail++;
  console.log(`FAIL  speed test: ${err.message} (is the server on :5000?)`);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
