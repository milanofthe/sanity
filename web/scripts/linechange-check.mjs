// Asserts that a change plays as one gesture and leaves a mark.
//
// The lines that go away go away first, and only then do the new ones arrive.
// Afterwards the lines that arrived keep a band, which fades out with the
// panel's glow: a save is worth seeing for a while and not beyond it.
//
// There used to be a second check for the same thing driven by git's per-line
// state against a baseline. That went with the baseline: changes are shown per
// save now, from a diff of the two versions, so this is the only path there
// is.
//
// That order is the whole point. Swapping the content and highlighting the
// result reads as a flicker; taking the old lines out, then putting the new
// ones in, reads as an edit. So the check asserts the sequence, not just that
// something happened, and it does it in pixels as well as in state, because
// the state could be right while nothing is drawn.

import { decodePng } from './png.mjs';
import { base, frameOnScreen, launch, pixelDiff, settled, src } from './browser.mjs';

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log(`[error] ${e.message}`));
await page.goto(`${base}/?${src}`, { waitUntil: 'load' });
await page.waitForFunction(
  () => {
    const t = document.querySelector('footer')?.textContent ?? '';
    return t.length > 0 && !t.includes('indexing');
  },
  null,
  { timeout: 180000 },
);
await settled(page);

let failures = 0;
const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  failures++;
};

// A zoom where the bands are drawn at all: they come up with the token bars.
//
// Set here and again before the measurement at the end. A change relayouts the
// project and the app refits the camera when the new layout no longer fits the
// old view, so the zoom set at the start does not necessarily survive the
// edit: about one run in three came back at the fit zoom, where the panel is
// fourteen pixels wide, and the check reported a missing band rather than a
// camera that had moved.
const ZOOM = 5 / 14;

/** Put the camera on the target panel, and pick the target on the first call. */
const place = async () =>
  page.evaluate((zoom) => {
    const app = window.__sanity.app;
    for (const f of app.scene.files.values()) {
      if (f.node.stub) continue;
      if (f.data.lineCount < 120) continue;
      if (window.__sanity.target && f.node.path !== window.__sanity.target) continue;
      app.cam.x = f.node.x + f.node.w / 2;
      app.cam.y = f.node.y + f.node.h / 2;
      app.cam.zoom = zoom;
      window.__sanity.target = f.node.path;
      return;
    }
  }, ZOOM);

await place();
await settled(page);
await frameOnScreen(page);

const target = await page.evaluate(() => window.__sanity.target);
if (!target) {
  fail('no file large enough to edit was found');
  await browser.close();
  process.exit(1);
}
console.log(`editing ${target}`);

// Build a version of the file with a run of lines cut out of the middle. A
// real removal, through the same payload shape the backend produces, so what
// the diff sees is what it would see from the watcher.
await page.evaluate((path) => {
  window.__sanity.spliced = (from, count) => {
    const app = window.__sanity.app;
    const f = app.scene.files.get(path);
    const d = f.data;
    const keep = [];
    for (let i = 0; i < d.lineCount; i++) if (i < from || i >= from + count) keep.push(i);
    const spanStart = new Uint32Array(keep.length + 1);
    const spans = [];
    for (let k = 0; k < keep.length; k++) {
      spanStart[k] = spans.length;
      const i = keep[k];
      for (let s = d.spanStart[i]; s < d.spanStart[i + 1]; s++) spans.push(d.spans[s]);
    }
    spanStart[keep.length] = spans.length;
    return {
      lineCount: keep.length,
      langId: d.langId,
      flags: d.flags,
      spanStart,
      lineCols: Uint16Array.from(keep.map((i) => d.lineCols[i])),
      lineIndent: Uint8Array.from(keep.map((i) => d.lineIndent[i])),
      lineState: Uint8Array.from(keep.map((i) => d.lineState[i])),
      spans: Uint32Array.from(spans),
    };
  };
}, target);

// Placed again: between the first call and here the fixture finishes loading
// its text, which reopens the scene and refits the camera.
await place();
await settled(page);
await frameOnScreen(page);
const before = await page.screenshot({ type: 'png' });

