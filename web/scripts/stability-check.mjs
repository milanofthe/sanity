// Measures what a relayout costs and how much of the canvas it moves.
//
// The cost is the property that matters, because panels animate to their new
// places: a relayout that reuses the scene and rewrites only the textures that
// actually changed is affordable however much moves, and one that rebuilds
// everything is not. Measured on a 989 file project, rebuilding took 1813 ms
// of which 1380 was re-uploading textures that had not changed, with the
// canvas refilling from empty the whole time.
//
// And how much of the canvas a change moves, from scratch and carried over
// from the layout before, which is what a relayout does; see computeLayout.
// From scratch, five lines added to one file of pathsim moved 45 percent of
// the panels; carried over, none. Issue #8.
//
//   SANITY_SRC=demo=pathsim node web/scripts/stability-check.mjs

import { openApp } from './browser.mjs';

const { browser, page } = await openApp({ source: process.env.SANITY_SRC ?? 'fixture=fixture' });

/**
 * Change the project, lay it out again, and report what moved.
 *
 * Movement is measured in normalised canvas coordinates, not world units.
 * Adding a file changes the total area, so the whole layout rescales slightly
 * and every panel ends up at a different world coordinate while the picture
 * is unchanged. In world units that reads as 99.9 percent of panels moving,
 * which is true and useless. What matters is whether a panel moved relative to
 * the canvas, which is what someone looking at the screen would see.
 *
 * Each change is laid out twice: from scratch, and carried over from the
 * layout before it, which is what a relayout in the app does. See
 * computeLayout.
 */
const measure = await page.evaluate(async (plan) => {
  const app = window.__sanity.app;
  const { computeLayout, decoded } = window.__sanity;
  const source = app.lastSource;
  const view = { w: app.cam.vw, h: app.cam.vh };
  const files = decoded();

  // The entries exactly as app.open builds them for the layout.
  const baseEntries = source.entries.map((e) => ({ ...e, lineCols: files.get(e.path)?.lineCols }));

  const grow = (entries, path, lines) => entries.map((e) => {
    if (e.path !== path || !e.lineCols) return e;
    const next = new Uint16Array(Math.max(1, e.lineCols.length + lines));
    next.set(lines >= 0 ? e.lineCols : e.lineCols.slice(0, next.length));
    for (let k = e.lineCols.length; k < next.length; k++) next[k] = 30;
    return { ...e, lineCols: next, lineCount: next.length };
  });
  const added = (path) => ({
    path, lineCount: 40, maxCols: 60, clipCols: 80, lineCols: new Uint16Array(40).fill(30),
  });

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
  const moved = (a, b) => {
    const ca = centres(a);
    const cb = centres(b);
    let n = 0;
    let both = 0;
    let far = 0;
    for (const [path, p] of ca) {
      const q = cb.get(path);
      if (!q) continue;
      both++;
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d > EPS) n++;
      far = Math.max(far, d);
    }
    return { share: n / Math.max(1, both), far };
  };

  const baseLayout = computeLayout(baseEntries, view);
  const text = baseEntries.filter((e) => e.lineCols && !e.media && !e.stub);
  const results = [];
  for (const { label, lines, add, remove } of plan) {
    const fresh = [];
    const carried = [];
    for (const i of [0, 7, 19, 41, 83, 150, 230, 320]) {
      const e = text[i % text.length];
      let entries;
      if (add) entries = [...baseEntries, added(e.path.replace(/[^/]+$/, '') + 'freshly-written-file.ts')];
      else if (remove) entries = baseEntries.filter((x) => x.path !== e.path);
      else entries = grow(baseEntries, e.path, lines);
      fresh.push(moved(baseLayout, computeLayout(entries, view)));
      carried.push(moved(baseLayout, computeLayout(entries, view, baseLayout)));
    }
    const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
    const share = (v) => v.map((m) => m.share);
    const far = (v) => v.map((m) => m.far);
    results.push({
      label,
      fresh: median(share(fresh)), freshWorst: Math.max(...share(fresh)),
      freshFar: median(far(fresh)),
      carried: median(share(carried)), carriedWorst: Math.max(...share(carried)),
      carriedFar: median(far(carried)),
    });
  }

  // A walk: one change after another, each laid out from the one before, the
  // way stepping through a history or a working session does. Seeded, so two
  // runs walk the same way.
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let entries = baseEntries;
  let layout = baseLayout;
  const steps = [];
  let freshTaken = 0;
  let worstGap = 0;
  for (let step = 0; step < 60; step++) {
    const pick = entries.filter((e) => e.lineCols && !e.media && !e.stub);
    const e = pick[Math.floor(rand() * pick.length)];
    const r = rand();
    if (r < 0.2) entries = [...entries, added(e.path.replace(/[^/]+$/, '') + `walk-${step}.ts`)];
    else if (r < 0.35) entries = entries.filter((x) => x.path !== e.path);
    else entries = grow(entries, e.path, Math.round((rand() - 0.4) * 120));
    const next = computeLayout(entries, view, layout);
    if (!next.continued) freshTaken++;
    const fill = (l) => window.__sanity.layoutStats(l).fill;
    worstGap = Math.max(worstGap, fill(computeLayout(entries, view)) - fill(next));
    steps.push(moved(layout, next).share);
    layout = next;
  }
  steps.sort((a, b) => a - b);
  return {
    panels: baseLayout.files.length,
    results,
    walk: {
      median: steps[Math.floor(steps.length / 2)],
      p90: steps[Math.floor(steps.length * 0.9)],
      freshTaken,
      steps: steps.length,
      worstGap,
    },
  };
}, [
  { label: '+5 lines', lines: 5 },
  { label: '+50 lines', lines: 50 },
  { label: '-30 lines', lines: -30 },
  { label: '+2000 lines', lines: 2000 },
  { label: 'a new file', add: true },
  { label: 'a file gone', remove: true },
]);

