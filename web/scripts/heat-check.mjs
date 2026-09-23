// Asserts that the change visualisation reacts when something is marked as
// changed.
//
// Worth a check because the receiving half of live updates is finished while
// the sending half is not: nothing in the app calls `touch` yet, so without
// this the panel flash, its clock and the changed-line gutters could rot
// unnoticed until the watcher lands and then fail for reasons unrelated to it.

import { decodePng } from './png.mjs';
import { launch, settled, pixelDiff, zoomForPanels } from './browser.mjs';

const base = process.env.SANITY_URL ?? 'http://localhost:5183';
const src = process.env.SANITY_SRC ?? 'fixture=fixture';

const browser = await launch();
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
await settled(page);
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

const before = await page.screenshot({ type: 'png' });
// Only the panels actually on screen: touching one off screen cannot change a
// pixel, and counting it would let the check pass on nothing.
//
// The flash is read inside the same evaluate as the touch, and the screenshot
// is taken straight after. It has to be: the flash lasts half a second on
// purpose, and an earlier version of this check sampled it 0.6 seconds later
// and found nothing, which is the check being too slow rather than the flash
// being absent.
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
  let flash = 0;
  for (const p of paths) flash = Math.max(flash, window.__sanity.flashAt(app.scene.files.get(p).since));
  return { count: paths.length, flash };
});
const after = await page.screenshot({ type: 'png' });

const changed = pixelDiff(decodePng, before, after);
console.log(
  `touched ${touched.count} files at flash ${touched.flash.toFixed(2)}, ` +
    `${changed} pixels changed`,
);

let failures = 0;
if (!(touched.flash > 0.9)) {
  console.log(`FAIL  the flash reads ${touched.flash.toFixed(2)} at the moment of the change`);
  failures++;
} else if (changed < touched.count * 4) {
  console.log('FAIL  marking files as changed produced no visible difference');
  failures++;
} else {
  console.log(`ok    a change flashes its panel, ${Math.round(changed / touched.count)} pixels each`);
}

// The clock itself, on the panels that were touched rather than on whichever
// file happens to be first in the map: only the visible ones were touched.
const clocks = await page.evaluate(() => {
  const app = window.__sanity.app;
  const [vx0, vy0, vx1, vy1] = app.cam.visibleRect(0);
  let fresh = 0;
  let youngest = Infinity;
  for (const f of app.scene.files.values()) {
    const n = f.node;
    if (n.x > vx1 || n.y > vy1 || n.x + n.w < vx0 || n.y + n.h < vy0) continue;
    if (window.__sanity.markAt(f.since) > 0) fresh++;
    youngest = Math.min(youngest, f.since);
  }
  return { fresh, youngest, recent: app.recentCount() };
});
if (clocks.fresh === 0) {
  console.log('FAIL  touch started no change clock on any visible panel');
  failures++;
} else {
  console.log(
    `ok    ${clocks.fresh} visible panels just changed, youngest ${clocks.youngest.toFixed(2)} s`,
  );
}

// The flash is over quickly and the marks outlast it, briefly: an event, not
// a state. The lines flash for as long as the panel does and fade for a
// second after, so they are sampled just past the panel's flash.
// Sampled from the page rather than computed here, since recency.ts owns the
// curves and has its own tests.
const shape = await page.evaluate(async () => {
  const app = window.__sanity.app;
  const read = () => {
    let flash = 0;
    let mark = 0;
    for (const f of app.scene.files.values()) {
      flash = Math.max(flash, window.__sanity.flashAt(f.since));
      mark = Math.max(mark, window.__sanity.markAt(f.since));
    }
    return { flash, mark };
  };
  const now = read();
  await new Promise((r) => setTimeout(r, 600));
  const soon = read();
  await new Promise((r) => setTimeout(r, 2400));
  const later = read();
  return { now, soon, later };
});
console.log(
  `by now flash ${shape.now.flash.toFixed(2)}, after 0.6 s ${shape.soon.flash.toFixed(2)}; ` +
    `marks ${shape.now.mark.toFixed(2)} -> ${shape.soon.mark.toFixed(2)} -> ${shape.later.mark.toFixed(2)}`,
);
if (shape.soon.flash !== 0) {
  console.log(`FAIL  the flash is still ${shape.soon.flash.toFixed(2)} after 0.6 s, which is a glow`);
  failures++;
} else if (!(shape.soon.mark > 0.5)) {
  console.log('FAIL  the line marks went with the flash, so nothing says which lines changed');
  failures++;
} else if (shape.later.mark !== 0) {
  console.log(`FAIL  the marks are still ${shape.later.mark.toFixed(2)} after 3 s, which is a glow`);
  failures++;
} else {
  console.log('ok    the flash is brief, the marks outlast it, and both end');
}

await browser.close();
console.log(failures === 0 ? '\nchange visualisation works' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