// Cut eight lines out of the middle and watch what happens.
//
// Not out of the exact middle. A pure deletion leaves its mark on the one line
// the removed run used to sit above, and the band is drawn across that line's
// text, so how many pixels it covers is how long that line is. Cutting at the
// centre of this file landed the seam on a closing brace, five columns wide,
// and the check failed on sixteen pixels while the band was drawn exactly as
// intended. It was measuring the length of an arbitrary line of vendored code.
// So the cut moves to the nearest position whose seam line has something on
// it, and the width it asserts on is a width it chose.
const CUT = 8;
const seam = await page.evaluate(
  ([path, count]) => {
    const cols = window.__sanity.app.scene.files.get(path).data.lineCols;
    const mid = Math.floor(cols.length / 2);
    for (let d = 0; d < mid - count - 1; d++) {
      for (const from of [mid + d, mid - d]) {
        if (from < 1 || from + count >= cols.length) continue;
        if (cols[from + count] >= 30) return { from, cols: cols[from + count] };
      }
    }
    return { from: mid, cols: cols[mid + count] };
  },
  [target, CUT],
);
console.log(`cutting ${CUT} lines at ${seam.from}, seam lands on a line of ${seam.cols} columns`);

const started = await page.evaluate(([path, mid, count]) => {
  const app = window.__sanity.app;
  const f = app.scene.files.get(path);
  const next = window.__sanity.spliced(mid, count);
  const linesBefore = f.data.lineCount;
  app.touch(path, next);
  return {
    linesBefore,
    linesAfter: next.lineCount,
    // Still the old content: the removal plays against the version the removed
    // lines belong to.
    showing: f.data.lineCount,
    phase: f.change?.phase ?? null,
    removed: f.change?.removedRows.length ?? 0,
    added: f.change?.addedRows.length ?? 0,
  };
}, [target, seam.from, CUT]);
console.log(
  `${started.linesBefore} lines -> ${started.linesAfter}, phase ${started.phase}, ` +
    `${started.removed} removed and ${started.added} added, showing ${started.showing}`,
);

if (started.phase !== 'remove') fail(`the change started in phase ${started.phase}, not remove`);
else console.log('ok    a change starts by taking the old lines away');

if (started.removed !== CUT) fail(`${started.removed} lines reported removed, expected ${CUT}`);
else console.log('ok    the diff found exactly the lines that were cut');

if (started.showing !== started.linesBefore) {
  fail('the content was swapped before the removal played');
} else {
  console.log('ok    the old content is still on screen while its lines leave');
}

// The removal has to be visible.
await frameOnScreen(page);
const removing = await page.screenshot({ type: 'png' });
const removeDiff = pixelDiff(decodePng, before, removing);
if (removeDiff < 200) fail(`the removal moved only ${removeDiff} pixels`);
else console.log(`ok    the removal is on screen (${removeDiff} pixels)`);

// Then the content swaps and the new lines arrive.
await page.waitForFunction(
  (path) => window.__sanity.app.scene.files.get(path)?.change?.phase === 'add',
  target,
  { timeout: 5000 },
).catch(() => fail('the change never reached the add phase'));

const adding = await page.evaluate((path) => {
  const f = window.__sanity.app.scene.files.get(path);
  return { showing: f.data.lineCount, phase: f.change?.phase ?? null };
}, target);
if (adding.showing !== started.linesAfter) {
  fail(`the new content did not land: showing ${adding.showing} of ${started.linesAfter}`);
} else {
  console.log('ok    the new content lands when the removal is done');
}

await settled(page);
const rest = await page.evaluate((path) => {
  const f = window.__sanity.app.scene.files.get(path);
  return { change: f.change, lines: f.data.lineCount };
}, target);
if (rest.change !== null) fail('the change animation never finished');
else console.log('ok    it finishes');
if (rest.lines !== started.linesAfter) fail('the file did not end up as the new version');

await frameOnScreen(page);
const after = await page.screenshot({ type: 'png' });
if (pixelDiff(decodePng, removing, after) < 200) {
  fail('the picture at rest is the same as during the removal');
} else {
  console.log('ok    the end state differs from the removal');
}

// The lines that arrived keep a mark once the animation is over.
const marked = await page.evaluate((path) => {
  const f = window.__sanity.app.scene.files.get(path);
  let n = 0;
  for (let i = 0; i < f.data.lineState.length; i++) if (f.data.lineState[i] !== 0) n++;
  return { lines: n, state: f.state, since: f.since };
}, target);
console.log(
  `${marked.lines} lines marked, panel state ${marked.state}, ` +
    `${marked.since.toFixed(2)} s since the change`,
);
if (marked.lines === 0) {
  fail('the change left no mark, so a save is invisible a second later');
} else {
  console.log('ok    the changed lines keep a band after the animation');
}

