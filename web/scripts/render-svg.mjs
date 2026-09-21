// Render an SVG to PNG at given sizes, through the browser that is already a
// dependency here.
//
//   node web/scripts/render-svg.mjs <in.svg> <out-prefix> <size>...
//
// Exists because generating the icon set needs a rasteriser and adding one as
// a dependency for a handful of files a year is not worth it. Chromium renders
// SVG correctly, which a hand-rolled converter would not.

import { readFileSync, writeFileSync } from 'node:fs';
import { launch } from './browser.mjs';

const [input, prefix, ...sizes] = process.argv.slice(2);
if (!input || !prefix || sizes.length === 0) {
  console.error('usage: render-svg <in.svg> <out-prefix> <size>...');
  process.exit(2);
}

const svg = readFileSync(input, 'utf8');
const browser = await launch();

for (const raw of sizes) {
  const size = Number(raw);
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  // Transparent behind the SVG, so a mark with rounded corners keeps them.
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    { waitUntil: 'load' },
  );
  const png = await page.screenshot({ type: 'png', omitBackground: true });
  const out = sizes.length === 1 ? `${prefix}.png` : `${prefix}-${size}.png`;
  writeFileSync(out, png);
  console.log(`${out}  ${size}x${size}  ${(png.length / 1024).toFixed(1)} kB`);
  await page.close();
}
await browser.close();
