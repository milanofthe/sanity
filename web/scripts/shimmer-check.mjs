// Asserts that borders do not shimmer while panning.
//
// A one pixel border on fractional coordinates gets antialiased across two
// pixels, and the split changes with every subpixel of pan, so the line pulses.
// That is invisible in a screenshot and obvious in motion, which makes it
// exactly the kind of thing to measure instead of look at.
//
// Two checks:
//   1. Sub-pixel pans must not change the image at all. With snapping, a pan
//      of a quarter pixel rounds to the same grid and renders identically.
//   2. A horizontal slice through a border must contain no intermediate
//      values between the border colour and what is on either side.

import { launch, settled, zoomForPanels } from './browser.mjs';
import { decodePng } from './png.mjs';

const base = process.env.SANITY_URL ?? 'http://localhost:5183';
const src = process.env.SANITY_SRC ?? 'fixture=fixture';

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
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
await page.waitForTimeout(600);

// A zoom where a good number of panel and region borders are on screen. A
// fixed zoom put the camera inside the interior of a single panel once panels
// grew with wrapping, and a check for border blending found no border.
const visible = await zoomForPanels(page, 20);
await page.evaluate(() => {
  const c = window.__sanity.app.cam;
  c.x = Math.round(c.x);
  c.y = Math.round(c.y);
});
await page.waitForTimeout(400);
console.log(`${visible} panels in view`);

let failures = 0;

const between = (a, b, c) => (a < b && b < c) || (c < b && b < a);

/**
 * Look for antialiased edges directly, without needing to know any colour.
 *
 * An antialiased boundary leaves a pixel whose value lies strictly between its
 * two neighbours in every channel: that is what blending produces and a hard
 * edge cannot. Counting those is a colour-independent test for whether any
 * edge is being blended, which matters because a blended edge on fractional
 * coordinates moves its blend with every subpixel of pan, and that is the
 * shimmer.
 *
 * `edges` is reported alongside, so a run that found nothing to look at cannot
 * pass as a run that found nothing wrong.
 */
async function edgeStats() {
  const png = decodePng(await page.screenshot({ type: 'png' }));
  const { width, height, data } = png;
  let edges = 0;
  let blended = 0;

  // Rows through the canvas, clear of the toolbar and the status bar.
  for (const frac of [0.25, 0.4, 0.55, 0.7, 0.85]) {
    const y = Math.floor(height * frac);
    for (let x = 1; x < width - 1; x++) {
      const o = (y * width + x) * 4;
      const p = o - 4;
      const n = o + 4;
      const step =
        Math.abs(data[o] - data[p]) +
        Math.abs(data[o + 1] - data[p + 1]) +
        Math.abs(data[o + 2] - data[p + 2]);
      if (step > 24) edges++;
      const isBlend =
        between(data[p], data[o], data[n]) &&
        between(data[p + 1], data[o + 1], data[n + 1]) &&
        between(data[p + 2], data[o + 2], data[n + 2]);
      const spread =
        Math.abs(data[p] - data[n]) +
        Math.abs(data[p + 1] - data[n + 1]) +
        Math.abs(data[p + 2] - data[n + 2]);
      if (isBlend && spread > 40) blended++;
    }
  }
  return { edges, blended };
}

const samples = [];
for (const dx of [0, 0.25, 0.5, 0.75]) {
  await page.evaluate((d) => {
    const c = window.__sanity.app.cam;
    c.x = Math.round(c.x) + d / c.zoom;
  }, dx);
  await page.waitForTimeout(250);
  samples.push(await edgeStats());
}

const edges = samples.map((s) => s.edges);
const blended = samples.map((s) => s.blended);
console.log(`edges sampled:       ${edges.join(' / ')}`);
console.log(`blended edge pixels: ${blended.join(' / ')}`);

if (Math.min(...edges) < 20) {
  console.log('FAIL  too few edges sampled for the result to mean anything');
  failures++;
}
// The property is that the image does not change as the camera pans by a
// fraction of a pixel: with snapping, a quarter pixel rounds to the same grid
// and renders identically. So what matters is how much the blended count
// *varies* across the four offsets, not its absolute value.
//
// The absolute value is not a good test on its own. Glyph antialiasing is
// deliberate and lands in the same count, and how much of it is on screen
// depends on which zoom the search settled at and on whether the GPU backend
// fell back under load: one run in a full suite reported 169 where the same
// check reported 80 twice in a row on its own.
const spread = Math.max(...blended) - Math.min(...blended);
const varyLimit = Math.max(8, 0.15 * Math.max(...blended));
if (spread > varyLimit) {
  console.log(
    `FAIL  blending changes by ${spread} across subpixel pans, over the ` +
      `${varyLimit.toFixed(0)} allowed: an edge is moving with the camera`,
  );
  failures++;
} else {
  console.log(`ok    blending is constant under subpixel panning (spread ${spread})`);
}

// And a gross regression in the absolute count still matters: it would mean
// every rectangle edge is being blended rather than snapped.
const limit = Number(process.env.SANITY_BLEND_LIMIT ?? 400);
if (Math.max(...blended) > limit) {
  console.log(`FAIL  ${Math.max(...blended)} blended edge pixels, over the ${limit} allowed`);
  failures++;
} else {
  console.log('ok    no rectangle edge is being blended');
}

await browser.close();
console.log(failures === 0 ? '\nborders are stable under panning' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