// And it has to be on screen, not only in the data.
//
// The camera goes to the marked row, and the diff is restricted to it. Two
// things were wrong with comparing whole screenshots from where the camera
// happened to be. A change relayouts the project, so the panel does not stay
// put; and a panel taller than the viewport shows only a band of its rows,
// while a pure deletion marks the single line the removed run sat above, which
// is wherever it is. Centred on the panel, that line was off screen: the
// check read 57 pixels of frame-to-frame noise against a bar of 200 and
// reported a band that was drawn exactly as intended. The row's world
// position comes from the renderer's own row mapping rather than from
// arithmetic repeated here, which would drift the moment the layout changes.
const rect = await page.evaluate(([path, zoom]) => {
  const app = window.__sanity.app;
  const sc = app.scene;
  const f = sc.files.get(path);
  app.cam.zoom = zoom;
  let line = -1;
  for (let i = 0; i < f.data.lineState.length; i++) {
    if (f.data.lineState[i] !== 0) {
      line = i;
      break;
    }
  }
  const row = f.rows[line];
  const col = Math.floor(row / f.node.geom.linesPerColumn);
  sc.rowInfo(f, row, col);
  app.cam.x = f.node.x + f.node.w / 2;
  app.cam.y = sc.riY;
  app.invalidate();
  const dpr = app.cam.dpr;
  const [px] = app.cam.worldToScreen(f.node.x, f.node.y);
  const [, ry] = app.cam.worldToScreen(f.node.x, sc.riY);
  // The camera works in canvas coordinates and a screenshot is of the whole
  // window, so the canvas origin has to be added. Without it the rect sat 34
  // pixels too high, the height of the toolbar, and the check read zero while
  // the band was on screen one row below the window it was looking at.
  const box = document.querySelector('canvas').getBoundingClientRect();
  // The marked line and the row below it, since a wrapped line keeps its band
  // on every row it occupies.
  return {
    line,
    row,
    col,
    x: (box.x + px) * dpr,
    y: (box.y + ry - 2) * dpr,
    w: f.node.w * app.cam.zoom * dpr,
    // Two rows tall. From the zoom just set rather than from the renderer's
    // stats, which describe the frame before it.
    h: (2 * 14 * zoom + 4) * dpr,
  };
}, [target, ZOOM]);
await settled(page);
await frameOnScreen(page);
console.log(
  `marked line ${rect.line} is row ${rect.row} of column ${rect.col}, ` +
    `${Math.round(rect.w)} by ${Math.round(rect.h)} pixels on screen`,
);
if (rect.w < 100) {
  // Says which of the two failures this is: a band that is not drawn, or a
  // camera that is not where the measurement thinks it is.
  fail(`the panel is only ${Math.round(rect.w)} pixels wide, so the camera did not stay put`);
}
const withMarks = await page.screenshot({ type: 'png' });
const withoutMarks = await page.evaluate((path) => {
  const f = window.__sanity.app.scene.files.get(path);
  const kept = Array.from(f.data.lineState);
  f.data.lineState.fill(0);
  const wasState = f.state;
  f.state = 0;
  return { kept, wasState };
}, target);
await frameOnScreen(page);
const bare = await page.screenshot({ type: 'png' });
await page.evaluate(([path, saved]) => {
  const f = window.__sanity.app.scene.files.get(path);
  f.data.lineState.set(saved.kept);
  f.state = saved.wasState;
}, [target, withoutMarks]);
const markPixels = pixelDiff(decodePng, withMarks, bare, 20, rect);
if (markPixels < 200) fail(`the marks moved only ${markPixels} pixels inside the panel`);
else console.log(`ok    the marks are on screen (${markPixels} pixels inside the panel)`);

// They are held for a few seconds and then go, so an old change cannot be
// mistaken for a new one.
const faded = await page.evaluate(async (path) => {
  const f = window.__sanity.app.scene.files.get(path);
  // Past the end of the window, which recency.ts owns.
  f.since = 1e6;
  // A few frames, because the decay is per frame and the clearing happens on
  // the frame that finds the panel cold.
  for (let i = 0; i < 6 && f.state !== 0; i++) {
    await new Promise((r) => requestAnimationFrame(r));
  }
  await new Promise((r) => requestAnimationFrame(r));
  let left = 0;
  for (let i = 0; i < f.data.lineState.length; i++) if (f.data.lineState[i] !== 0) left++;
  return { left, state: f.state };
}, target);
if (faded.left !== 0 || faded.state !== 0) {
  fail(`a cold panel still carries ${faded.left} marks: an old change would light up again`);
} else {
  console.log('ok    the marks clear when the panel goes cold');
}

