// Asserts that the PNG export is a picture of the project, at the size asked
// for, and that the canvas survives it.
//
// Three things can go wrong here and two of them are silent. The export lends
// the camera a 4K viewport and stops the render loop, so a restore that misses
// anything leaves the window showing a corner of itself or frozen. And a
// drawing buffer past its limit does not throw, it comes back blank, which is
// why the pixels are counted rather than the bytes.
//
// The fourth thing is the interesting one: the image is not an upscale of the
// window. Level of detail follows from pixels per line, so a 4K frame of the
// same world rect has more in it than the screen does, and the check reports
// both numbers.

import { readFileSync, rmSync } from 'node:fs';
import { decodePng } from './png.mjs';
import { base, launch, settled, src } from './browser.mjs';

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
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

// What the window looks like right now, to compare against.
const before = await page.evaluate(() => ({
  cam: { ...{ x: window.__sanity.app.cam.x, y: window.__sanity.app.cam.y, zoom: window.__sanity.app.cam.zoom } },
  canvas: [document.querySelector('canvas').width, document.querySelector('canvas').height],
  vw: window.__sanity.app.cam.vw,
  dpr: window.__sanity.app.cam.dpr,
  pxPerLine: window.__sanity.app.stats.pxPerLine,
}));

/** Render one and report what came out, without leaving the page. */
const render = (region, width, height) =>
  page.evaluate(
    async ([region, width, height]) => {
      const app = window.__sanity.app;
      const t0 = performance.now();
      const blob = await app.renderToBlob({ width, height, region });
      const ms = Math.round(performance.now() - t0);
      // Read before anything else is awaited: the loop comes back the moment
      // the export is done and rewrites these with the window's numbers.
      const pxPerLine = app.scene.stats.pxPerLine;
      // Decoded here rather than sent over: the point is what is in the
      // pixels, and 8 megabytes of base64 to answer that is absurd.
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const { data } = g.getImageData(0, 0, bmp.width, bmp.height);
      // Every 97th pixel, which is coprime with the row length, so the sample
      // walks the whole image rather than one column of it.
      const seen = new Map();
      let n = 0;
      for (let i = 0; i < data.length; i += 4 * 97) {
        const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        seen.set(key, (seen.get(key) ?? 0) + 1);
        n++;
      }
      // Measured against the commonest colour rather than against black: an
      // empty export is not a black image, it is the theme's background, and
      // that is exactly what a blank one would be full of.
      let top = 0;
      for (const c of seen.values()) top = Math.max(top, c);
      return {
        bytes: blob.size,
        width: bmp.width,
        height: bmp.height,
        colours: seen.size,
        drawnFrac: 1 - top / n,
        ms,
        pxPerLine,
      };
    },
    [region, width, height],
  );

const whole = await render('project', 3840, 2160);
console.log(
  `project  ${whole.width}x${whole.height} · ${(whole.bytes / 1048576).toFixed(1)} MB · ` +
    `${whole.colours} colours · ${(whole.drawnFrac * 100).toFixed(0)}% not background · ${whole.ms} ms`,
);
if (whole.width !== 3840 || whole.height !== 2160) {
  fail(`asked for 3840x2160 and got ${whole.width}x${whole.height}`);
}
if (whole.colours < 40) fail(`only ${whole.colours} colours in the image, so it is not a render`);
if (whole.drawnFrac < 0.2) {
  fail(`${((1 - whole.drawnFrac) * 100).toFixed(0)}% of the image is one flat colour, so nothing was drawn`);
}

// The canvas is back the way it was: same size, same camera, and still drawing.
await settled(page);
const after = await page.evaluate(() => ({
  cam: { x: window.__sanity.app.cam.x, y: window.__sanity.app.cam.y, zoom: window.__sanity.app.cam.zoom },
  canvas: [document.querySelector('canvas').width, document.querySelector('canvas').height],
  vw: window.__sanity.app.cam.vw,
  dpr: window.__sanity.app.cam.dpr,
  pxPerLine: window.__sanity.app.stats.pxPerLine,
}));
const same = (a, b) => Math.abs(a - b) < 1e-6;
if (!same(before.cam.zoom, after.cam.zoom) || !same(before.cam.x, after.cam.x)) {
  fail(`the camera moved: ${JSON.stringify(before.cam)} became ${JSON.stringify(after.cam)}`);
}
if (String(before.canvas) !== String(after.canvas) || before.dpr !== after.dpr) {
  fail(`the canvas came back as ${after.canvas} at dpr ${after.dpr}, was ${before.canvas} at ${before.dpr}`);
}
if (!same(before.pxPerLine, after.pxPerLine)) {
  fail(`the window is drawing at ${after.pxPerLine} px/line, was ${before.pxPerLine}`);
}
// Drawing again, which `settled` cannot tell from frozen: force a frame.
const draws = await page.evaluate(async () => {
  const app = window.__sanity.app;
  const n = app.drawn;
  app.cam.zoom *= 1.05;
  app.invalidate();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return app.drawn - n;
});
if (draws === 0) fail('the render loop did not come back after the export');
// The claim the feature rests on: a bigger frame is a different picture, not
// the same one scaled up.
if (whole.pxPerLine <= after.pxPerLine * 1.5) {
  fail(
    `the image draws at ${whole.pxPerLine.toFixed(2)} px/line against ` +
      `${after.pxPerLine.toFixed(2)} on screen, so it is a screenshot, not a render`,
  );
}
console.log(
  `window   ${after.canvas.join('x')} at dpr ${after.dpr} · ` +
    `${after.pxPerLine.toFixed(2)} px/line on screen against ` +
    `${whole.pxPerLine.toFixed(2)} in the image · ${draws} frame(s) after`,
);

// And the way a user gets one: the context menu, and a real download.
await settled(page);
await page.locator('canvas').click({ button: 'right', position: { x: 600, y: 400 } });
await page.waitForTimeout(250);
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 180000 }),
  page.locator('.item:has-text("Save whole project")').click(),
]);
const to = '/tmp/sanity-image-check.png';
await download.saveAs(to);
const bytes = readFileSync(to);
const png = decodePng(bytes);
console.log(
  `download ${download.suggestedFilename()} · ${png.width}x${png.height} · ` +
    `${(bytes.length / 1048576).toFixed(1)} MB`,
);
if (!/\.png$/.test(download.suggestedFilename())) {
  fail(`the download is called ${download.suggestedFilename()}`);
}
if (png.width !== 3840 || png.height !== 2160) {
  fail(`the downloaded file is ${png.width}x${png.height}`);
}
rmSync(to, { force: true });

await browser.close();
console.log(failures === 0 ? '\nthe export is a 4K picture of the project' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
