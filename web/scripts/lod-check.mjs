// How much the picture changes while the zoom is turned through the
// hand-overs.
//
// The canvas draws a file three ways and fades between them. Each is a
// different picture of the same code: the texture fills a line completely and
// spreads a token over 128 texels a panel, a token bar covers its own width
// and a fraction of the line's height, a glyph covers the letters and nothing
// else. If those carry different amounts of ink, zooming is a series of steps
// rather than a zoom, which is what "the bars coming in" looks like.
//
// So this walks the zoom across both hand-overs and measures the mean
// luminance of one region of the canvas. What it asserts is the spread: the
// picture may differ between representations, but not by so much that the
// change is the thing you notice. See `spanBarHeight` in lod.ts, which was
// picked against this measurement.
import { decodePng } from './png.mjs';
import { base, canvasBox, frameOnScreen, launch, settled } from './browser.mjs';

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
await page.goto(`${base}/?demo=pathsim`, { waitUntil: 'load' });
await page.waitForFunction(() => (document.querySelector('footer')?.textContent ?? '').includes('files'), null, { timeout: 60000 });
await settled(page);
const box = await canvasBox(page);
const clip = { x: box.x + 200, y: box.y + 120, width: 900, height: 420 };

const row = [];
for (let ppl = 1.4; ppl <= 5.0001; ppl += 0.3) {
  await page.evaluate((v) => window.__sanity.zoomTo(v / 14), ppl);
  await page.waitForTimeout(260);
  await frameOnScreen(page);
  const png = decodePng(await page.screenshot({ clip }));
  let lum = 0, n = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    lum += 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
    n++;
  }
  row.push({ ppl: +ppl.toFixed(1), lum: +(lum / n).toFixed(1) });
}
console.log(row.map((r) => `  ${String(r.ppl).padStart(4)} px/line  luminance ${r.lum}`).join('\n'));

// Over the hand-over range only: past it the glyphs legitimately carry less
// ink than any bar, and holding that against them would be asking text to
// look like bars.
const band = row.filter((r) => r.ppl <= 4.4);
const lo = Math.min(...band.map((r) => r.lum));
const hi = Math.max(...band.map((r) => r.lum));
let worst = 0, at = 0;
for (let i = 1; i < band.length; i++) {
  const d = Math.abs(band[i].lum - band[i - 1].lum);
  if (d > worst) { worst = d; at = band[i].ppl; }
}
console.log(
  `spread ${(hi - lo).toFixed(1)} luminance from ${lo} to ${hi} across the hand-over, ` +
    `largest single step ${worst.toFixed(1)} at ${at} px/line`,
);
// 8 is past the 6.8 the current bar height measures and under the 9.2 and 9.4
// the two alternatives did, so it fails a change that gives that back.
let failures = 0;
if (hi - lo > 8) {
  console.log(`FAIL  the picture changes by ${(hi - lo).toFixed(1)} across the hand-over`);
  failures++;
}
if (worst > 5) {
  console.log(`FAIL  one zoom step changes the picture by ${worst.toFixed(1)}`);
  failures++;
}
await browser.close();
console.log(failures === 0 ? '\nthe hand-overs hold the picture steady' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
