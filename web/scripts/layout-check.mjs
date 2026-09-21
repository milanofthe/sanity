// Asserts the layout invariants across a range of repository sizes.
//
// Three of these are hard: no sibling overlaps, no edge off the grid, and no
// panel too narrow to draw. Fill is a quality number rather than an invariant,
// but it regressed from 87 percent to 9 once already, so it gets a floor too.
// `misfits` is reported but not asserted: it counts panels narrower than the
// preferred width, which is cosmetic.

import { launch } from './browser.mjs';

const base = process.env.SANITY_URL ?? 'http://localhost:5183';
// Every panel and directory gives up one grid cell at its right and bottom
// edge, so no two neighbours draw their border along the same line. On a
// realistic repository that costs two or three points of fill; the floor is
// set for the pathological case in this list, 800 files of twelve lines, where
// a 14 unit gap is a fifth of a panel's height. Separated borders are worth
// more than the area.
const MIN_FILL = Number(process.env.SANITY_MIN_FILL ?? 0.85);

const CASES = [
  'files=120&lines=90',
  'files=400&lines=180',
  'files=1000&lines=300',
  'files=1200&lines=400',
  'files=2500&lines=600',
  // Pathological shapes: almost all tiny files, and a few enormous ones.
  'files=800&lines=12',
  'files=200&lines=4000',
];

const browser = await launch();
const page = await browser.newPage();
let lastLine = null;
page.on('console', (m) => {
  if (m.text().startsWith('layout:')) lastLine = m.text();
});
page.on('pageerror', (e) => console.log(`[error] ${e.message}`));

let failures = 0;
for (const cfg of CASES) {
  lastLine = null;
  await page.goto(`${base}/?${cfg}`, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__sanity), null, { timeout: 60000 });
  await page.waitForTimeout(1200);
  if (!lastLine) {
    console.log(`${cfg.padEnd(24)} NO STATS`);
    failures++;
    continue;
  }
  const num = (k) => {
    const m = lastLine.match(new RegExp(`${k} ([0-9.]+)`));
    return m ? Number(m[1]) : NaN;
  };
  const fill = num('fill') / 100;
  const problems = [];
  if (num('overlaps') !== 0) problems.push(`overlaps=${num('overlaps')}`);
  if (num('offgrid') !== 0) problems.push(`offgrid=${num('offgrid')}`);
  // misfits are cosmetic (a panel narrower than preferred); unusable is not.
  if (num('unusable') !== 0) problems.push(`unusable=${num('unusable')}`);
  // Lines with nowhere to go: the wrapping equivalent of clipping, and just
  // as much a loss of content.
  if (num('overflowing') !== 0) problems.push(`overflowing=${num('overflowing')}`);
  if (fill < MIN_FILL) problems.push(`fill=${(fill * 100).toFixed(1)}% < ${MIN_FILL * 100}%`);
  // The pass count is reported, not asserted: the pathological case converges
  // on its last allowed pass, and the layout it produces is still valid. What
  // actually has to hold is `unusable`, `overlaps` and `offgrid`, above.
  const verdict = problems.length === 0 ? 'ok' : `FAIL ${problems.join(' ')}`;
  if (problems.length) failures++;
  console.log(`${cfg.padEnd(24)} ${verdict.padEnd(34)} ${lastLine.slice(8)}`);
}

await browser.close();
console.log(failures === 0 ? '\nall layout invariants hold' : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
