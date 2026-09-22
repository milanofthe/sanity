// How even the spacing between letters is.
//
// A glyph at rest is drawn 1:1 from its atlas cell, so it starts on a whole
// pixel, and a character is rarely a whole number of pixels wide. Snapped one
// by one, the gaps between letters alternate: 6 and 7 pixels at 13.3 pixels
// per line on a dpr 1 screen. The atlas holds each glyph at four subpixel
// offsets and the shader draws the one nearest to where the glyph really
// falls; this measures whether that holds.
//
// Measured on a line that is a long run of '#': the ink centroid of each
// character, and the standard deviation of the distance from one to the next.
// Even spacing has none.
import { decodePng } from './png.mjs';
import { base, canvasBox, frameOnScreen, launch, settled } from './browser.mjs';

const ZOOMS = [9.1, 11.7, 13.3, 15.5, 18.2, 21.9];

/**
 * Largest mean deviation of the gaps, in device pixels, over the zooms.
 *
 * Measured, per zoom, before and after the subpixel variants:
 *
 *   Chromium dpr 1   0.19 to 0.44   ->  0.10 to 0.14
 *   Chromium dpr 2   0.28 to 0.48   ->  0.01 to 0.16
 *   WebKit   dpr 1   0.23 to 0.48   ->  0.12 to 0.15
 *   WebKit   dpr 2   0.28 to 0.49   ->  0.01 to 0.31
 *
 * WebKit gains less at dpr 2 because its canvas places text on a coarser
 * grid than a quarter pixel: offsets of 0 and 0.25 rasterise the same.
 */
const LIMIT = 0.25;

const browser = await launch();
let failures = 0;

for (const dpr of [1, 2]) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 }, deviceScaleFactor: dpr });
  await page.goto(`${base}/?demo=pathsim`, { waitUntil: 'load' });
  await page.waitForFunction(() => (document.querySelector('footer')?.textContent ?? '').includes('files'), null, { timeout: 60000 });
  await settled(page);

  const sds = [];
  for (const ppl of ZOOMS) {
    const info = await page.evaluate(async (v) => {
      const app = window.__sanity.app;
      window.__sanity.zoomTo(v / 14);
      // The first line in the project that is a long run of '#', in a column
      // wide enough to hold forty of them.
      for (const f of app.scene.files.values()) {
        if (f.node.stub || f.node.media || f.node.geom.cols < 44) continue;
        for (let line = 0; line < Math.min(f.data.lineCount, 40); line++) {
          const t = app.scene.text.lineText(f.node.path, line);
          if (!t || !/^#{40,}/.test(t)) continue;
          const r = app.scene.lineRect(f.node.path, line);
          app.cam.x = r[0] + 150;
          app.cam.y = r[1] + 7;
          // The exact atlas is built on the first still frame and used on the
          // next, so a few frames after the camera stops.
          for (let i = 0; i < 4; i++) {
            app.invalidate();
            await new Promise((q) => requestAnimationFrame(() => requestAnimationFrame(q)));
          }
          const [sx, sy] = app.cam.worldToScreen(r[0], r[1]);
          return { sx, sy, adv: 7 * app.cam.zoom, lh: 14 * app.cam.zoom, skip: f.node.geom.numberCols };
        }
      }
      return null;
    }, ppl);
    if (!info) {
      console.log(`FAIL  dpr ${dpr}: no line of '#' to measure on`);
      failures++;
      break;
    }
    await frameOnScreen(page);
    const box = await canvasBox(page);
    const png = decodePng(await page.screenshot({
      clip: { x: box.x + info.sx, y: box.y + info.sy, width: info.adv * (info.skip + 40), height: info.lh },
    }));

    // Ink per pixel column, above the background.
    const col = new Float64Array(png.width);
    let bg = 255;
    for (let x = 0; x < png.width; x++) {
      for (let y = 0; y < png.height; y++) {
        const i = (y * png.width + x) * 4;
        const l = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
        bg = Math.min(bg, l);
        col[x] += l;
      }
    }
    for (let x = 0; x < png.width; x++) col[x] = Math.max(0, col[x] - bg * png.height);

    // Where in a character cell the ink sits on average, as a circular mean,
    // so each window is centred on its glyph rather than cut through it.
    const advPx = info.adv * dpr;
    let cs = 0;
    let sn = 0;
    for (let x = 0; x < png.width; x++) {
      const a = 2 * Math.PI * (x / advPx);
      cs += col[x] * Math.cos(a);
      sn += col[x] * Math.sin(a);
    }
    const centre = ((Math.atan2(sn, cs) / (2 * Math.PI)) * advPx + advPx) % advPx;
    // Past the line-number margin, which is not part of the run.
    const cents = [];
    for (let k = info.skip + 1; k < info.skip + 38; k++) {
      const c = k * advPx + centre;
      let s = 0;
      let sx = 0;
      for (let x = Math.ceil(c - advPx / 2); x < c + advPx / 2; x++) {
        s += col[x];
        sx += col[x] * x;
      }
      if (s > 0) cents.push(sx / s);
    }
    const gaps = cents.slice(1).map((c, i) => c - cents[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    sds.push(Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length));
  }
  await page.close();
  if (sds.length === 0) continue;

  const mean = sds.reduce((a, b) => a + b, 0) / sds.length;
  console.log(
    `dpr ${dpr}  gaps deviate by ${sds.map((v) => v.toFixed(2)).join(', ')} px` +
      ` at ${ZOOMS.join(', ')} px/line, mean ${mean.toFixed(2)}`,
  );
  if (mean > LIMIT) {
    console.log(`FAIL  dpr ${dpr}: mean ${mean.toFixed(2)} px, over ${LIMIT}`);
    failures++;
  }
}

await browser.close();
console.log(failures === 0 ? '\nletters are evenly spaced' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
