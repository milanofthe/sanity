// Asserts that panels actually animate, and that they stop.
//
// Both halves matter. An animation that never starts is a cut, and nothing in
// a screenshot says which one you are looking at. An animation that never
// finishes holds the frame rate at full tilt forever, and since `settling` is
// what every other check waits on, one that stays true would hang the suite
// rather than fail it.
//
// Measured by pixels rather than by reading the animation state, so what is
// checked is what reaches the screen.

import { decodePng } from './png.mjs';
import { launch, base, src, frameOnScreen, pixelDiff, settled } from './browser.mjs';

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log(`[error] ${e.message}`));

let failures = 0;
const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  failures++;
};

// A fresh load: every panel settles in, staggered outward from the centre.
await page.goto(`${base}/?${src}`, { waitUntil: 'load' });
await page.waitForFunction(
  () => {
    const t = document.querySelector('footer')?.textContent ?? '';
    return t.length > 0 && !t.includes('indexing');
  },
  null,
  { timeout: 180000 },
);

// Two frames apart, while it should still be moving.
const moving = await page.evaluate(async () => {
  const app = window.__sanity.app;
  const seen = [];
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    seen.push(app.stats.settling);
  }
  return seen;
});
if (!moving.some((s) => s === true)) {
  fail('nothing was settling in the first thirty frames after a load');
} else {
  console.log(`ok    the load animation runs (${moving.filter(Boolean).length}/30 frames)`);
}

await settled(page);
const rest = await page.evaluate(() => window.__sanity.app.stats.settling);
if (rest !== false) fail('the animation never finished');
else console.log('ok    it finishes');

// How much two renders of the same settled scene differ, which is the floor
// the convergence check below has to stay above. Not asserted: the renderer
// only draws when something changed, so whether a settled canvas is still is
// a question about the frame loop and is answered in scripts/idle-check.mjs.
// What is left here is the GPU's own sampling nondeterminism through the mip
// chain, and forcing a redraw to measure it is the only way to see it.
await frameOnScreen(page);
const still1 = await page.screenshot({ type: 'png' });
await page.waitForTimeout(300);
await frameOnScreen(page);
const still2 = await page.screenshot({ type: 'png' });
await page.waitForTimeout(300);
await frameOnScreen(page);
const still3 = await page.screenshot({ type: 'png' });
const noise = Math.max(
  pixelDiff(decodePng, still1, still2),
  pixelDiff(decodePng, still2, still3),
  pixelDiff(decodePng, still1, still3),
);
// A quarter of a percent of the frame. An animation still running shows up as
// tens of thousands of pixels, so this is nowhere near it.
const noiseLimit = Math.max(noise * 2, 0.0025 * 900 * 600);
console.log(`sampling noise between two renders of the same scene: ${noise} pixels`);

// A relayout has to converge: every frame gets closer to the picture it is
// heading for. That is the property, and it holds however far along any one
// frame happens to be caught, which an absolute comparison against the old
// picture does not: easing moves fast early, so the first frame anyone can
// screenshot is already a third of the way there.
const relaid = await page.evaluate(async () => {
  const app = window.__sanity.app;
  const source = app.lastSource;
  // Drop a chunk of the file list, which forces every remaining panel into a
  // different slot. The same shape of change a watcher-driven relayout makes,
  // and far bigger, so the movement is unambiguous.
  const kept = source.entries.slice(0, Math.floor(source.entries.length * 0.7));
  app.open({ ...source, entries: kept }, true);
  return { files: kept.length, settling: app.settling() };
});
console.log(`relaid out to ${relaid.files} files, settling ${relaid.settling}`);
if (!relaid.settling) fail('a relayout that moves every panel did not start an animation');

const during = [];
for (let i = 0; i < 4; i++) {
  await frameOnScreen(page);
  during.push(await page.screenshot({ type: 'png' }));
  await page.waitForTimeout(70);
}
await settled(page);
await frameOnScreen(page);
const done = await page.screenshot({ type: 'png' });

const toEnd = during.map((f) => pixelDiff(decodePng, f, done));
console.log(`distance to the settled picture: ${toEnd.join(' -> ')}`);

// Strictly decreasing, with a little slack for the sampling noise measured
// above: the panels are converging on their places rather than jumping.
let converging = true;
for (let i = 1; i < toEnd.length; i++) {
  if (toEnd[i] > toEnd[i - 1] + noiseLimit) converging = false;
}
if (!converging) fail(`the relayout did not converge: ${toEnd.join(' -> ')}`);
else console.log('ok    every frame of a relayout is closer to the end than the last');

// And it has to actually move, or the first frame would already be the last.
if (toEnd[0] <= noiseLimit) {
  fail(`the first frame after a relayout was already the settled picture (${toEnd[0]} pixels)`);
} else {
  console.log(`ok    it moves on the way (${toEnd[0]} pixels to go at the start)`);
}

await browser.close();
console.log(failures === 0 ? '\npanels animate and come to rest' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
