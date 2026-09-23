// The drawn logo against the original it was drawn after.
//
// web/scripts/logo.mjs draws the wordmark as centre lines at one stroke, in
// the original's pixels. At the original's stroke the two have to cover the
// same pixels, or the drawing has drifted from the logo: this renders both
// and compares the ink.
//
//   LOGO_PREVIEW=/tmp/logo.png npm run logo-check    and writes the overlay

import { readFileSync } from 'node:fs';
import { launch } from './browser.mjs';
import { ORIGINAL_STROKE, wordmark, wordmarkBody } from './logo.mjs';

/** Share of the ink either one has that both have. Measured 0.938 when the
 *  drawing was made; the rest is the original's faceted curves. */
const MIN_OVERLAP = 0.93;

const png = readFileSync(new URL('../../assets/sanity-logo.png', import.meta.url)).toString('base64');
const w = wordmark(ORIGINAL_STROKE);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w.width}" height="${w.height}" viewBox="0 0 ${w.width} ${w.height}">${wordmarkBody(w, '#000')}</svg>`;

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 520 } });
const result = await page.evaluate(async ({ png, svg }) => {
  const load = async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    return img;
  };
  const original = await load(`data:image/png;base64,${png}`);
  const drawn = await load(`data:image/svg+xml;base64,${btoa(svg)}`);
  const W = Math.max(original.naturalWidth, drawn.naturalWidth);
  const H = Math.max(original.naturalHeight, drawn.naturalHeight);
  const mask = (img) => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, W, H).data;
    const out = new Uint8Array(W * H);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3] > 127 ? 1 : 0;
    return out;
  };
  const a = mask(original);
  const b = mask(drawn);
  let both = 0;
  let either = 0;
  const over = new ImageData(W, H);
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) both++;
    if (a[i] || b[i]) either++;
    // Both grey, the original's alone red, the drawing's alone blue.
    const [r, g, bl] = a[i] && b[i] ? [120, 120, 120] : a[i] ? [255, 40, 40] : b[i] ? [40, 140, 255] : [22, 24, 26];
    over.data.set([r, g, bl, 255], i * 4);
  }
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  c.getContext('2d').putImageData(over, 0, 0);
  return { overlap: both / either, preview: c.toDataURL('image/png').split(',')[1] };
}, { png, svg });
await browser.close();

if (process.env.LOGO_PREVIEW) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.LOGO_PREVIEW, Buffer.from(result.preview, 'base64'));
}
const ok = result.overlap >= MIN_OVERLAP;
console.log(`${ok ? 'ok  ' : 'FAIL'}  the drawing covers ${(result.overlap * 100).toFixed(1)} percent of the ink it shares with the original, at least ${MIN_OVERLAP * 100}`);
process.exit(ok ? 0 : 1);
