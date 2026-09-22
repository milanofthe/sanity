// How sharp the text is.
//
// The canvas draws text from a glyph atlas, and two things blur it: an atlas
// cell drawn at a different size than it was rasterised at, and a glyph
// landing between pixels. Both are read through bilinear filtering at every
// edge.
//
// Measured at both device pixel ratios and over a sweep of zoom levels, most
// of which make a character a fractional number of pixels wide. The first
// version of this check sampled four zooms at dpr 2, which happened to be
// ones where the atlas cell came out 1:1, and it passed while a third of all
// zoom levels drew every glyph resampled: over twenty zooms at dpr 1 the worst
// of them had 30.7 percent of its edge pixels mid-ramp.
import { decodePng } from './png.mjs';
import { base, canvasBox, frameOnScreen, launch, settled } from './browser.mjs';

/** Zoom levels, in pixels per line. From where text takes over to well into
 *  reading size, in steps that land on fractional character widths. */
const ZOOMS = Array.from({ length: 12 }, (_, i) => 8 + i * 1.9);

/**
 * Largest share of edge pixels that may sit mid-ramp at any one zoom.
 *
 * Measured, mean and worst over these zooms: 13.8 and 18.0 percent at dpr 1,
 * 12.1 and 17.4 at dpr 2. With the cell scaled by the rounding of the atlas
 * size it was 14.8 and 18.9, 13.2 and 19.7, so this sits between the two.
 */
const LIMIT = 0.185;

/**
 * Softness, measured against a local reference.
 *
 * For each pixel, the darkest and lightest value within two pixels of it.
 * Where those differ enough there is an edge nearby, and the pixel's own value
 * says where in that transition it sits: at the ends it is background or ink,
 * in the middle it is the ramp between them. Sharp text has few pixels in the
 * middle, blurred text has many.
 *
 * Local, because a version with fixed thresholds counted a dimmed line number
 * and a green docstring as softness: both sit in the middle of the global
 * range while being perfectly crisp.
 */
function softness(png) {
  const lum = new Float64Array(png.width * png.height);
  for (let i = 0, p = 0; i < png.data.length; i += 4, p++) {
    lum[p] = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
  }
  let onEdge = 0;
  let inRamp = 0;
  for (let row = 0; row < png.height; row++) {
    const o = row * png.width;
    for (let x = 2; x < png.width - 2; x++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = -2; k <= 2; k++) {
        const v = lum[o + x + k];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo < 40) continue;
      onEdge++;
      const t = (lum[o + x] - lo) / (hi - lo);
      if (t > 0.25 && t < 0.75) inRamp++;
    }
  }
  return onEdge > 0 ? inRamp / onEdge : 0;
}

const browser = await launch();
let failures = 0;

for (const dpr of [1, 2]) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: dpr });
  await page.goto(`${base}/?demo=pathsim`, { waitUntil: 'load' });
  await page.waitForFunction(() => (document.querySelector('footer')?.textContent ?? '').includes('files'), null, { timeout: 60000 });
  await settled(page);

  /** One measurement: set the zoom, centre on a text panel, read the edges. */
  const sample = async (ppl, exact) => {
    // Centred on the longest text panel. The sample is the middle of the
    // canvas, which is where that panel now is: a fixed rectangle alone
    // measured whatever the layout happened to put there.
    await page.evaluate(([v, ex]) => {
      const app = window.__sanity.app;
      app.scene.exactGlyphAtlas = ex;
      window.__sanity.zoomTo(v / 14);
      const f = [...app.scene.files.values()]
        .filter((x) => !x.node.stub && !x.node.media && x.data.lineCount > 60)
        .sort((a, b) => b.data.lineCount - a.data.lineCount)[0];
      app.cam.x = f.node.x + f.node.w / 2;
      app.cam.y = f.node.y + f.node.h / 2;
      app.invalidate();
    }, [ppl, exact]);
    await page.waitForTimeout(250);
    // Three more frames after the camera stops: the exact atlas is rasterised
    // on the first frame that sees a still camera, and drawn from on the next.
    await page.evaluate(async () => {
      const app = window.__sanity.app;
      for (let i = 0; i < 3; i++) {
        app.invalidate();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
    });
    await frameOnScreen(page);
    const box = await canvasBox(page);
    return softness(decodePng(await page.screenshot({
      clip: { x: box.x + box.w / 2 - 200, y: box.y + box.h / 2 - 120, width: 400, height: 240 },
    })));
  };

  const exact = [];
  const scaled = [];
  for (const ppl of ZOOMS) {
    exact.push(await sample(ppl, true));
    scaled.push(await sample(ppl, false));
  }
  await page.evaluate(() => { window.__sanity.app.scene.exactGlyphAtlas = true; });
  await page.close();

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const worst = Math.max(...exact);
  const at = ZOOMS[exact.indexOf(worst)];
  console.log(
    `dpr ${dpr}  exact atlas: mean ${pct(mean(exact))}, worst ${pct(worst)} at ${at.toFixed(1)} px/line` +
      `  ·  nearest fixed level: mean ${pct(mean(scaled))}`,
  );
  if (worst > LIMIT) {
    console.log(`FAIL  dpr ${dpr}: ${pct(worst)} of edge pixels mid-ramp, over ${pct(LIMIT)}`);
    failures++;
  }
  // What the exact atlas is for. Averaged rather than per zoom: at the largest
  // sizes the two are within a percent of each other, because a glyph 46
  // pixels tall has enough pixels that scaling it costs little.
  if (mean(exact) > mean(scaled)) {
    console.log(`FAIL  dpr ${dpr}: the exact atlas is not sharper on average than the scaled one`);
    failures++;
  }
}

await browser.close();
console.log(failures === 0
  ? '\ntext is drawn 1:1 from an atlas its own size, at every zoom measured'
  : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
