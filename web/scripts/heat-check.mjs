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
// A zoom where a good number of panels are on screen with visible borders.
// Picking a fixed zoom made this brittle: panels grew when wrapping landed,
// so the same zoom showed a handful of them and touching them moved almost no
// pixels. Search for a zoom that puts enough panels in view instead.
const visible = await page.evaluate(async () => {
  const app = window.__sanity.app;
  for (const ppl of [6, 4.5, 3, 2, 1.4, 1]) {
    window.__sanity.zoomTo(ppl / 14);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (app.stats.visibleFiles >= 20) return app.stats.visibleFiles;
  }
  return app.stats.visibleFiles;
});
await page.waitForTimeout(700);
console.log(`${visible} panels in view`);

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
// Only the panels actually on screen: touching one off screen cannot change a
// pixel, and counting it would let the check pass on nothing.
const touched = await page.evaluate(() => {
  const app = window.__sanity.app;
  const [vx0, vy0, vx1, vy1] = app.cam.visibleRect(0);
  const paths = [];
  for (const f of app.scene.files.values()) {
    const n = f.node;
    if (n.x > vx1 || n.y > vy1 || n.x + n.w < vx0 || n.y + n.h < vy0) continue;
    paths.push(n.path);
  }
  for (const path of paths) app.touch(path);
  return paths.length;
});
await page.waitForTimeout(400);
const after = await page.screenshot({ type: 'png' });

const changed = pixelDiff(before, after);
console.log(`touched ${touched} files, ${changed} pixels changed`);

let failures = 0;
// Roughly a border's worth of pixels per touched panel; well under what a
// real change produces, well over noise.
if (changed < touched * 4) {
  console.log('FAIL  marking files as changed produced no visible difference');
  failures++;
} else {
  console.log('ok    recency glow reacts to a change');
}

// The heat itself, on the panels that were touched rather than on whichever
// file happens to be first in the map: only the visible ones were touched.
const heat = await page.evaluate(() => {
  const app = window.__sanity.app;
  const [vx0, vy0, vx1, vy1] = app.cam.visibleRect(0);
  let hot = 0;
  let max = 0;
  for (const f of app.scene.files.values()) {
    const n = f.node;
    if (n.x > vx1 || n.y > vy1 || n.x + n.w < vx0 || n.y + n.h < vy0) continue;
    if (f.heat > 0) hot++;
    max = Math.max(max, f.heat);
  }
  return { hot, max };
});
if (heat.hot === 0) {
  console.log('FAIL  touch set no heat on any visible panel');
  failures++;
} else {
  console.log(`ok    ${heat.hot} visible panels are hot (max ${heat.max.toFixed(2)})`);
}

// And it has to fade, or the glow is a permanent highlight rather than a
// recency signal. Heat decays per frame over timing.heatDecay seconds.
const faded = await page.evaluate(async () => {
  const app = window.__sanity.app;
  const before = Math.max(...[...app.scene.files.values()].map((f) => f.heat));
  await new Promise((r) => setTimeout(r, 900));
  const after = Math.max(...[...app.scene.files.values()].map((f) => f.heat));
  return { before, after };
});
if (faded.after >= faded.before) {
  console.log(`FAIL  heat did not decay (${faded.before} -> ${faded.after})`);
  failures++;
} else {
  console.log(`ok    heat decays (${faded.before.toFixed(3)} -> ${faded.after.toFixed(3)})`);
}

await browser.close();
console.log(failures === 0 ? '\nchange visualisation works' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
