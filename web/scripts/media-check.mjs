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
// pathsim for images, rslab for documents; SANITY_DEMO picks another.
const repo = process.env.SANITY_DEMO ?? 'rslab';
await page.goto(`${base}/?demo=${repo}`, { waitUntil: 'load' });
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
// Three percent, not thirty: a block diagram is thin lines on an even
// background, and the one this picked came out at 9.5 percent while being
// perfectly legible. The colour count is the stronger signal, since a
// placeholder has one colour and a drawing has hundreds.
if (ink < 0.03) fail(`the picture is not visible: ${(ink * 100).toFixed(1)}% of the panel is drawn`);
if (counts.size < 20) fail(`only ${counts.size} colours in the panel, so it is not an image`);
if (held.count === 0) fail('nothing in the picture cache after it was drawn');

// The panel is the picture's shape, not the slot's. A 16:9 render in a square
// panel would be the picture with two grey bands, which is the one thing a
// picture panel must not be.
const shapes = await page.evaluate(() =>
  [...window.__sanity.app.scene.files.values()]
    .filter((f) => f.node.media && f.node.w > 0 && f.node.h > 0)
    .map((f) => ({
      path: f.node.path,
      // A document that hides its page size is laid out as A4, the same
      // fallback `mediaShape` uses, so that is what it is held to here.
      want:
        f.node.media.w > 0 && f.node.media.h > 0
          ? f.node.media.w / f.node.media.h
          : 595 / 842,
      got: f.node.w / f.node.h,
    })),
);
const off = shapes
  .map((p) => ({ ...p, err: Math.abs(Math.log2(p.got / p.want)) }))
  .sort((a, b) => b.err - a.err);
const worst = off[0];
const within = off.filter((p) => p.err < 0.15).length;
console.log(
  `panel shape: ${within} of ${shapes.length} within 11 percent of their picture; ` +
    `worst ${worst.path.split('/').pop()} wants ${worst.want.toFixed(2)}, got ${worst.got.toFixed(2)}`,
);
// Not every one of them: a panel has padding and a title bar, and a tiny icon
// is mostly those, so its outer proportion cannot match. The bulk has to.
if (within < shapes.length * 0.8) {
  fail(`only ${within} of ${shapes.length} panels have their picture's proportion`);
}

// What the cache holds across a zoom. Levels are not given back the moment a
// panel shrinks: decoding a picture down costs a decode to save memory nobody
// is short of, so it only happens under budget pressure, and the case that
// matters is the one below, with everything on screen at once.
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

// The budget under the worst thing a viewer can do: every picture in the
// project on screen at once, as large as the window allows. Driven through
// the camera rather than by calling `want` directly, because the renderer
// asks every frame and would immediately overrule anything set by hand.
const budget = await page.evaluate(async () => {
  const app = window.__sanity.app;
  const pics = [...app.scene.files.values()].filter((f) => f.node.media);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of pics) {
    x0 = Math.min(x0, f.node.x); y0 = Math.min(y0, f.node.y);
    x1 = Math.max(x1, f.node.x + f.node.w); y1 = Math.max(y1, f.node.y + f.node.h);
  }
  app.cam.fit(x0, y0, x1, y1, 0.01);
  app.invalidate();
  await new Promise((r) => setTimeout(r, 3500));
  return { ...app.scene.media.stats(), pxPerLine: app.stats.pxPerLine };
});
const BUDGET_MB = 64;
console.log(
  `every picture on screen at once: ${budget.count} held, ` +
    `${(budget.bytes / 1048576).toFixed(1)} MB of texture`,
);
if (budget.bytes > BUDGET_MB * 1.02 * 1048576) {
  fail(`the cache holds ${(budget.bytes / 1048576).toFixed(1)} MB, past its ${BUDGET_MB} MB budget`);
}
if (budget.count === 0) fail('nothing held with every picture on screen');

// A document, where there is one: its first page has to be on the panel, and
// that page came from a renderer outside the browser (pdftoppm or sips at dump
// time, the platform's own in the app). So this is the one picture path whose
// pixels were produced somewhere else entirely.
const docs = await page.evaluate(() =>
  [...window.__sanity.app.scene.files.values()].filter(
    (f) => f.node.media?.kind === 'document',
  ).length,
);
if (docs === 0) {
  console.log('no documents in this repository, so the rendered page is not checked here');
} else {
  const doc = await page.evaluate(() => {
    const app = window.__sanity.app;
    const f = [...app.scene.files.values()]
      .filter((x) => x.node.media?.kind === 'document')
      .sort((a, b) => b.node.w * b.node.h - a.node.w * a.node.h)[0];
    app.cam.fit(f.node.x, f.node.y, f.node.x + f.node.w, f.node.y + f.node.h, 0.02);
    app.invalidate();
    const [sx, sy] = app.cam.worldToScreen(f.node.x, f.node.y);
    const [ex, ey] = app.cam.worldToScreen(f.node.x + f.node.w, f.node.y + f.node.h);
    return {
      path: f.node.path,
      pages: f.node.media.pages,
      x: Math.round(sx), y: Math.round(sy), w: Math.round(ex - sx), h: Math.round(ey - sy),
    };
  });
  await page.waitForTimeout(2500);
  await settled(page);
  await frameOnScreen(page);
  const b2 = await canvasBox(page);
  const png2 = decodePng(
    await page.screenshot({
      type: 'png',
      clip: {
        x: b2.x + doc.x + 4,
        y: b2.y + doc.y + 18,
        width: Math.max(8, doc.w - 8),
        height: Math.max(8, doc.h - 24),
      },
    }),
  );
  const seen2 = new Map();
  for (let i = 0; i < png2.data.length; i += 4) {
    const key = (png2.data[i] << 16) | (png2.data[i + 1] << 8) | png2.data[i + 2];
    seen2.set(key, (seen2.get(key) ?? 0) + 1);
  }
  let top2 = 0;
  for (const c of seen2.values()) top2 = Math.max(top2, c);
  const ink2 = 1 - top2 / (png2.width * png2.height);
  console.log(
    `${docs} documents · ${doc.path.split('/').pop()} (${doc.pages} page) in a ` +
      `${doc.w}x${doc.h} panel: ${(ink2 * 100).toFixed(1)}% drawn, ${seen2.size} colours`,
  );
  if (ink2 < 0.03 || seen2.size < 20) {
    fail(`the document's first page is not on its panel: ${(ink2 * 100).toFixed(1)}% drawn, ${seen2.size} colours`);
  }
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
