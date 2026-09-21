// Measures how much of the canvas moves when one file changes.
//
// This is the question the live updates turn on. A panel is sized to its
// content, so a file that grows past its panel forces a relayout, and a
// treemap is free to rearrange everything when any area changes. If a five
// line addition moved half the project, watching a repository while working in
// it would be unusable, and panels would need slack built into them at the
// cost of some density.
//
// So it gets measured rather than assumed, through the shipping layout on a
// real repository, and the result is asserted so the treemap cannot quietly
// get worse.

import { openApp } from './browser.mjs';

const { browser, page } = await openApp({ source: process.env.SANITY_SRC ?? 'fixture=fixture' });

/**
 * Grow one file by `lines` lines, lay out again, and report what moved.
 *
 * Goes through `app.open` rather than calling the layout directly, so what is
 * measured is the path a save actually takes.
 */
/**
 * Grow one file by `lines` lines, lay out again, and report what moved.
 *
 * Movement is measured in normalised canvas coordinates, not world units.
 * Adding a file changes the total area, so the whole layout rescales slightly
 * and every panel ends up at a different world coordinate while the picture
 * is unchanged. In world units that reads as 99.9 percent of panels moving,
 * which is true and useless. What matters is whether a panel moved relative to
 * the canvas, which is what someone looking at the screen would see.
 */
const measure = await page.evaluate(async (plan) => {
  const app = window.__sanity.app;
  const { computeLayout, decoded } = window.__sanity;
  const source = app.lastSource;
  const view = { w: app.cam.vw, h: app.cam.vh };
  const files = decoded();

  // The entries exactly as app.open builds them for the layout.
  const build = (extra, grown) =>
    source.entries
      .map((e) => {
        const cols = grown && grown.path === e.path ? grown.lineCols : files.get(e.path)?.lineCols;
        const lineCount = grown && grown.path === e.path ? grown.lineCount : e.lineCount;
        return { ...e, lineCount, lineCols: cols };
      })
      .concat(extra ?? []);

  /** Panel centres in units of the canvas, so a rescale is not movement. */
  const centres = (layout) => {
    const [x0, y0, x1, y1] = layout.bounds;
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    return new Map(
      layout.files.map((f) => [f.path, [(f.x + f.w / 2 - x0) / w, (f.y + f.h / 2 - y0) / h]]),
    );
  };

  // Anything under this is the layout settling on a slightly different scale,
  // not a panel changing place. Half a percent of the canvas is well under one
  // panel's width at any zoom where panels are distinguishable.
  const EPS = 0.005;

  const baseLayout = computeLayout(build(), view);
  const base = centres(baseLayout);
  const total = base.size;

  const results = [];
  for (const { label, indices, lines, add } of plan) {
    const shares = [];
    const drifts = [];
    for (const i of indices) {
      const e = source.entries[i];
      if (!e) continue;
      let after;
      if (add) {
        const dir = e.path.replace(/[^/]+$/, '');
        after = centres(
          computeLayout(
            build([
              {
                path: `${dir}freshly-written-file.ts`,
                lineCount: 40,
                maxCols: 60,
                clipCols: 80,
                lineCols: new Uint16Array(40).fill(30),
              },
            ]),
            view,
          ),
        );
      } else {
        const old = files.get(e.path)?.lineCols;
        if (!old) continue;
        const next = new Uint16Array(old.length + lines);
        next.set(old);
        for (let k = old.length; k < next.length; k++) next[k] = 30;
        after = centres(
          computeLayout(
            build(null, { path: e.path, lineCols: next, lineCount: e.lineCount + lines }),
            view,
          ),
        );
      }

      let moved = 0;
      let worstDrift = 0;
      for (const [path, a] of base) {
        const b = after.get(path);
        if (!b) continue;
        const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (d > EPS) moved++;
        worstDrift = Math.max(worstDrift, d);
      }
      shares.push(moved / total);
      drifts.push(worstDrift);
    }
    shares.sort((a, b) => a - b);
    drifts.sort((a, b) => a - b);
    results.push({
      label,
      median: shares[Math.floor(shares.length / 2)] ?? 0,
      worst: shares[shares.length - 1] ?? 0,
      drift: drifts[drifts.length - 1] ?? 0,
      samples: shares.length,
    });
  }
  return results;
}, [
  { label: '+5 lines', indices: [0, 40, 120, 250, 400, 600, 700, 800], lines: 5 },
  { label: '+50 lines', indices: [0, 40, 120, 250, 400, 600, 700, 800], lines: 50 },
  { label: '+2000 lines', indices: [0, 120, 400, 700], lines: 2000 },
  { label: 'a new file', indices: [0, 120, 400, 700], add: true },
]);

let failures = 0;
for (const r of measure) {
  console.log(
    `${r.label.padEnd(12)} median ${(r.median * 100).toFixed(1).padStart(5)}% of panels move, ` +
      `worst ${(r.worst * 100).toFixed(1).padStart(5)}%, ` +
      `furthest ${(r.drift * 100).toFixed(1)}% of the canvas  (${r.samples} samples)`,
  );
}

// What actually holds today: the typical small edit costs nothing. The root
// extent is derived from the corrected total area, so an edit that changes
// which files need a correction moves the whole canvas by about a percent, and
// the integer treemap amplifies that into a rearrangement. That is the
// worst case below, it is a real weakness, and it is issue #8. Asserting on
// the median is asserting the property that is true.
const small = measure.find((r) => r.label === '+5 lines');
const limit = Number(process.env.SANITY_MOVE_LIMIT ?? 0.05);
if (!small || small.samples === 0) {
  console.log('FAIL  nothing was measured');
  failures++;
} else if (small.median > limit) {
  console.log(
    `FAIL  the median five line edit moved ${(small.median * 100).toFixed(1)}% of panels, ` +
      `over the ${(limit * 100).toFixed(0)}% allowed`,
  );
  failures++;
} else {
  console.log(
    `ok    the median small edit moves ${(small.median * 100).toFixed(1)}% of panels` +
      ` (worst case ${(small.worst * 100).toFixed(0)}% is issue #8)`,
  );
}

// Monotonicity: if a bigger change moved less, the measurement is not measuring
// what it claims to.
const big = measure.find((r) => r.label === '+2000 lines');
if (small && big && big.worst + 1e-9 < small.median) {
  console.log('FAIL  a large addition moved less than a small one');
  failures++;
} else {
  console.log('ok    movement grows with the size of the change');
}

await browser.close();
console.log(
  failures === 0
    ? '\nthe measured limits hold; see issue #8 for the worst case'
    : `\n${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
