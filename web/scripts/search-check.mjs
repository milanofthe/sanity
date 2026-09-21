// Asserts that typing a query dims the project and lights the matches, that
// Enter flies to one, and that clearing puts everything back.
//
// Driven through the real input element and the real key handling rather than
// by calling into the app, because the interesting failures are in the wiring:
// a field that filters but does not repaint, an Enter that moves the camera
// while the highlight says something else, an Escape that clears the text and
// leaves the canvas dark.
//
// Measured in pixels, per panel. A whole-screen average cannot tell dimming
// from a camera move, and both happen here.

import { decodePng } from './png.mjs';
import { base, canvasBox, frameOnScreen, launch, settled, src } from './browser.mjs';

const QUERY = 'scene';

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
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
await page.evaluate(() => window.__sanity.app.fit(0));
await settled(page);

let failures = 0;
const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  failures++;
};

/** Mean luminance inside a device-pixel rect. */
function luminance(png, r) {
  const { width, height, data } = decodePng(png);
  const x0 = Math.max(0, Math.round(r.x));
  const y0 = Math.max(0, Math.round(r.y));
  const x1 = Math.min(width, Math.round(r.x + r.w));
  const y1 = Math.min(height, Math.round(r.y + r.h));
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * width + x) * 4;
      sum += 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
      n++;
    }
  }
  return n > 0 ? sum / n / 255 : 0;
}

const box = await canvasBox(page);

/** Screen rect of a panel, in device pixels of the screenshot. */
const rectOf = (path) =>
  page.evaluate(
    ([p, bx, by]) => {
      const app = window.__sanity.app;
      const f = app.layout.files.find((x) => x.path === p);
      if (!f) return null;
      const [sx, sy] = app.cam.worldToScreen(f.x, f.y);
      const dpr = app.cam.dpr;
      return {
        x: (bx + sx) * dpr,
        y: (by + sy) * dpr,
        w: f.w * app.cam.zoom * dpr,
        h: f.h * app.cam.zoom * dpr,
      };
    },
    [path, box.x, box.y],
  );

// What the query should find, from the layout the canvas is actually showing.
const expected = await page.evaluate((q) => {
  const paths = window.__sanity.app.layout.files.map((f) => f.path);
  return window.__sanity.app.search(q).map((m) => m.path).slice(0, 4).concat([String(paths.length)]);
}, QUERY);
await page.evaluate(() => window.__sanity.app.search(''));
const matchPath = expected[0];
if (!matchPath) {
  fail(`the fixture has nothing matching "${QUERY}", so there is nothing to check`);
  await browser.close();
  process.exit(1);
}
console.log(`"${QUERY}" should find ${matchPath} first, out of ${expected.at(-1)} files`);

// A panel that does not match, big enough to sample: the one to watch dim.
const other = await page.evaluate(
  ([q, hit]) => {
    const app = window.__sanity.app;
    const found = new Set(app.search(q).map((m) => m.path));
    app.search('');
    let best = null;
    for (const f of app.layout.files) {
      if (found.has(f.path) || f.path === hit) continue;
      if (!best || f.w * f.h > best.w * best.h) best = f;
    }
    return best?.path ?? null;
  },
  [QUERY, matchPath],
);

await frameOnScreen(page);
const before = await page.screenshot({ type: 'png' });
const hitRect = await rectOf(matchPath);
const otherRect = await rectOf(other);

// Type it, key by key, into the field the toolbar owns.
await page.click('header input');
await page.keyboard.type(QUERY, { delay: 15 });
await settled(page);
await frameOnScreen(page);
const filtered = await page.screenshot({ type: 'png' });

const shown = await page.evaluate(() => document.querySelector('header .count')?.textContent ?? '');
const counted = await page.evaluate((q) => {
  const n = window.__sanity.app.search(q).length;
  return n;
}, QUERY);
if (!shown.endsWith(`/${counted}`)) {
  fail(`the field says "${shown}" while the app finds ${counted} matches`);
} else {
  console.log(`ok    the field and the app agree on ${counted} matches`);
}

const hitBefore = luminance(before, hitRect);
const hitAfter = luminance(filtered, hitRect);
const otherBefore = luminance(before, otherRect);
const otherAfter = luminance(filtered, otherRect);
console.log(
  `match ${hitBefore.toFixed(3)} -> ${hitAfter.toFixed(3)}, ` +
    `the rest ${otherBefore.toFixed(3)} -> ${otherAfter.toFixed(3)}`,
);

// The panel that did not match has to recede, and by a lot: the number is the
// dimming factor the renderer applies, with room for the border it keeps.
if (!(otherAfter < otherBefore * 0.5)) {
  fail(`an unmatched panel went from ${otherBefore.toFixed(3)} to ${otherAfter.toFixed(3)}`);
} else {
  console.log(`ok    an unmatched panel keeps ${(otherAfter / otherBefore * 100).toFixed(0)} percent of its brightness`);
}

// And the match has to stand out from it afterwards, which is the whole point.
if (!(hitAfter > otherAfter * 1.5)) {
  fail(`the match reads at ${hitAfter.toFixed(3)} against ${otherAfter.toFixed(3)} around it`);
} else {
  console.log(`ok    the match is ${(hitAfter / otherAfter).toFixed(1)} times brighter than what it sits next to`);
}

// Enter flies to the first match. Its panel has to end up filling much more of
// the window than it did.
const areaBefore = (hitRect.w * hitRect.h);
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
await settled(page);
await frameOnScreen(page);
const flownRect = await rectOf(matchPath);
const areaAfter = flownRect.w * flownRect.h;
if (!(areaAfter > areaBefore * 20)) {
  fail(`the match grew only ${(areaAfter / Math.max(1, areaBefore)).toFixed(1)}x on screen`);
} else {
  console.log(`ok    Enter flew to the match, ${Math.round(areaAfter / Math.max(1, areaBefore))}x its area on screen`);
}
const onScreen =
  flownRect.x + flownRect.w > 0 && flownRect.y + flownRect.h > 0
  && flownRect.x < 1280 && flownRect.y < 800;
if (!onScreen) {
  fail('the camera flew somewhere the match is not');
} else {
  console.log('ok    and it is in view');
}

// Escape clears the query and the dimming with it.
await page.keyboard.press('Escape');
await settled(page);
await page.evaluate(() => window.__sanity.app.fit(0));
await settled(page);
await frameOnScreen(page);
const cleared = await page.screenshot({ type: 'png' });
const otherCleared = luminance(cleared, otherRect);
const text = await page.evaluate(() => document.querySelector('header input')?.value ?? '');
if (text !== '') {
  fail(`Escape left "${text}" in the field`);
} else if (!(otherCleared > otherBefore * 0.8)) {
  fail(`after clearing, a panel is at ${otherCleared.toFixed(3)} against ${otherBefore.toFixed(3)}`);
} else {
  console.log('ok    Escape clears the query and the canvas comes back');
}

await browser.close();
console.log(failures === 0 ? '\nsearch lights the matches and flies to them' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
