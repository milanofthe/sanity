// What a large project costs: per frame at three zooms, and on the GPU.
//
// The per-frame cost has to depend on what is on screen, not on how big the
// project is. Measured on a view with nothing in it, which should cost nothing
// at any size, and at three zooms: one panel filling the view, about a
// thousand panels, and the whole project. The first is where a frame's walk
// over the project shows on its own; the last is the level of detail's job.
//
//   SANITY_SCALE=10000,30000 node web/scripts/scale-check.mjs
import { base, launch, settled } from './browser.mjs';

const SIZES = (process.env.SANITY_SCALE ?? '10000,30000').split(',').map(Number);

/**
 * Ceiling on the frame cost with nothing in view, in milliseconds, at any
 * project size. Anything above it is the project's size leaking into a frame
 * that has nothing to draw.
 */
const EMPTY_MS = 0.3;

const browser = await launch();
let failures = 0;

for (const n of SIZES) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  let stat = null;
  page.on('console', (m) => { if (m.text().startsWith('layout:')) stat = m.text(); });
  await page.goto(`${base}/?files=${n}&lines=100`, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__sanity?.app?.layout), null, { timeout: 600000 });
  await settled(page, 600000);
  await page.waitForTimeout(1000);

  const r = await page.evaluate(async () => {
    const app = window.__sanity.app;
    const root = app.layout.root;
    const frames = async (n) => {
      for (let i = 0; i < n; i++) {
        app.invalidate();
        await new Promise((q) => requestAnimationFrame(q));
      }
    };
    /**
     * Median frame cost over a short pan at this zoom, once the detail for
     * the view has streamed in. The frames straight after a jump are the
     * streaming's, reported apart: what the view costs to look at is the
     * drawing alone.
     */
    const at = async (zoom, x, y) => {
      app.cam.zoom = zoom;
      app.cam.x = x;
      app.cam.y = y;
      let streamed = 0;
      // Until the detail has streamed in and, in the far view, the tiles for
      // this level exist: what is measured is looking at the view, not
      // arriving at it.
      for (let i = 0; i < 600; i++) {
        await frames(1);
        streamed += app.scene.stats.streamMs;
        if (i > 2 && !app.scene.streamPending && !app.scene.tilesPending) break;
      }
      const xs = [];
      for (let i = 0; i < 21; i++) {
        app.cam.x += 1 / zoom;
        await frames(1);
        xs.push(app.scene.stats.cpuMs);
      }
      xs.sort((a, b) => a - b);
      const d = app.scene.detailStats();
      return {
        ms: xs[10], streamed, visible: app.scene.stats.visibleFiles,
        detail: d.bytes, detailed: d.files,
      };
    };
    const fit = Math.min(app.cam.vw / root.w, app.cam.vh / root.h);
    // Well outside the project, at reading zoom.
    const empty = await at(1, root.w * 3, root.h * 3);
    // A panel in the middle of the project, filling the view.
    const mid = app.layout.files[app.layout.files.length >> 1];
    const one = await at(Math.min(app.cam.vw / mid.w, app.cam.vh / mid.h), mid.x + mid.w / 2, mid.y + mid.h / 2);
    // About a thousand panels: a thousandth-of-the-project view scaled up.
    const k = Math.sqrt(Math.min(1, 1000 / app.layout.files.length));
    const some = await at(fit / k, root.w / 2, root.h / 2);
    const all = await at(fit, root.w / 2, root.h / 2);
    return { empty, one, some, all, tex: app.scene.textures.stats().bytes };
  });

  const f = (x) =>
    `${x.ms.toFixed(2)} ms (${x.visible} panels, ${x.streamed.toFixed(0)} ms streaming` +
    ` to ${(x.detail / 1e6).toFixed(0)} MB of detail for ${x.detailed})`;
  console.log(
    `${String(n).padStart(7)} files  empty ${r.empty.ms.toFixed(2)} ms · one panel ${f(r.one)} · some ${f(r.some)} · all ${f(r.all)}` +
      ` · overview texture ${(r.tex / 1e6).toFixed(0)} MB allocated · layout ${stat?.match(/(\d+) ms$/)?.[1] ?? '?'} ms`,
  );
  if (r.empty.ms > EMPTY_MS) {
    console.log(`FAIL  ${n} files: ${r.empty.ms.toFixed(2)} ms a frame with nothing in view, over ${EMPTY_MS}`);
    failures++;
  }
  await page.close();
}

await browser.close();
console.log(failures === 0 ? '\na frame costs what is on screen' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
