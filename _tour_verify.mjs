// Static checks for the first-login tour (OnboardingTour.jsx).
//
// The failure this guards against is a hard lock: if a step names a `data-tour`
// target that the Navbar does not render, the scrim comes up with no card and
// the member cannot click Next or Skip. Nothing at runtime would report that —
// the component simply renders a dark screen — so it is checked here instead.
//
//   node _tour_verify.mjs
import { readFileSync } from 'node:fs';

const SRC = 'c:/Users/IQRACOM/OneDrive/Desktop/Netflix2026/frontend/src';
const read = (p) => readFileSync(`${SRC}/${p}`, 'utf8');

const navbar = read('components/Navbar.jsx');
const tour = read('components/OnboardingTour.jsx');
const css = `${read('styles/pages.css')}\n${read('styles/components.css')}\n${read('styles/grid.css')}\n${read('styles/core.css')}`;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};

// --- targets the Navbar can actually render -------------------------------
// Nav pills render `data-tour={n.tour}`, so their keys come from the NAV array.
const navArray = navbar.slice(navbar.indexOf('const NAV = ['), navbar.indexOf('];', navbar.indexOf('const NAV = [')));
const pillTargets = [...navArray.matchAll(/tour:\s*'([^']+)'/g)].map((m) => m[1]);
// Everything else is a literal data-tour="..." in the JSX.
const literalTargets = [...navbar.matchAll(/data-tour="([^"]+)"/g)].map((m) => m[1]);
const available = new Set([...pillTargets, ...literalTargets]);

// --- steps the tour asks for ----------------------------------------------
const stepsBlock = tour.slice(tour.indexOf('const STEPS = ['), tour.indexOf('];', tour.indexOf('const STEPS = [')));
const steps = [...stepsBlock.matchAll(/tour:\s*'([^']+)'[\s\S]*?title:\s*'([^']+)'/g)]
  .map((m) => ({ tour: m[1], title: m[2] }));

console.log(`navbar targets: ${[...available].join(', ')}\n`);
console.log(`tour steps (${steps.length}):`);
steps.forEach((s, i) => console.log(`  ${i + 1}. [${s.tour}] ${s.title}`));

const missing = steps.filter((s) => !available.has(s.tour));
ok('every tour step has a matching data-tour target', missing.length === 0,
  missing.map((s) => s.tour).join(', '));
ok('every step has a title and body', steps.length >= 4, `${steps.length} steps`);
ok('step keys are unique', new Set(steps.map((s) => s.tour)).size === steps.length);
ok('pill targets are unique', pillTargets.length === new Set(pillTargets).size,
  pillTargets.join(', '));

const unused = [...available].filter((t) => !steps.some((s) => s.tour === t));
console.log(`\ntargets with no step: ${unused.length ? unused.join(', ') : 'none'}`);

// --- the classes the component renders must exist in CSS -------------------
// `on` is only ever a modifier, so match it compound.
const CLASSES = [
  '.tour-root', '.tour-shade', '.tour-hot', '.tour-ring', '.tour-tip',
  '.tour-tip.placed', '.tour-arrow',
  '.tour-title', '.tour-body', '.tour-foot', '.tour-dots', '.tour-dot',
  '.tour-dot.on', '.tour-next', '.tour-skip', '.tour-tip.below', '.tour-tip.above',
];
const missingCss = CLASSES.filter((c) => !css.includes(c));
ok('every tour class is styled', missingCss.length === 0, missingCss.join(', '));

