// Asserts that the canvas comes back after the GPU takes the context away.
//
// A driver can drop a WebGL context at any time: a GPU reset, a laptop
// switching cards, a Windows TDR under a large window. Everything on the GPU
// goes with it, and on this canvas that means every panel is empty, with
// nothing on screen saying why. Unless the loss event is cancelled the browser
// does not even try to restore it, so without a handler the window stays
// empty until it is reloaded.
//
// `WEBGL_lose_context` makes that testable: it is the same event path a real
// driver loss takes.

import { decodePng } from './png.mjs';
import { base, canvasBox, frameOnScreen, launch, settled } from './browser.mjs';

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log(`[error] ${e.message}`));
await page.goto(`${base}/?demo=pathsim`, { waitUntil: 'load' });
const ok = await page
  .waitForFunction(
    () => (document.querySelector('footer')?.textContent ?? '').includes('files'),
    null,
    { timeout: 60000 },
  )
  .then(() => true)
  .catch(() => false);
if (!ok) {
  console.log('no demo in this build, run `npm run demo` first: skipped');
  await browser.close();
  process.exit(0);
}
await settled(page);
await frameOnScreen(page);

let failures = 0;
const fail = (m) => {
  console.log(`FAIL  ${m}`);
  failures++;
};

/** How much of the canvas is something other than its most common colour. */
const ink = async () => {
  const box = await canvasBox(page);
  const png = decodePng(
    await page.screenshot({ clip: { x: box.x, y: box.y + 40, width: box.w, height: box.h - 60 } }),
  );
  const counts = new Map();
  for (let i = 0; i < png.data.length; i += 4) {
    const k = (png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2];
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let top = 0;
  for (const c of counts.values()) top = Math.max(top, c);
  return 1 - top / (png.width * png.height);
};

const before = await ink();
console.log(`before: ${(before * 100).toFixed(1)}% of the canvas drawn`);
if (before < 0.1) fail('nothing on the canvas to begin with');

const lost = await page.evaluate(() => {
  const gl = document.querySelector('canvas').getContext('webgl2');
  // Held on the window: once the context is gone, `getExtension` answers null,
  // so the handle for giving it back has to be taken while it still works.
  const ext = gl.getExtension('WEBGL_lose_context');
  if (!ext) return null;
  window.__lose = ext;
  ext.loseContext();
  return new Promise((r) => setTimeout(() => r(window.__sanity.app.contextLost), 300));
});
if (lost === null) {
  console.log('WEBGL_lose_context is not available here, nothing to check');
  await browser.close();
  process.exit(0);
}
if (!lost) fail('the app did not notice the context going away');
const said = await page.evaluate(() => document.querySelector('footer')?.textContent ?? '');
if (!said.includes('context lost')) fail('the status bar says nothing about the lost context');
else console.log('ok    the status bar says the context is gone');

// The browser only restores a cancelled loss, and restoring is what the
// driver does for real; here it is asked for directly.
await page.evaluate(() => window.__lose.restoreContext());
await page.waitForTimeout(2500);
await settled(page);
await frameOnScreen(page);
const after = await ink();
const back = await page.evaluate(() => ({
  lost: window.__sanity.app.contextLost,
  files: window.__sanity.app.stats.files,
  quads: window.__sanity.app.stats.quads,
}));
console.log(
  `after:  ${(after * 100).toFixed(1)}% drawn, ${back.files} files, ${back.quads} quads`,
);
if (back.lost) fail('the app still thinks the context is gone');
if (after < before * 0.6) {
  fail(`the canvas did not come back: ${(before * 100).toFixed(1)}% before, ${(after * 100).toFixed(1)}% after`);
} else {
  console.log('ok    the scene is rebuilt after the context comes back');
}

await browser.close();
console.log(failures === 0 ? '\nthe canvas survives a lost context' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
