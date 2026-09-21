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
await page.evaluate(() => {
  const app = window.__sanity.app;
  for (const f of app.scene.files.values()) {
    if (f.node.stub) continue;
    if (f.data.lineCount < 120) continue;
    app.cam.x = f.node.x + f.node.w / 2;
    app.cam.y = f.node.y + f.node.h / 2;
    app.cam.zoom = 5 / 14;
    window.__sanity.target = f.node.path;
    return;
  }
});
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

const before = await page.screenshot({ type: 'png' });

// Cut eight lines out of the middle and watch what happens.
const started = await page.evaluate((path) => {
  const app = window.__sanity.app;
  const f = app.scene.files.get(path);
  const mid = Math.floor(f.data.lineCount / 2);
  const next = window.__sanity.spliced(mid, 8);
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
}, target);
console.log(
  `${started.linesBefore} lines -> ${started.linesAfter}, phase ${started.phase}, ` +
    `${started.removed} removed and ${started.added} added, showing ${started.showing}`,
);

if (started.phase !== 'remove') fail(`the change started in phase ${started.phase}, not remove`);
else console.log('ok    a change starts by taking the old lines away');

if (started.removed !== 8) fail(`${started.removed} lines reported removed, expected 8`);
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
  return { lines: n, state: f.state, heat: f.heat };
}, target);
console.log(`${marked.lines} lines marked, panel state ${marked.state}, heat ${marked.heat.toFixed(2)}`);
if (marked.lines === 0) {
  fail('the change left no mark, so a save is invisible a second later');
} else {
  console.log('ok    the changed lines keep a band after the animation');
}

// And it has to be on screen, not only in the data.
await frameOnScreen(page);
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
const markPixels = pixelDiff(decodePng, withMarks, bare);
if (markPixels < 200) fail(`the marks moved only ${markPixels} pixels`);
else console.log(`ok    the marks are on screen (${markPixels} pixels)`);

// They fade with the heat, and go when it runs out.
const faded = await page.evaluate(async (path) => {
  const f = window.__sanity.app.scene.files.get(path);
  f.heat = 0.0001;
  // A few frames, because the decay is per frame and the clearing happens on
  // the frame that finds the panel cold.
  for (let i = 0; i < 6 && f.heat > 0; i++) {
    await new Promise((r) => requestAnimationFrame(r));
  }
  await new Promise((r) => requestAnimationFrame(r));
  let left = 0;
  for (let i = 0; i < f.data.lineState.length; i++) if (f.data.lineState[i] !== 0) left++;
  return { left, state: f.state, heat: f.heat };
}, target);
if (faded.left !== 0 || faded.state !== 0) {
  fail(`a cold panel still carries ${faded.left} marks: an old change would light up again`);
} else {
  console.log('ok    the marks clear when the panel goes cold');
}

await browser.close();
console.log(
  failures === 0
    ? '\na change plays as remove then add, and leaves a mark that fades'
    : `\n${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
