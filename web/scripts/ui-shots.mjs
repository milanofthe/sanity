// Screenshots of the chrome: every menu open, every theme applied.
//
// Separate from shot.mjs, which measures the renderer. This one exists so a
// change to a component or a token is checked against what it looks like
// rather than against whether it compiles.

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';

const base = process.env.SANITY_URL ?? 'http://localhost:5183';
const outDir = process.env.SANITY_OUT ?? 'shots/ui';
mkdirSync(outDir, { recursive: true });

const cacheRoot = `${process.env.HOME}/Library/Caches/ms-playwright`;
const executablePath = (() => {
  const dirs = readdirSync(cacheRoot)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
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
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({
  viewport: { width: 1500, height: 940 },
  deviceScaleFactor: 2,
});
page.on('pageerror', (e) => console.log(`[error] ${e.message}`));

await page.goto(`${base}/?files=260&lines=200&changed=0.05`, { waitUntil: 'load' });
await page.waitForFunction(
  () => {
    const t = document.querySelector('footer')?.textContent ?? '';
    return t.length > 0 && !t.includes('indexing');
  },
  null,
  { timeout: 120000 },
);
await page.evaluate(() => window.__sanity.zoomTo(0.1));
await page.waitForTimeout(400);

// Each menu, open.
for (const label of ['Project', 'View', 'Theme']) {
  await page.getByRole('button', { name: new RegExp(`^${label}`) }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${outDir}/menu-${label.toLowerCase()}.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
}

// Each theme, applied to the whole window including the canvas.
for (const theme of ['mariana', 'monokai', 'breakers']) {
  await page.getByRole('button', { name: /^Theme/ }).click();
  await page.waitForTimeout(150);
  await page.getByRole('button', { name: new RegExp(theme, 'i') }).click();
  await page.keyboard.press('Escape');
  // The overview textures are re-rasterised on a theme switch.
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${outDir}/theme-${theme}.png` });
  const applied = await page.evaluate(() => document.documentElement.dataset.theme);
  console.log(`theme ${theme.padEnd(6)} applied=${applied}`);
}

await browser.close();