let failures = 0;
const pct = (v) => `${(v * 100).toFixed(1).padStart(5)}%`;
console.log('share of panels that change place, median and worst of 8 files, and how far');
console.log('the furthest one goes, as a share of the canvas:');
console.log('                from scratch               carried over');
for (const r of measure.results) {
  console.log(
    `${r.label.padEnd(14)}  ${pct(r.fresh)} ${pct(r.freshWorst)} ${pct(r.freshFar)}      ` +
      `${pct(r.carried)} ${pct(r.carriedWorst)} ${pct(r.carriedFar)}`,
  );
}
const w = measure.walk;
console.log(
  `a walk of ${w.steps} changes: median ${pct(w.median)} of panels move per step, 90th percentile ${pct(w.p90)}; ` +
    `laid out from scratch ${w.freshTaken} times; fill at worst ${(w.worstGap * 100).toFixed(1)} points under scratch`,
);

// What the carrying over is for. The thresholds are a few times what the
// fixture, pathsim, rapidfem and rslab measure, so they catch a regression to
// reshuffling rather than noise.
//
// In a project of a few dozen files nearly every panel is a sibling of the
// one that changed, and a panel that grows pushes its siblings along however
// the rectangle is cut, so there the share is no measure: nanospice's 23
// panels all move when one grows by fifty lines. What is asked of a small
// project is that they do not go far.
const at = (label) => measure.results.find((r) => r.label === label);
const small = measure.panels < 100;
for (const [label, most, far] of [['+5 lines', 0.02, 0.02], ['a new file', 0.15, 0.05]]) {
  const r = at(label);
  if (!r) continue;
  if (small ? r.carriedFar > far : r.carried > most) {
    console.log(
      small
        ? `FAIL  ${label} moves a panel ${pct(r.carriedFar)} of the canvas carried over, more than ${pct(far)}`
        : `FAIL  ${label} moves ${pct(r.carried)} of panels carried over, more than ${pct(most)}`,
    );
    failures++;
  } else {
    console.log(`ok    ${label}, carried over, moves ${small ? `no panel further than ${pct(far)}` : `under ${pct(most)} of panels`}`);
  }
}
if (!small && w.median > 0.1) {
  console.log(`FAIL  a step of the walk moves a median ${pct(w.median)} of panels`);
  failures++;
}

// The assertion: a relayout of an unchanged file list costs nothing. That is
// what makes the reuse real rather than nominal, and it is the thing that
// would break silently if the scene stopped keeping its textures.
const cost = await page.evaluate(async () => {
  const app = window.__sanity.app;
  const source = app.lastSource;
  const run = async () => {
    const t0 = performance.now();
    app.open(source, true);
    const queued = app.pending.length;
    let frames = 0;
    while (app.settling() && frames < 900) {
      await new Promise((r) => requestAnimationFrame(r));
      frames++;
    }
    return { queued, ms: Math.round(performance.now() - t0) };
  };
  // Twice: the first settles whatever the viewport did to the layout, the
  // second is the measurement.
  await run();
  return run();
});
console.log(`relaying out an unchanged list: ${cost.queued} textures queued, ${cost.ms} ms`);
if (cost.queued > 0) {
  console.log(`FAIL  ${cost.queued} textures re-uploaded for a layout that did not change`);
  failures++;
} else {
  console.log('ok    an unchanged layout costs no texture work');
}

await browser.close();
console.log(
  failures === 0
    ? '\na relayout moves what changed and costs only what changed'
    : `\n${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
