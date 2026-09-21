// Asserts the overview texture is not being smeared vertically.
//
// The texture holds one texel per screen row of a panel, so vertically it sits
// at exactly 1:1 when a line is one pixel tall and is magnified by the
// pixels-per-line factor above that. Measured across the hand-over band:
// 1.8x at 1.8 px/line, 3.2x at 3.2, while the texture is still the dominant
// representation. Plain bilinear over that smears each line of code into its
// neighbours, and what you see is a soft canvas just before the token bars
// arrive. Horizontally there is no such problem: 128 texels cover at most 120
// characters.
//
// Measured as the root mean square of the difference between one row of pixels
// and the next, compared against the same frame with the sharpening off.
//
// Squared, and that is the whole trick. The mean *absolute* difference is
// invariant under monotone interpolation: bilinear spreads one step of height
// H over three pixels as three steps of H/3, which sums to exactly the same
// total. Measured it, got 80.67 both ways, and the toggle was demonstrably
// changing a hundred thousand pixels. Squaring distinguishes one big step from
// three small ones, which is precisely the difference between sharp and
// smeared.

import { decodePng } from './png.mjs';
import { base, frameOnScreen, launch, settled, src } from './browser.mjs';

const browser = await launch();
// Two device pixels per CSS pixel, because that is the display this is for
// and because it doubles the magnification: the level-of-detail bands are in
// CSS pixels while the texture is sampled in device pixels, so at 1.8 CSS
// px/line a retina screen is stretching one texel over 3.6 device pixels.
const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 2 });
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

/** Root mean square difference between vertically adjacent pixels. */
function verticalContrast(png) {
  const { width, height, data } = decodePng(png);
  // The canvas only: clear of the toolbar and the status bar.
  const top = Math.round(height * 0.1);
  const bottom = Math.round(height * 0.9);
  let sum = 0;
  let n = 0;
  for (let y = top; y < bottom - 1; y++) {
    for (let x = 0; x < width; x++) {
      const a = (y * width + x) * 4;
      const b = ((y + 1) * width + x) * 4;
      const dr = data[a] - data[b];
      const dg = data[a + 1] - data[b + 1];
      const db = data[a + 2] - data[b + 2];
      sum += dr * dr + dg * dg + db * db;
      n++;
    }
  }
  return Math.sqrt(sum / Math.max(1, n));
}

let failures = 0;
const results = [];
for (const ppl of [0.9, 1.2, 1.5, 1.8, 3.2]) {
  await page.evaluate((p) => window.__sanity.zoomTo(p / 14), ppl);
  await settled(page);

  await page.evaluate(() => (window.__sanity.app.scene.sharpen = false));
  await frameOnScreen(page);
  const soft = verticalContrast(await page.screenshot({ type: 'png' }));

  await page.evaluate(() => (window.__sanity.app.scene.sharpen = true));
  await frameOnScreen(page);
  const sharp = verticalContrast(await page.screenshot({ type: 'png' }));

  const gain = sharp / Math.max(1e-6, soft);
  results.push({ ppl, soft, sharp, gain });
  console.log(
    `${String(ppl).padStart(4)} px/line  vertical contrast ${soft.toFixed(2)} bilinear, ` +
      `${sharp.toFixed(2)} sharpened, ${gain.toFixed(2)}x`,
  );
}

// The property is that the gain tracks the magnification: there is nothing to
// fix at one texel per pixel and progressively more above it. So it has to
// grow with the zoom through the band, and reach something worth having at the
// top of it, where the texture is still the whole picture.
const inUse = results.filter((r) => r.ppl <= 1.8);
let growing = true;
for (let i = 1; i < inUse.length; i++) {
  if (inUse[i].gain < inUse[i - 1].gain - 0.03) growing = false;
}
if (!growing) {
  console.log(`FAIL  the gain does not track the magnification: ${inUse.map((r) => r.gain.toFixed(2)).join(' -> ')}`);
  failures++;
} else {
  console.log(`ok    the gain tracks the magnification (${inUse.map((r) => r.gain.toFixed(2)).join(' -> ')})`);
}

const top = inUse[inUse.length - 1];
if (top.gain < 1.25) {
  console.log(`FAIL  only ${top.gain.toFixed(2)}x at ${top.ppl} px/line, where the texture is most stretched`);
  failures++;
} else {
  console.log(`ok    ${top.gain.toFixed(2)}x at ${top.ppl} px/line, the worst the texture is stretched in use`);
}

const gone = results.find((r) => r.ppl === 3.2);
if (gone && Math.abs(gone.gain - 1) > 0.05) {
  console.log(
    `FAIL  ${gone.gain.toFixed(2)}x at 3.2 px/line, where the texture is not drawn at all: ` +
      `the measurement is not measuring the texture`,
  );
  failures++;
} else if (gone) {
  console.log('ok    no effect where the texture has handed over, so it is the texture being measured');
}

await browser.close();
console.log(failures === 0 ? '\nthe overview texture is sharp' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
