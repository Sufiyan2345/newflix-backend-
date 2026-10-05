// One-off check for the /browse/new page endpoint. Verifies the shape
// NewPopular.jsx relies on: a hero `featured` pool, a Top 10 rail, themed rows
// each carrying an `explorePath` for "Explore All ›", and that nothing above
// the viewing profile's maturity ceiling is served.
//   node _newpopular_verify.mjs            (adult / anonymous view)
//   node _newpopular_verify.mjs <profileId> (needs a token, see below)
const BASE = 'http://localhost:5000/api';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};

const profileId = process.argv[2] || '';
const token = process.env.SF_TOKEN || '';
const headers = {};
if (token) headers.Authorization = `Bearer ${token}`;
if (profileId) headers['x-profile-id'] = profileId;

try {
  const r = await fetch(`${BASE}/tmdb/new-popular`, { headers });
  ok('GET /tmdb/new-popular is 200', r.status === 200, `got ${r.status}`);
  const d = await r.json();

  const top10 = d.top10 || [];
  const rows = (d.rows || []).filter((x) => x.items?.length > 0);
  console.log(`\nconfigured=${d.configured}  heading="${d.heading}"  top10=${top10.length}  featured=${(d.featured || []).length}`);
  console.log(`  TOP10: ${d.top10Title}`);
  for (const row of rows) {
    console.log(`  [${row.section}] ${row.title} -> ${row.items.length} items`
      + `${row.explorePath ? ` (explore: ${row.explorePath})` : ' (no explore)'}`);
  }

  ok('hero pool is present (the billboard needs it)', (d.featured || []).length > 0);
  ok('a Top 10 rail is present', top10.length > 0, `got ${top10.length}`);
  ok('at least one themed rail is present', rows.length > 0);
  ok('every row is non-empty', (d.rows || []).every((x) => (x.items || []).length > 0));
  ok('no row is missing a title', (d.rows || []).every((x) => !!x.title));
  ok('rows that offer Explore All have an explorePath',
    rows.filter((x) => x.explorePath).every((x) => typeof x.explorePath === 'string'));
  ok('a "new" rail exists', rows.some((x) => x.section === 'new'));
  ok('a "popular" rail exists', rows.some((x) => x.section === 'popular'));
  ok('top10 is capped at 10', top10.length <= 10, `got ${top10.length}`);
  ok('top10 items are unique', new Set(top10.map((i) => i._id)).size === top10.length);

  // A Kids profile must never see an unflagged grown-up title here.
  const items = [...top10, ...rows.flatMap((x) => x.items), ...(d.featured || [])];
  const grownUp = items.filter((i) => i.ageRating === '18+' && !i.isKids);
  ok('no unflagged 18+ title in the payload', grownUp.length === 0,
    grownUp.slice(0, 3).map((i) => `${i.title} (${i.ageRating})`).join(', '));
} catch (err) {
  fail++;
  console.log(`FAIL  harness error: ${err.message} (is the server on :5000?)`);
}
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
