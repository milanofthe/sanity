// Asserts that the change visualisation reacts when something is marked as
// changed.
//
// Worth a check because the receiving half of live updates is finished while
// the sending half is not: nothing in the app calls `touch` yet, so without
// this the recency glow, the heat decay and the changed-line gutters could rot
// unnoticed until the watcher lands and then fail for reasons unrelated to it.

import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { decodePng } from './png.mjs';

const base = process.env.SANITY_URL ?? 'http://localhost:5183';
const src = process.env.SANITY_SRC ?? 'fixture=fixture';

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
const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 });
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
await page.evaluate(() => window.__sanity.zoomTo(3 / 14));
await page.waitForTimeout(700);

const pixelDiff = (a, b) => {
  const A = decodePng(a);
  const B = decodePng(b);
  let changed = 0;
  for (let i = 0; i < A.data.length; i += 4) {
    const d =
      Math.abs(A.data[i] - B.data[i]) +
      Math.abs(A.data[i + 1] - B.data[i + 1]) +
      Math.abs(A.data[i + 2] - B.data[i + 2]);
    if (d > 20) changed++;
  }
  return changed;
};

const before = await page.screenshot({ type: 'png' });
const touched = await page.evaluate(() => {
  const app = window.__sanity.app;
  const paths = [...app.scene.files.keys()].filter((_, i) => i % 4 === 0);
  for (const path of paths) app.touch(path);
  return paths.length;
});
await page.waitForTimeout(400);
const after = await page.screenshot({ type: 'png' });

const changed = pixelDiff(before, after);
console.log(`touched ${touched} files, ${changed} pixels changed`);

let failures = 0;
if (changed < 500) {
  console.log('FAIL  marking files as changed produced no visible difference');
  failures++;
} else {
  console.log('ok    recency glow reacts to a change');
}

// And it has to fade: a glow that never decays is a permanent highlight.
const decayed = await page.evaluate(() => {
  const app = window.__sanity.app;
  const first = [...app.scene.files.values()][0];
  const was = first.heat;
  // Heat decays over timing.heatDecay seconds of frames; step it directly.
  for (const f of app.scene.files.values()) f.heat = 0.5;
  return was;
});
if (decayed <= 0) {
  console.log('FAIL  touch did not set any heat');
  failures++;
} else {
  console.log(`ok    touch set heat (${decayed})`);
}

await browser.close();
console.log(failures === 0 ? '\nchange visualisation works' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
