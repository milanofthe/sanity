// Captures the level-of-detail range as a strip, including both hand-over
// bands, so a transition can be judged rather than guessed at.
//
// Uses the same crop of the same file at every zoom, so the frames differ only
// in level of detail.

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';

const base = process.env.SANITY_URL ?? 'http://localhost:5183';
const src = process.env.SANITY_SRC ?? 'fixture=fixture';
const outDir = process.env.SANITY_OUT ?? 'shots/lod';
mkdirSync(outDir, { recursive: true });

const cacheRoot = `${process.env.HOME}/Library/Caches/ms-playwright`;
const executablePath = (() => {
  for (const d of readdirSync(cacheRoot)
    .filter((x) => /^chromium-\d+$/.test(x))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))) {
    for (const c of [
      `${cacheRoot}/${d}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
      `${cacheRoot}/${d}/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
    ]) {
      if (existsSync(c)) return c;
    }
  }
  return undefined;
})();

const browser = await chromium.launch({
  executablePath,
  args: ['--use-gl=angle', '--use-angle=metal'],
});
const page = await browser.newPage({ viewport: { width: 700, height: 460 }, deviceScaleFactor: 2 });
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
await page.waitForTimeout(800);

// Pixels per line, walking through both bands.
const STOPS = [1.0, 1.8, 2.2, 2.6, 3.2, 6, 10, 12, 13.5, 15, 17, 22];
const lineHeight = 14;

for (const ppl of STOPS) {
  await page.evaluate((z) => window.__sanity.zoomTo(z), ppl / lineHeight);
  await page.waitForTimeout(350);
  const line = await page.evaluate(() => {
    const t = document.querySelector('footer')?.innerText ?? '';
    return t.split('\n').join(' ');
  });
  const lod = line.match(/lod\s+(\w+)/)?.[1] ?? '?';
  const quads = line.match(/([\d,]+)\s+quads/)?.[1] ?? '?';
  console.log(`${String(ppl).padStart(5)} px/line  lod ${lod.padEnd(9)} ${quads.padStart(8)} quads`);
  await page.screenshot({ path: `${outDir}/ppl-${String(ppl).replace('.', '_')}.png` });
}

await browser.close();
