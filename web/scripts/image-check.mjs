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
      let ground = 0;
      for (const [key, c] of seen) {
        if (c > top) {
          top = c;
          ground = key;
        }
      }

      // Padding, measured: rows and columns at the edge that hold nothing but
      // the background. The image is supposed to end where the project does,
      // so the answer is zero on every side.
      const edge = (px, py, dx, dy, steps) => {
        let bands = 0;
        for (let b = 0; b < steps; b++) {
          let flat = true;
          for (let i = 0; i < (dx === 0 ? bmp.width : bmp.height) && flat; i += 3) {
            const x = dx === 0 ? i : px + dx * b;
            const y = dx === 0 ? py + dy * b : i;
            const o = (y * bmp.width + x) * 4;
            const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
            if (key !== ground) flat = false;
          }
          if (!flat) break;
          bands++;
        }
        return bands;
      };
      const pad = {
        left: edge(0, 0, 1, 0, 64),
        right: edge(bmp.width - 1, 0, -1, 0, 64),
        top: edge(0, 0, 0, 1, 64),
        bottom: edge(0, bmp.height - 1, 0, -1, 64),
      };
      return {
        bytes: blob.size,
        width: bmp.width,
        height: bmp.height,
        colours: seen.size,
        drawnFrac: 1 - top / n,
        pad,
        ms,
        pxPerLine,
      };
    },
    [region, width, height],
  );

// What the project's own aspect is, so the image can be held to it.
const bounds = await page.evaluate(() => {
  const [x0, y0, x1, y1] = window.__sanity.app.layout.bounds;
  return { w: x1 - x0, h: y1 - y0 };
});

const whole = await render('project', 3840, 2160);
console.log(
  `project  ${whole.width}x${whole.height} · ${(whole.bytes / 1048576).toFixed(1)} MB · ` +
    `${whole.colours} colours · ${(whole.drawnFrac * 100).toFixed(0)}% not background · ` +
    `padding ${whole.pad.left}/${whole.pad.right}/${whole.pad.top}/${whole.pad.bottom} px · ${whole.ms} ms`,
);
// Inside the box, on the box on one side, and at the aspect of the thing it
// frames. A fixed 16:9 frame around a project that is not 16:9 is a border,
// which is what this replaced.
if (whole.width > 3840 || whole.height > 2160) {
  fail(`the image is ${whole.width}x${whole.height}, which is outside the 3840x2160 box`);
}
if (whole.width !== 3840 && whole.height !== 2160) {
  fail(`the image is ${whole.width}x${whole.height}, so it fills neither side of the box`);
}
const want = bounds.w / bounds.h;
const got = whole.width / whole.height;
if (Math.abs(want - got) / want > 0.002) {
  fail(`the image is ${got.toFixed(3)} wide for one high where the project is ${want.toFixed(3)}`);
}
const padded = Object.entries(whole.pad).filter(([, v]) => v > 0);
if (padded.length > 0) {
  fail(`the image has background padding: ${padded.map(([k, v]) => `${v} px ${k}`).join(', ')}`);
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
if (png.width !== whole.width || png.height !== whole.height) {
  fail(
    `the downloaded file is ${png.width}x${png.height} where the render was ` +
      `${whole.width}x${whole.height}`,
  );
}
rmSync(to, { force: true });

await browser.close();
console.log(failures === 0 ? '\nthe export is a 4K picture of the project' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