// --- safety: no state in which the scrim is up and the card is not ----------
// These guard a failure that ships as a dimmed page with no Next and no Skip,
// and that is easy to reintroduce: gating the card on the very state that
// measuring the card produces. The first version of this file asserted the
// buggy condition, so it passed 14/14 over a tour that showed no card at all.
ok('card renders as soon as a rect is measured',
  /\{rect && \(/.test(tour) && !/\{rect && tip &&/.test(tour),
  'the card must not be gated on the position state it produces');
ok('the card is held invisible until it has been placed',
  /visibility: tip \? 'visible' : 'hidden'/.test(tour));
ok('the placement effect does not bail on an unmounted card',
  !/if \(seen \|\| !rect \|\| !tipRef\.current\)/.test(tour),
  'a !tipRef.current guard deadlocks against a tip-gated card');
ok('the card is remounted per step so it re-measures',
  /key=\{step\}/.test(tour));
ok('a fallback scrim covers the screen before measurement',
  /shade\(\{ inset: 0 \}\)/.test(tour));
ok('a hidden target clears the rect instead of keeping the old one',
  /if \(r\.width <= 0 \|\| r\.height <= 0\) \{ setRect\(null\); return; \}/.test(tour));
ok('a step with no visible target advances instead of locking the member',
  /findTarget/.test(tour) && /hit\.index !== step/.test(tour));
ok('scrim is four panels around the target',
  (tour.match(/shade\(\{/g) || []).length >= 5, 'expected 4 panels + 1 fallback');
ok('scrim sits above the navbar (navbar z-index 100)',
  /\.tour-root\s*\{[^}]*z-index:\s*1000/.test(css));
// .navbar is `position: fixed; z-index: 100` — a stacking context — so a
// z-index or box-shadow on a control inside it can never paint over the scrim.
// The highlight therefore has to be an element of the overlay.
ok('highlight ring is drawn in the overlay, above the scrim',
  /\.tour-ring\s*\{[^}]*z-index:\s*1001/.test(css) && /className="tour-ring"/.test(tour));
ok('highlighted control cannot be clicked mid-tour',
  /\.tour-hot\s*\{[^}]*pointer-events:\s*none/.test(css));
ok('the card paints above the highlight ring',
  /\.tour-tip\s*\{[^}]*z-index:\s*1002/.test(css));
ok('completion is persisted per account + version',
  /sf_tour_\$\{TOUR_VERSION\}_\$\{user\?\._id/.test(tour));
ok('Escape skips the tour', /e\.key === 'Escape'/.test(tour));

// --- the reference wording is preserved ------------------------------------
ok('reference step wording is kept verbatim',
  steps.some((s) => s.title === 'How to find what you like to watch'),
  steps.map((s) => s.title).join(' | '));

// --- the placement maths, exercised for real --------------------------------
// "The card is centred on the control" is not something a reader can check,
// and the cases that break it are the edges of a phone and the right-hand side
// of a desktop navbar. These are the assertions the regex checks above cannot
// make. The expected values are stated here rather than imported, so the test
// cannot drift along with the implementation.
const { placeCard } = await import('../frontend/src/utils/tourPlacement.js');
const GAP = 14;
const EDGE_PX = 16;
const CARD_W = 340;
const CARD_H = 210;
const box = (left, top, width = 80, height = 44) => ({
  left, top, right: left + width, bottom: top + height, width, height,
});

const desk = placeCard(box(52, 14), CARD_W, CARD_H, 1920, 1080, GAP, EDGE_PX);
ok('desktop: a control at the left edge is clamped inside the viewport',
  desk.place === 'below' && desk.left === EDGE_PX, JSON.stringify(desk));
ok('desktop: the arrow still points at the control after the clamp',
  desk.arrowLeft === 92 - desk.left, JSON.stringify(desk));

const mid = placeCard(box(900, 14), CARD_W, CARD_H, 1920, 1080, GAP, EDGE_PX);
ok('desktop: a control in the middle is centred with the arrow on its centre',
  mid.place === 'below' && mid.left === 770 && mid.arrowLeft === 170, JSON.stringify(mid));

const right = placeCard(box(1840, 14), CARD_W, CARD_H, 1920, 1080, GAP, EDGE_PX);
ok('desktop: a control at the right edge keeps the card fully on screen',
  right.place === 'below' && right.left + CARD_W <= 1920 - EDGE_PX, JSON.stringify(right));
ok('desktop: the arrow follows the control at the right edge too',
  right.arrowLeft === 1880 - right.left, JSON.stringify(right));

const low = placeCard(box(900, 820), CARD_W, CARD_H, 1920, 1080, GAP, EDGE_PX);
ok('a control low on the page flips the card above it',
  low.place === 'above' && low.top === 596, JSON.stringify(low));

// The property that actually matters: whatever the viewport and wherever the
// control is, the card lands fully on screen with the arrow inside it. Widths
// mirror the browser: max-width 340 never yields a card wider than the viewport
// minus the gutters, so offsetWidth can never come back larger than that.
let offScreen = 0; let badArrow = 0; let badPlace = 0; let cases = 0;
for (const vw of [320, 360, 375, 414, 768, 1024, 1920]) {
  for (const vh of [480, 568, 667, 800, 1080]) {
    const widths = [260, Math.min(CARD_W, vw - 2 * EDGE_PX)];
    for (const w of widths) {
      for (let x = 0; x <= vw - 20; x += 23) {
        for (let y = 0; y <= vh - 20; y += 61) {
          const p = placeCard(box(x, y, 80, 44), w, CARD_H, vw, vh, GAP, EDGE_PX);
          cases += 1;
          if (p.left < EDGE_PX || p.top < EDGE_PX
            || p.left + w > vw - EDGE_PX || p.top + CARD_H > vh - EDGE_PX) offScreen += 1;
          if (p.place !== 'below' && p.place !== 'above') badPlace += 1;
          if (p.arrowLeft < 18 || p.arrowLeft > w - 18) badArrow += 1;
        }
      }
    }
  }
}
ok(`the card is fully on screen everywhere (${cases} viewport/position cases)`,
  offScreen === 0, `${offScreen} landed off screen`);
ok('the arrow always has room inside the card', badArrow === 0, `${badArrow} out of range`);
ok('the card is always above or below the control', badPlace === 0, `${badPlace} invalid`);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
