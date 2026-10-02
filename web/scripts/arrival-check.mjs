// Whether a project arrives as it will look, rather than as frames that fill.
//
//   panels       a panel arriving becomes visible with the detail it is to be
//                shown with at this zoom, or its picture. It used to arrive
//                as soon as its coarsest overview was written and sharpen in
//                place, so the opening was a grid of smudged and empty frames
//                that filled in over a second.
//   directories  a directory is drawn once a panel in it is. The project used
//                to open as a set of empty boxes.
//
// The arrival may give up waiting on a slow panel (see ARRIVAL_WAIT_S in
// scene.ts), so a few can come in without their detail; the limit is a share.
import { base, launch, settled } from './browser.mjs';

/** Share of panels that may arrive without their detail. Measured on
 *  pathsim with the wait in place: 0 of 375. Without it: 90, 24 percent. */
const LACKING_SHARE = 0.05;

let failures = 0;
const report = (ok, text) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${text}`);
  if (!ok) failures++;
};

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
await page.goto(`${base}/?demo=pathsim`, { waitUntil: 'commit' });
await page.waitForFunction(() => window.__sanity?.app?.scene, null, { timeout: 60000 });

const frames = await page.evaluate(async () => {
  const app = window.__sanity.app;
  const out = [];
  const t0 = performance.now();
  while (performance.now() - t0 < 6000) {
    await new Promise((r) => requestAnimationFrame(r));
    const a = app.scene?.arrival;
    if (a) out.push({ ...a });
    if (out.length > 30 && !app.settling()) break;
  }
  return out;
});
await settled(page);
await browser.close();

const shown = frames.reduce((s, f) => s + f.shown, 0);
const lacking = frames.reduce((s, f) => s + f.lacking, 0);
const share = shown ? lacking / shown : 0;
report(
  shown > 0 && share <= LACKING_SHARE,
  `${shown} panels arrived, ${lacking} of them without their detail (${(share * 100).toFixed(1)}%, at most ${LACKING_SHARE * 100}%)`,
);
const first = frames.findIndex((f) => f.shown > 0);
const boxes = frames.slice(0, first < 0 ? frames.length : first).filter((f) => f.dirs > 0);
report(boxes.length === 0, `${boxes.length} frames of directories drawn before any panel in them`);

console.log(failures === 0
  ? '\npanels arrive with what they show, directories with their panels'
  : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
