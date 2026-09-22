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
/** Half-tone share allowed at each zoom, in percent. */
const LIMITS = { 9: 55, 14: 52, 20: 46, 28: 30 };
let failures = 0;
for (const ppl of [9, 14, 20, 28]) {
  await page.evaluate((v) => window.__sanity.zoomTo(v / 14), ppl);
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
  const box = await canvasBox(page);
  const png = decodePng(await page.screenshot({ clip: { x: box.x + 300, y: box.y + 200, width: 500, height: 300 } }));
  // Sharpness: how much of the ink sits at an intermediate tone. Crisp text
  // goes from background to ink in about one pixel; blurred text spends two
  // or three, and those pixels land in the middle of the range.
  let dark = 0, mid = 0, light = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const l = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
    if (l < 45) dark++;
    else if (l < 120) mid++;
    else light++;
  }
  const inked = mid + light;
  const halfTone = (100 * mid) / Math.max(1, inked);
  const limit = LIMITS[ppl];
  console.log(
    `  ${String(ppl).padStart(3)} px/line  em ${String(atlas.em).padStart(5)} px  ` +
      `ink ${(100 * inked / (dark + inked)).toFixed(1)}%  of that ${halfTone.toFixed(1)}% is half-tone` +
      (halfTone > limit ? `  FAIL over ${limit}%` : ''),
  );
  if (halfTone > limit) failures++;
}
await browser.close();
console.log(failures === 0 ? '\ntext is drawn on the pixel grid, from an atlas its own size' : `\n${failures} zoom level(s) blurrier than they should be`);
process.exit(failures === 0 ? 0 : 1);
