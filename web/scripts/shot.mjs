// Drives the dev server in a real browser: captures one screenshot per level
// of detail and runs the in-page benchmark sweep. This is how a rendering
// change gets verified without a human having to stare at it.

import { mkdirSync } from 'node:fs';
import { launch, settled } from './browser.mjs';

const base = process.env.SANITY_URL ?? 'http://localhost:5183';
const files = process.env.SANITY_FILES ?? '400';
const lines = process.env.SANITY_LINES ?? '180';
const outDir = process.env.SANITY_OUT ?? 'shots';
mkdirSync(outDir, { recursive: true });

const browser = await launch({
  args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--enable-zero-copy'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });

page.on('console', (m) => console.log(`[page] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[error] ${e.message}`));

await page.goto(`${base}/?files=${files}&lines=${lines}&changed=0.04`, { waitUntil: 'load' });

const renderer = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return 'no webgl2';
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
console.log(`renderer: ${renderer}`);

// Wait for indexing to finish, which the status bar reports.
await page.waitForFunction(
  () => {
    const t = document.querySelector('footer')?.textContent ?? '';
    return t.length > 0 && !t.includes('indexing');
  },
  null,
  { timeout: 120000 },
);
await settled(page);

const hud = () => page.evaluate(() => (document.querySelector('footer')?.innerText ?? '').replace(/\n/g, ' | '));

// One shot per level of detail, by setting the zoom directly.
// The first stop fits the whole repository, which is the view the layout has
// to hold up in; the rest step down through the levels of detail.
const stops = [
  ['1-structure', null],
  ['2-overview', 0.14],
  ['3-tokens', 0.45],
  ['4-text', 1.1],
];
for (const [name, zoom] of stops) {
  if (zoom === null) await page.keyboard.press('f');
  else await page.evaluate((z) => window.__sanity.zoomTo(z), zoom);
  await page.waitForTimeout(400);
  console.log(`${name.padEnd(12)} ${await hud()}`);
  await page.screenshot({ path: `${outDir}/${name}.png` });
}

// Benchmark sweep through the whole zoom range.
const line = await page.evaluate(() => window.__sanity.bench(12));
console.log(line);

await browser.close();
