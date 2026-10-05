// One-off check for the /kids page endpoint. Verifies the shape the frontend
// relies on: a `section` on every row (tab pills), the Stories rail, and that
// nothing grown-up leaked in. Run with the server up:  node _kids_verify.mjs
const BASE = 'http://localhost:5000/api';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};

try {
  const r = await fetch(`${BASE}/tmdb/kids`);
  ok('GET /tmdb/kids is 200', r.status === 200, `got ${r.status}`);
  const d = await r.json();

  ok('payload is a kids feed', d.kids === true, JSON.stringify(d).slice(0, 200));
  console.log(`\nconfigured=${d.configured}  rows=${(d.rows || []).length}`);
  for (const row of d.rows || []) {
    console.log(`  [${row.section}] ${row.title} -> ${row.items.length} items`
      + `${row.explorePath ? ` (explore: ${row.explorePath})` : ''}`);
  }

  const rows = d.rows || [];
  ok('every row carries a section (tab pills need it)', rows.every((x) => !!x.section));
  ok('no row is empty', rows.every((x) => (x.items || []).length > 0));
  ok('a Stories rail exists', rows.some((x) => x.section === 'stories'));
  ok('kid movies are present (the old /browse/tmdb-genre-kids dropped these)',
    rows.some((x) => x.items.some((i) => i.type === 'movie')));

  // The whole point of the page: nothing above a kid ceiling can appear.
  const items = rows.flatMap((x) => x.items);
  const bad = items.filter((i) => i.ageRating && !['ALL', '7+'].includes(i.ageRating));
  ok('no title above the 7+ ceiling', bad.length === 0,
    bad.slice(0, 3).map((i) => `${i.title} (${i.ageRating})`).join(', '));
  ok('every title is flagged isKids', items.every((i) => i.isKids === true),
    `${items.filter((i) => i.isKids !== true).length} not flagged`);
} catch (err) {
  fail++;
  console.log(`FAIL  harness error: ${err.message} (is the server on :5000?)`);
}
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
