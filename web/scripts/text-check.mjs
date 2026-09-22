// How sharp the text is.
//
// The canvas draws text from a glyph atlas, and two things blur it: an atlas
// rasterised at a different size than the one being drawn, and a glyph landing
// between pixels. Both are read through bilinear filtering at every edge.
//
// What is measured is where the ink sits. Crisp text is nearly all background
// or nearly all ink, with a thin edge between; blurred text spends two or
// three pixels on that edge, and those land in the middle of the range. The
// browser's own DOM text, same font and size, measures 14.3 percent half-tone
// on this machine, which is the floor antialiasing puts under this.
//
// The thresholds are the measured values plus a little room. They were, before
// the atlas was rasterised at the exact size and glyphs were put on the pixel
// grid: 67.3, 58.6, 49.2 and 32.0 percent.
import { decodePng } from './png.mjs';
import { base, canvasBox, frameOnScreen, launch, settled } from './browser.mjs';
const browser = await launch();
const DPR = 2;
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: DPR });
await page.goto(`${base}/?demo=pathsim`, { waitUntil: 'load' });
await page.waitForFunction(() => (document.querySelector('footer')?.textContent ?? '').includes('files'), null, { timeout: 60000 });
await settled(page);
console.log(`dpr ${DPR}`);
/** Largest share of edge pixels that may sit in the middle of a transition.
 *  Measured: text drawn 1:1 from an atlas of its own size stays near a fifth;
 *  the same text scaled from a fixed level is half again as soft. */
const LIMIT = 0.3;
let failures = 0;
const totals = { exact: 0, scaled: 0, n: 0 };
/** One measurement: set the zoom, centre on a text panel, read the edges. */
const sample = async (ppl, exact) => {
  await page.evaluate(
    ([v, ex]) => {
      window.__sanity.app.scene.exactGlyphAtlas = ex;
      window.__sanity.zoomTo(v / 14);
    },
    [ppl, exact],
  );
  await page.waitForTimeout(400);
  // Two more frames after the camera stops: the exact atlas is rasterised on
  // the first frame that sees a still camera, and drawn from on the next.
  await page.evaluate(async () => {
    const app = window.__sanity.app;
    for (let i = 0; i < 3; i++) {
      app.invalidate();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
  });
  await frameOnScreen(page);
  const atlas = await page.evaluate((d) => {
    const app = window.__sanity.app;
    const em = (7 / app.scene.atlas.advanceRatio) * (app.stats.pxPerLine / 14);
    const level = app.scene.atlas.pick(em * d);
    return { em: +(em * d).toFixed(1), level: level.size };
  }, DPR);
  // Centred on a text panel before sampling. The sample itself is the middle
  // of the canvas, which is where the panel now is: a fixed rectangle alone
  // measured whatever the layout happened to put there, and once pictures
  // were laid out in rows it was landing on one of them.
  const on = await page.evaluate(() => {
    const app = window.__sanity.app;
    const f = [...app.scene.files.values()]
      .filter((x) => !x.node.stub && !x.node.media && x.data.lineCount > 60)
      .sort((a, b) => b.data.lineCount - a.data.lineCount)[0];
    if (!f) return null;
    app.cam.x = f.node.x + f.node.w / 2;
    app.cam.y = f.node.y + f.node.h / 2;
    app.invalidate();
    return f.node.path;
  });
  if (!on) return null;
  await page.waitForTimeout(250);
  await frameOnScreen(page);
  const box = await canvasBox(page);
  const png = decodePng(
    await page.screenshot({
      clip: {
        x: box.x + box.w / 2 - 250,
        y: box.y + box.h / 2 - 150,
        width: 500,
        height: 300,
      },
    }),
  );
  // Softness, measured against a local reference.
  //
  // For each pixel, the darkest and lightest value within two pixels of it.
  // Where those differ enough there is an edge nearby, and the pixel's own
  // value says where in that transition it sits: at the ends it is background
  // or ink, in the middle it is the ramp between them. Sharp text has few
  // pixels in the middle, blurred text has many.
  //
  // Local, because the first version of this used fixed thresholds and
  // counted a dimmed line number and a green docstring as softness: both sit
  // in the middle of the global range while being perfectly crisp.
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
  const softness = onEdge > 0 ? inRamp / onEdge : 0;
  return { edges: onEdge, edgeWidth: softness };
  return { edges, edgeWidth };
};

for (const ppl of [9, 14, 20, 28]) {
  const exact = await sample(ppl, true);
  const scaled = await sample(ppl, false);
  if (!exact || !scaled) continue;
  console.log(
    `  ${String(ppl).padStart(3)} px/line  ` +
      `${(exact.edgeWidth * 100).toFixed(1)}% of edge pixels mid-ramp from an atlas ` +
      `its own size, ${(scaled.edgeWidth * 100).toFixed(1)}% from the nearest fixed one` +
      (exact.edgeWidth > LIMIT ? `  FAIL over ${LIMIT}` : ''),
  );
  if (exact.edgeWidth > LIMIT) failures++;
  totals.exact += exact.edgeWidth;
  totals.scaled += scaled.edgeWidth;
  totals.n++;
}

// Averaged rather than per zoom: at the largest sizes the two are within a
// percent of each other, because a glyph 46 pixels tall has enough pixels
// that a 0.83 scaling costs little. What the exact atlas is for is the sizes
// text is actually read at, and there it is worth a third of the softness.
if (totals.n > 0) {
  const exact = totals.exact / totals.n;
  const scaled = totals.scaled / totals.n;
  console.log(
    `overall   ${(exact * 100).toFixed(1)}% against ${(scaled * 100).toFixed(1)}% scaled`,
  );
  if (exact > scaled) {
    console.log('FAIL  the exact atlas is not sharper on average than the scaled one');
    failures++;
  }
}

await browser.close();
console.log(failures === 0 ? '\ntext is drawn on the pixel grid, from an atlas its own size' : `\n${failures} zoom level(s) blurrier than they should be`);
process.exit(failures === 0 ? 0 : 1);
