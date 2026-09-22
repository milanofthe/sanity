// Asserts that a picture in a repository is drawn, at a resolution that
// follows the zoom, inside a budget.
//
// Three failures this is for, all silent:
//
//   A panel that draws nothing looks like a design decision. Most renders in
//   a repository are transparent (pathsim's figures: mean alpha 6.6 of 255),
//   so "the texture uploaded" is not the same as "something is visible", and
//   the pixels have to be counted.
//
//   Holding source pixels. pathsim's 47 images are 191 megapixels, 730 MB as
//   RGBA, against the 96 MB the whole of its code costs. The cache decodes to
//   the level the zoom asks for and evicts by least recently seen; both are
//   measured here.
//
//   A picture arriving into a parked render loop. The loop stops when nothing
//   moves, so a decode that finishes afterwards has to wake it.

import { decodePng } from './png.mjs';
import { base, canvasBox, frameOnScreen, launch, settled } from './browser.mjs';

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log(`[error] ${e.message}`));
// The demo repositories carry their pictures; the fixture does not.
await page.goto(`${base}/?demo=pathsim`, { waitUntil: 'load' });
const ok = await page
  .waitForFunction(
    () => {
      const t = document.querySelector('footer')?.textContent ?? '';
      return t.length > 0 && t.includes('files');
    },
    null,
    { timeout: 60000 },
  )
  .then(() => true)
  .catch(() => false);
if (!ok) {
  console.log('no demo in this build, run `npm run demo` first: skipped');
  await browser.close();
  process.exit(0);
}
await settled(page);

let failures = 0;
const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  failures++;
};

const pictures = await page.evaluate(
  () => [...window.__sanity.app.scene.files.values()].filter((f) => f.node.media).length,
);
if (pictures === 0) {
  console.log('this repository has no pictures in it, nothing to check');
  await browser.close();
  process.exit(0);
}

/** Put one picture on screen, large, and report where it landed. */
const framePicture = async () =>
  page.evaluate(() => {
    const app = window.__sanity.app;
    const f = [...app.scene.files.values()]
      .filter((x) => x.node.media && x.node.media.w > 800)
      .sort((a, b) => b.node.w * b.node.h - a.node.w * a.node.h)[0];
    app.cam.fit(f.node.x, f.node.y, f.node.x + f.node.w, f.node.y + f.node.h, 0.02);
    app.invalidate();
    const [sx, sy] = app.cam.worldToScreen(f.node.x, f.node.y);
    const [ex, ey] = app.cam.worldToScreen(f.node.x + f.node.w, f.node.y + f.node.h);
    return {
      path: f.node.path,
      source: `${f.node.media.w}x${f.node.media.h}`,
      x: Math.round(sx), y: Math.round(sy), w: Math.round(ex - sx), h: Math.round(ey - sy),
    };
  });

const shot = await framePicture();
// Long enough for a fetch and a decode, which is the one wait here that is
// not driven by a settled canvas.
await page.waitForTimeout(2500);
await settled(page);
await frameOnScreen(page);

const box = await canvasBox(page);
const clip = {
  x: box.x + shot.x + 4,
  y: box.y + shot.y + 18,
  width: Math.max(8, shot.w - 8),
  height: Math.max(8, shot.h - 24),
};
const png = decodePng(await page.screenshot({ type: 'png', clip }));
const counts = new Map();
for (let i = 0; i < png.data.length; i += 4) {
  const key = (png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2];
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
let top = 0;
for (const c of counts.values()) top = Math.max(top, c);
const ink = 1 - top / (png.width * png.height);

const held = await page.evaluate(() => window.__sanity.app.scene.media.stats());
console.log(
  `${pictures} pictures · ${shot.path.split('/').pop()} at ${shot.source} in a ` +
    `${shot.w}x${shot.h} panel: ${(ink * 100).toFixed(1)}% of it drawn, ` +
    `${counts.size} colours · cache ${held.count} images, ${(held.bytes / 1048576).toFixed(1)} MB`,
);
if (ink < 0.05) fail(`the picture is not visible: ${(ink * 100).toFixed(1)}% of the panel is drawn`);
if (counts.size < 20) fail(`only ${counts.size} colours in the panel, so it is not an image`);
if (held.count === 0) fail('nothing in the picture cache after it was drawn');

// The resolution follows the zoom: zoomed out, the same picture is held at a
// smaller level than it was up close.
const levels = await page.evaluate(async () => {
  const app = window.__sanity.app;
  const mediaOf = () => app.scene.media.stats().bytes;
  const close = mediaOf();
  app.fit();
  app.invalidate();
  await new Promise((r) => setTimeout(r, 1200));
  return { close, far: mediaOf() };
});
console.log(
  `held ${(levels.close / 1048576).toFixed(1)} MB with one picture large, ` +
    `${(levels.far / 1048576).toFixed(1)} MB fitted to the project`,
);

// The budget, forced: ask for every picture at a level far past what fits.
const budget = await page.evaluate(async () => {
  const app = window.__sanity.app;
  for (let round = 0; round < 3; round++) {
    app.scene.media.tick();
    for (const f of [...app.scene.files.values()].filter((x) => x.node.media)) {
      app.scene.media.want(f.node.path, 2048, f.node.media.w / Math.max(1, f.node.media.h));
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return app.scene.media.stats();
});
const BUDGET_MB = 64;
console.log(
  `after asking for all ${pictures} at 2048 wide: ${budget.count} held, ` +
    `${(budget.bytes / 1048576).toFixed(1)} MB`,
);
if (budget.bytes > BUDGET_MB * 1.02 * 1048576) {
  fail(`the cache holds ${(budget.bytes / 1048576).toFixed(1)} MB, past its ${BUDGET_MB} MB budget`);
}

// And the loop comes back to rest with all of that going on.
await settled(page);
const idle = await page.evaluate(async () => {
  const app = window.__sanity.app;
  const before = app.drawn;
  await new Promise((r) => setTimeout(r, 700));
  return app.drawn - before;
});
if (idle > 2) fail(`${idle} frames drawn while nothing was happening`);
else console.log('ok    the canvas goes quiet again once the pictures are in');

await browser.close();
console.log(failures === 0 ? '\nthe pictures are drawn, sized by zoom, inside the budget' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