// --- a change big enough to force a relayout still shows ---
//
// The case that was silently broken. A file whose new content does not fit its
// panel cannot be updated in place, so the treemap runs again, and the signal
// used to be lost on the way: the glow is set when a change is applied and the
// relayout path applied none. Measured on a real project, inserting eight
// lines into a 2263 line file showed nothing at all, and so did an edit that
// pushed one wrapped line over by four characters.
const grown = await page.evaluate(async (path) => {
  const app = window.__sanity.app;
  const f = app.scene.files.get(path);
  const d = f.data;
  // Twice the file, which no panel sized for one copy can hold.
  const n = d.lineCount;
  const keep = [...Array(n).keys(), ...Array(n).keys()];
  const spanStart = new Uint32Array(keep.length + 1);
  const spans = [];
  for (let k = 0; k < keep.length; k++) {
    spanStart[k] = spans.length;
    const i = keep[k];
    for (let s = d.spanStart[i]; s < d.spanStart[i + 1]; s++) spans.push(d.spans[s]);
  }
  spanStart[keep.length] = spans.length;
  const next = {
    lineCount: keep.length,
    langId: d.langId,
    flags: d.flags,
    spanStart,
    lineCols: Uint16Array.from(keep.map((i) => d.lineCols[i])),
    lineIndent: Uint8Array.from(keep.map((i) => d.lineIndent[i])),
    lineState: new Uint8Array(keep.length),
    spans: Uint32Array.from(spans),
  };

  const fits = app.fitsInPlace(path, next);
  let relayouts = 0;
  const structural = await app.applyBatch(
    [[path, next]],
    [],
    async () => {
      relayouts++;
      // The app's own relayout, which keeps the scene and the camera. The
      // `__sanity.relayout` helper builds a fresh scene instead, which is what
      // scripts/stability-check.mjs wants and the opposite of what a save
      // should do.
      app.relayout();
    },
    true,
  );
  const after = app.scene.files.get(path);
  return { fits, structural, relayouts, since: after.since };
}, target);
console.log(
  `doubling the file: fits in place ${grown.fits}, relayouts ${grown.relayouts}, ` +
    `${grown.since.toFixed(2)} s since the change`,
);

if (grown.fits) {
  fail('the doubled file still fits its panel, so this does not test the relayout path');
} else if (!grown.structural || grown.relayouts !== 1) {
  fail(`the batch reported structural=${grown.structural} with ${grown.relayouts} relayouts`);
} else if (!(grown.since < 0.5)) {
  fail(`the panel came out of the relayout ${grown.since.toFixed(2)} s stale, so it never flashed`);
} else {
  console.log('ok    a change that forces a relayout still glows');
}

// And once the animation is over it leaves marks, the same as an in-place one.
await page
  .waitForFunction((p) => !window.__sanity.app.scene.files.get(p).change, target, { timeout: 30000 })
  .catch(() => {});
await settled(page);
const marks = await page.evaluate((path) => {
  const f = window.__sanity.app.scene.files.get(path);
  let n = 0;
  for (let i = 0; i < f.data.lineState.length; i++) if (f.data.lineState[i] !== 0) n++;
  return { marked: n, state: f.state, changed: window.__sanity.app.changedCount() };
}, target);
console.log(`after the relayout: ${marks.marked} lines marked, panel state ${marks.state}`);
if (marks.marked === 0 || marks.changed === 0) {
  fail('a relayout swallowed the change: nothing is marked afterwards');
} else {
  console.log('ok    and it leaves the same line marks an in-place change would');
}

// A file that has just appeared arrives marked in full rather than neutral.
const created = await page.evaluate((path) => {
  const app = window.__sanity.app;
  const f = app.scene.files.get(path);
  f.data.lineState.fill(0);
  f.state = 0;
  f.since = Infinity;
  app.scene.markCreated([path]);
  let n = 0;
  for (let i = 0; i < f.data.lineState.length; i++) if (f.data.lineState[i] !== 0) n++;
  return { marked: n, of: f.data.lineCount, since: f.since, recent: app.recentCount() };
}, target);
if (created.marked !== created.of || created.since !== 0 || created.recent < 1) {
  fail(
    `a new file arrived with ${created.marked} of ${created.of} lines marked ` +
      `and a clock at ${created.since}`,
  );
} else {
  console.log(`ok    a new file arrives with all ${created.of} lines marked, and flashing`);
}

await browser.close();
console.log(
  failures === 0
    ? '\na change plays as remove then add, and leaves a mark that fades'
    : `\n${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
