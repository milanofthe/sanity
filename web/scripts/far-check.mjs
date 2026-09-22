// The far view: the canvas drawn from tiles while moving and from a rest
// image while still, once a project has more panels in view than are worth
// drawing one by one; see tiles.ts and `renderFar` in scene.ts.
//
// Three things have to hold, and the other checks cannot see any of them,
// since they all run on projects too small to reach the far view:
//
//   at rest    the picture is the live picture. The rest image is the live
//              frame rendered once, so anything more than rounding between
//              the two is a bug in how it is placed or what it leaves out.
//   moving     the tiles cover the view and sit where the panels are. They
//              are softer than the live frame by construction, resampled
//              twice, but a hole or an offset is far outside that.
//   cost       a frame at rest costs next to nothing, which is the point.
import { decodePng } from './png.mjs';
import { base, canvasBox, frameOnScreen, launch, settled } from './browser.mjs';

const FILES = Number(process.env.SANITY_FAR_FILES ?? 10000);

/**
 * Mean difference per channel, 0 to 255, against the live frame.
 *
 * Measured at ten thousand files, once the overview detail has streamed in:
 * 0.00 at rest, and 6.9 from tiles while moving. Before the detail kept
 * streaming at rest, the rest image was drawn from the smallest level and
 * came out 12.9 off.
 */
const REST_LIMIT = 1.5;
const MOVING_LIMIT = 12;

/** Milliseconds a frame at rest may cost, against 5.3 drawing every panel. */
const REST_MS = 1.0;

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
await page.goto(`${base}/?files=${FILES}&lines=100`, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__sanity?.app?.layout), null, { timeout: 600000 });
await settled(page, 600000);

/** The same view drawn three ways: live, far at rest, far while moving. */
const shot = async (mode) => {
  const ms = await page.evaluate(async (mode) => {
    const app = window.__sanity.app;
    const s = app.scene;
    const root = app.layout.root;
    s.tiled = mode !== 'live';
    app.cam.zoom = Math.min(app.cam.vw / root.w, app.cam.vh / root.h) * 1.5;
    app.cam.x = root.w * 0.45;
    app.cam.y = root.h * 0.45;
    // Until nothing is streaming in any more, so each way draws with the
    // same overview detail. A fixed number of frames compared two different
    // amounts of it and measured anything from 1.5 to 2.6.
    for (let i = 0; i < 1200; i++) {
      app.invalidate();
      await new Promise((q) => requestAnimationFrame(q));
      if (i > 10 && !s.streamPending && !s.tilesPending) break;
    }
    // What a frame here costs once it is settled: the median of a few, since
    // the last one of the settling may be the rest image being drawn again.
    const costs = [];
    for (let i = 0; i < 11; i++) {
      app.invalidate();
      await new Promise((q) => requestAnimationFrame(q));
      costs.push(s.stats.cpuMs);
    }
    costs.sort((a, b) => a - b);
    const cost = costs[5];
    if (mode === 'moving') {
      // The camera counts as moving when it differs from the last frame's.
      // Every frame until the screenshot is made to think it did, without
      // moving it, since the frames the screenshot waits for would otherwise
      // be at rest again.
      const render = s.render.bind(s);
      s.render = (cam, dt) => {
        s.camWas.x = Number.NaN;
        render(cam, dt);
      };
      s.restoreRender = () => { s.render = render; };
      app.invalidate();
      await new Promise((q) => requestAnimationFrame(q));
    }
    return cost;
  }, mode);
  await frameOnScreen(page);
  const box = await canvasBox(page);
  const png = decodePng(await page.screenshot({ clip: { x: box.x, y: box.y, width: box.w, height: box.h } }));
  const far = await page.evaluate(() => {
    const s = window.__sanity.app.scene;
    s.restoreRender?.();
    delete s.restoreRender;
    return s.far;
  });
  return { ms, far, png };
};

const diff = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1])
      + Math.abs(a.data[i + 2] - b.data[i + 2]);
  }
  return sum / ((a.data.length / 4) * 3);
};

let failures = 0;
const rest = await shot('rest');
const live = await shot('live');
const moving = await shot('moving');

const restDiff = diff(rest.png, live.png);
const movingDiff = diff(moving.png, live.png);
const report = (ok, text) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${text}`);
  if (!ok) failures++;
};
report(rest.far && moving.far, `the view is drawn far (${FILES} files)`);
report(restDiff <= REST_LIMIT, `at rest, ${restDiff.toFixed(2)} off the live frame`);
report(movingDiff <= MOVING_LIMIT, `moving, from tiles, ${movingDiff.toFixed(2)} off the live frame`);
report(rest.ms <= REST_MS, `a frame at rest costs ${rest.ms.toFixed(2)} ms, drawn live ${live.ms.toFixed(2)}`);

await browser.close();
console.log(failures === 0 ? '\nthe far view is the live view, for less' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
