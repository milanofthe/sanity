// Asserts that git's per-line change state reaches the screen.
//
// There are two distinct signals and they fail independently:
//
//   1. The panel border tints when a file differs from the baseline. This is
//      what makes the outermost zoom useful as a monitor, and it is visible
//      before any line is readable.
//   2. The gutter marks which lines changed. This only draws once spans or
//      glyphs are up, so it needs its own zoom level to be checked at.
//
// Both are checked by turning the state off and diffing the pixels, so the
// check measures what is drawn rather than what the data says.
//
// Needs a fixture with uncommitted work in it:
//   cargo run --release -p sanity-core --example dump -- <repo> web/public/fixture-self
//   SANITY_SRC=fixture=fixture-self node scripts/change-check.mjs

import { decodePng } from './png.mjs';
import { base, openApp, pixelDiff } from './browser.mjs';

const source = process.env.SANITY_SRC ?? 'fixture=fixture-self';
const name = source.split('=')[1];

// Fixtures are local dumps, not repository contents, so say how to make one
// rather than failing on a missing file. The fixture has to come from a
// repository with uncommitted work in it, or there is no change state to draw.
const probe = await fetch(`${base}/${name}/scan.json`).catch(() => null);
if (!probe || !probe.ok) {
  console.log(`no fixture at ${base}/${name}/, so there is nothing to check.`);
  console.log(
    `make one:  cargo run --release -p sanity-core --example dump -- <a repo with ` +
      `uncommitted work> web/public/${name}`,
  );
  process.exit(1);
}

const { browser, page } = await openApp({ source });

let failures = 0;
const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  failures++;
};

// How much change the fixture actually carries. A fixture from a clean tree
// would make every check below pass on nothing, so this is a guard on the
// input, not a property of the app.
const counts = await page.evaluate(() => {
  const files = [...window.__sanity.app.scene.files.values()];
  let dirty = 0;
  let lines = 0;
  const kinds = [0, 0, 0, 0];
  for (const f of files) {
    let any = false;
    for (let i = 0; i < f.data.lineState.length; i++) {
      const st = f.data.lineState[i];
      if (st !== 0) {
        any = true;
        lines++;
        kinds[st]++;
      }
    }
    if (any) dirty++;
  }
  return { files: files.length, dirty, lines, kinds };
});
console.log(
  `${counts.dirty} of ${counts.files} files differ from the baseline, ` +
    `${counts.lines} lines marked (+${counts.kinds[1]} ~${counts.kinds[2]} -${counts.kinds[3]})`,
);
if (counts.dirty === 0) {
  fail('the fixture carries no change state, so nothing below is being tested');
  await browser.close();
  process.exit(1);
}

// The aggregate state has to agree with the per-line data, or the border says
// one thing while the gutter says another.
const agree = await page.evaluate(() => {
  let wrong = 0;
  for (const f of window.__sanity.app.scene.files.values()) {
    const any = [...f.data.lineState].some((s) => s !== 0);
    if (any !== (f.state !== 0)) wrong++;
  }
  return wrong;
});
if (agree > 0) fail(`${agree} files disagree between their lines and their panel state`);
else console.log('ok    panel state agrees with the per-line data');

/** Screenshot with the change state on, then with it off, and diff. */
async function diffWithStateOff(label, minPixels) {
  const before = await page.screenshot({ type: 'png' });
  const saved = await page.evaluate(() => {
    const kept = [];
    for (const [path, f] of window.__sanity.app.scene.files) {
      kept.push([path, [...f.data.lineState]]);
      f.data.lineState.fill(0);
      f.state = 0;
      f.heat = 0;
    }
    return kept;
  });
  await page.waitForTimeout(350);
  const after = await page.screenshot({ type: 'png' });
  await page.evaluate((kept) => {
    for (const [path, states] of kept) {
      const f = window.__sanity.app.scene.files.get(path);
      if (!f) continue;
      f.data.lineState.set(states);
      f.state = states.find((s) => s !== 0) ?? 0;
    }
  }, saved);
  await page.waitForTimeout(250);

  const changed = pixelDiff(decodePng, before, after);
  if (changed < minPixels) fail(`${label}: ${changed} pixels changed, expected at least ${minPixels}`);
  else console.log(`ok    ${label} (${changed} pixels)`);
  return changed;
}

// Overview zoom: the whole project on screen, no line readable. Only the
// border tint can carry the signal here.
await page.evaluate(() => window.__sanity.app.fit(0));
await page.waitForTimeout(500);
// A tinted hairline around a handful of panels is a small number of pixels,
// which is the point: enough to see, not enough to shout.
await diffWithStateOff('border tints at overview zoom', counts.dirty);

// Zoomed in far enough that the gutter draws. Aim at a file that actually has
// changes in it, or the view lands on unchanged code and proves nothing.
const focused = await page.evaluate(() => {
  const app = window.__sanity.app;
  for (const [path, f] of app.scene.files) {
    if (f.node.stub) continue;
    if ([...f.data.lineState].some((s) => s !== 0)) {
      app.focusFile(path, 0);
      return path;
    }
  }
  return null;
});
if (!focused) {
  fail('no drawn panel carries changes, so the gutter cannot be checked');
} else {
  console.log(`focused ${focused}`);
  await page.waitForTimeout(800);
  const pxPerLine = await page.evaluate(() => window.__sanity.app.stats.pxPerLine);
  console.log(`${pxPerLine.toFixed(1)} px per line`);
  if (pxPerLine < 2) {
    fail(`focusing left only ${pxPerLine.toFixed(1)} px per line, below where the gutter draws`);
  } else {
    // One marker per changed line, several pixels each, so a file with a real
    // hunk in it moves far more than this.
    await diffWithStateOff('gutter marks changed lines', 20);
  }
}

await browser.close();
console.log(failures === 0 ? '\nchange state reaches the screen' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
