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

// Type it, key by key, into the field the toolbar owns. Then wait past the
// debounce, because a query of three characters or more searches the text as
// well and what the counter counts depends on whether that found anything.
await page.click('header input');
await page.keyboard.type(QUERY, { delay: 15 });
await page.waitForTimeout(900);
await settled(page);
await frameOnScreen(page);
const filtered = await page.screenshot({ type: 'png' });

const shown = await page.evaluate(() => document.querySelector('header .count')?.textContent ?? '');
const counted = await page.evaluate(async (q) => {
  const app = window.__sanity.app;
  const paths = app.search(q).length;
  const text = await app.findText(q);
  // Hits when the text has any, names otherwise: one counter, one order.
  return { paths, hits: text.total, steps: app.hits.length };
}, QUERY);
// Names and text hits are one list: the counter is the sum.
const expect = counted.paths + counted.hits;
if (!shown.endsWith(`/${expect}`)) {
  fail(`the field says "${shown}" while the app finds ${expect}`);
} else {
  console.log(
    `ok    the field and the app agree on ${expect}: ` +
      `${counted.paths} by name and ${counted.hits} in the text`,
  );
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

// Enter flies to the first thing the counter is counting: a text hit if there
// is one, the best named file otherwise. Whichever it is, that panel has to end
// up filling much more of the window than it did.
const target = await page.evaluate(() => window.__sanity.app.steps[0]?.path ?? null);
const beforeRect = await rectOf(target);
const areaBefore = beforeRect.w * beforeRect.h;
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
await settled(page);
await frameOnScreen(page);
const flownRect = await rectOf(target);
const areaAfter = flownRect.w * flownRect.h;
if (!(areaAfter > areaBefore * 20)) {
  fail(`the match grew only ${(areaAfter / Math.max(1, areaBefore)).toFixed(1)}x on screen`);
} else {
  console.log(
    `ok    Enter flew to ${target}, ${Math.round(areaAfter / Math.max(1, areaBefore))}x its area on screen`,
  );
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

// --- the same field, searching the text of every file ---
//
// The fixture is searched in the browser and a real folder in Rust, from the
// same definition of a hit; this exercises the browser half and the wiring
// that both share. TEXT is a word the fixture's own files contain.
// A word the fixture's files talk about and none of them is named after, so
// the first thing Enter steps to is a line rather than a panel.
const TEXT = 'butterworth';
await page.click('header input');
await page.keyboard.down('Meta');
await page.keyboard.press('a');
await page.keyboard.up('Meta');
await page.keyboard.type(TEXT, { delay: 15 });
// Past the debounce and the search itself.
await page.waitForTimeout(900);
await settled(page);

const expectedHits = await page.evaluate(async (q) => {
  const r = await window.__sanity.app.findText(q);
  return { files: r.files, shown: r.shown, total: r.total, hits: window.__sanity.app.hits.length };
}, TEXT);
const note = await page.evaluate(() => document.querySelector('header .count')?.getAttribute('title') ?? '');
const label = await page.evaluate(() => document.querySelector('header .count')?.textContent?.trim() ?? '');
console.log(
  `"${TEXT}" found ${expectedHits.total} hits in ${expectedHits.files} files; ` +
    `the field says ${label}`,
);

const named = await page.evaluate((q) => window.__sanity.app.search(q).length, TEXT);
if (expectedHits.total === 0) {
  fail(`the fixture contains no "${TEXT}", so there is nothing to step through`);
} else if (named !== 0) {
  fail(`"${TEXT}" also matches ${named} paths, so this does not test the text path alone`);
} else if (!label.endsWith(`/${expectedHits.total}`)) {
  fail(`the field says "${label}" for ${expectedHits.total} hits`);
} else if (!note.includes(`text of ${expectedHits.files} file`)) {
  fail(`the tooltip says "${note}" for ${expectedHits.files} files`);
} else {
  console.log('ok    the field counts hits, not files, and says which is which');
}

// Enter flies to a line, not merely to a file: what arrives has to be text.
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
await settled(page);
const landed = await page.evaluate(() => {
  const app = window.__sanity.app;
  const hit = app.hits[0];
  const rect = app.scene.lineRect(hit.path, hit.line);
  const [sx, sy] = app.cam.worldToScreen(rect[0], rect[1]);
  return {
    path: hit.path,
    line: hit.line,
    pxPerLine: 14 * app.cam.zoom,
    onScreen: sx > -50 && sy > -50 && sx < app.cam.vw + 50 && sy < app.cam.vh + 50,
  };
});
console.log(
  `landed on ${landed.path} line ${landed.line + 1} at ${landed.pxPerLine.toFixed(1)} px/line`,
);
if (!landed.onScreen) {
  fail('the hit line is not on screen after the flight');
} else if (!(landed.pxPerLine >= 6)) {
  fail(`${landed.pxPerLine.toFixed(1)} px/line is below where glyphs are drawn`);
} else {
  console.log('ok    Enter put the hit line on screen at a zoom where it is text');
}

// And the second Enter moves to another hit rather than staying put.
const firstAt = await page.evaluate(() => document.querySelector('header .count')?.textContent?.trim());
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
await settled(page);
const secondAt = await page.evaluate(() => document.querySelector('header .count')?.textContent?.trim());
if (firstAt === secondAt) {
  fail(`stepping did not advance: still ${secondAt}`);
} else {
  console.log(`ok    stepping advances, ${firstAt} then ${secondAt}`);
}

await browser.close();
console.log(failures === 0 ? '\nsearch lights the matches and flies to them' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
