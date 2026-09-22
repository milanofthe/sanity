// Asserts the layout invariants across a range of repository sizes.
//
// Three of these are hard: no sibling overlaps, no edge off the grid, and no
// panel too narrow to draw. Fill and bloat are quality numbers rather than
// invariants, but fill regressed from 87 percent to 9 once already and bloat
// from 1 to 137, so both get floors. `misfits` is reported but not asserted:
// it counts panels narrower than the preferred width, which is cosmetic.
//
// Fill and bloat pull in opposite directions and that is the point of having
// both. Fill is the share of the canvas covered by panels, so a correction
// loop that hands a three line file ten times the area it needs *raises* fill:
// the waste moves inside a panel, where fill cannot see it. Bloat is how many
// times larger a panel is than the file needs, at the 95th percentile, and it
// sees exactly that. Neither alone says the layout is good.

import { launch, settled } from './browser.mjs';

const base = process.env.SANITY_URL ?? 'http://localhost:5183';

// Floors per case, from measurement, with a little slack. Per case rather than
// one number for all of them because the shapes differ by more than the
// quality does: a repository of 800 twelve line files spends a fifth of every
// panel's height on the one cell gap that keeps neighbouring borders apart, so
// its fill is structurally lower, and 200 files of 4000 lines each run into the
// twelve column cap, so their panels cannot fill a wide slot and the fitting
// loop buys area instead. Both are real weaknesses rather than noise; the
// numbers are here so a change that makes either worse is visible.
const CASES = [
  { cfg: 'files=120&lines=90', fill: 0.92, bloat: 1.05 },
  { cfg: 'files=400&lines=180', fill: 0.94, bloat: 1.05 },
  { cfg: 'files=1000&lines=300', fill: 0.95, bloat: 1.05 },
  { cfg: 'files=1200&lines=400', fill: 0.96, bloat: 1.05 },
  { cfg: 'files=2500&lines=600', fill: 0.96, bloat: 1.05 },
  // Pathological shapes: almost all tiny files, and a few enormous ones. In
  // the first, a twelve line file is smaller than the floor a panel has, so
  // its slot is set by that floor rather than by its content. That used to
  // show as a 95th percentile of 1.56 against 1.00 everywhere else; it is now
  // in `small bloat`, where every one of those files is counted.
  { cfg: 'files=800&lines=12', fill: 0.81, bloat: 1.8 },
  { cfg: 'files=200&lines=4000', fill: 0.98, bloat: 1.1 },
  // Two thirds of the files reduced to placeholders. Fill is structurally
  // lower here and that is the mode working: a placeholder is one line tall
  // whatever the file behind it, so a directory of them is mostly the space
  // between them. What has to hold is that none of them goes missing and that
  // the chips and the panels around them do not overlap.
  { cfg: 'files=600&lines=200&stubs=0.66', fill: 0.9, bloat: 1.1 },
  // An eighth of the files are pictures, which is roughly what pathsim has.
  //
  // A picture's panel keeps the picture's proportion and is at most one code
  // column wide, so whatever its slot has left over stays empty. That costs
  // about two points of fill here, since the pictures are a small part of the
  // canvas; it would cost a great deal more if they were sized by area. What
  // has to hold is that nothing overlaps, nothing is unusable, and the text
  // panels around them are not bloated to make room.
  { cfg: 'files=500&lines=200&media=0.12', fill: 0.9, bloat: 1.2 },
];

const browser = await launch();
const page = await browser.newPage();
let lastLine = null;
page.on('console', (m) => {
  if (m.text().startsWith('layout:')) lastLine = m.text();
});
page.on('pageerror', (e) => console.log(`[error] ${e.message}`));

let failures = 0;
/**
 * Bound on how much larger a short file's panel is than its preferred shape.
 *
 * Loose, because the room is the decision. A file is cut into another column
 * only once that column would hold fifty lines, so a short file ends up in one
 * or two columns whatever shape its slot has, and the slot's surplus width
 * stays empty beside the text instead of turning into columns nobody asked
 * for. Measured across the nine shapes: 2.62, 3.06, 3.10, 3.67, 3.63, 2.76,
 * 2.61, 3.63, 3.32.
 *
 * The room is horizontal, which is why it does not show up as panels with
 * empty bottoms: of the rows a short panel has, the median short file fills 76
 * percent of them, against 67 before the rule. Fill is unchanged to a few
 * tenths of a point everywhere except the all-tiny-files case, where it rises
 * by three.
 */
const SMALL_BLOAT = 3.8;

for (const { cfg, fill: minFill, bloat: maxBloat } of CASES) {
  lastLine = null;
  await page.goto(`${base}/?${cfg}`, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__sanity), null, { timeout: 60000 });
  await settled(page);
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
  // A placeholder with nowhere to go is a file the view claims to be showing
  // and is not.
  if (num('hidden') !== 0) problems.push(`hidden=${num('hidden')}`);
  // Anything standing outside its own directory box is in somebody else's.
  if (num('escapes') !== 0) problems.push(`escapes=${num('escapes')}`);
  if (fill < minFill) problems.push(`fill=${(fill * 100).toFixed(1)}% < ${minFill * 100}%`);
  const bloat = num('bloat p95');
  if (!(bloat <= maxBloat)) problems.push(`bloat p95=${bloat.toFixed(2)} > ${maxBloat}`);
  // Short files are held to their own, looser bound: they are deliberately
  // kept in fewer columns than their slot would take, so the room left inside
  // them is the decision rather than a fault. Still bounded, because "kept in
  // one piece" is not a licence for a panel twice the size of its file.
  const smallBloat = num('small bloat p95');
  if (!(smallBloat <= SMALL_BLOAT)) {
    problems.push(`small bloat p95=${smallBloat.toFixed(2)} > ${SMALL_BLOAT}`);
  }
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
