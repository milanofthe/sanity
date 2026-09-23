// The directory labels and the breadcrumb; see dirlabels.ts and `drawLabels`
// in scene.ts.
//
//   whole view   the directories are named: a label for each large one, none
//                overlapping, each inside its directory and on screen, and
//                actually drawn, which is measured against the same frame
//                with the labels off.
//   inside       zoomed into a directory, the breadcrumb names the ones the
//                view is inside of, outermost first.
//   click        a label takes the camera to its directory.
//   cost         the label pass is a small part of a frame, on the demo and
//                on ten thousand files.
import { decodePng } from './png.mjs';
import { base, canvasBox, frameOnScreen, launch, settled } from './browser.mjs';

/** Labels the whole view of pathsim has at least: its four top-level parts
 *  and a few below them. Measured 15. */
const MIN_LABELS = 8;
/** Share of a plate's pixels the label changes, at least: the text, and the
 *  code the plate covers. Measured 0.26 for the weakest; with nothing drawn
 *  it is 0. */
const MIN_DRAWN = 0.12;
/** Milliseconds the label pass may take on the CPU. Measured under 0.1 on
 *  the demo and 0.1 at ten thousand files. */
const MAX_MS = 1.5;

let failures = 0;
const report = (ok, text) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${text}`);
  if (!ok) failures++;
};

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });

const open = async (query) => {
  await page.goto(`${base}/?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__sanity?.app?.layout), null, { timeout: 600000 });
  await settled(page, 600000);
  await page.evaluate(async () => {
    // An option, off by default.
    window.__sanity.app.setDirLabels(true);
    window.__sanity.app.fit(0);
    for (let i = 0; i < 10; i++) {
      window.__sanity.app.invalidate();
      await new Promise((q) => requestAnimationFrame(q));
    }
  });
};

const shot = async () => {
  await frameOnScreen(page);
  const box = await canvasBox(page);
  return decodePng(await page.screenshot({ clip: { x: box.x, y: box.y, width: box.w, height: box.h } }));
};

const cost = () => page.evaluate(() => {
  const app = window.__sanity.app;
  const s = app.scene;
  const t = [];
  for (let i = 0; i < 41; i++) {
    const t0 = performance.now();
    s.drawLabels(app.cam);
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  return t[20];
});

// The whole view.
await open('demo=pathsim');
const whole = await page.evaluate(() => {
  const app = window.__sanity.app;
  const p = app.scene.placement;
  const dirs = new Map(app.layout.dirs.map((d) => [d.path, d]));
  const cam = app.cam;
  const inside = p.labels.every((l) => {
    const d = dirs.get(l.path);
    const [x0, y0] = cam.worldToScreen(d.x, d.y);
    const [x1, y1] = cam.worldToScreen(d.x + d.w, d.y + d.h);
    const b = l.plate;
    return b.x >= x0 - 0.5 && b.y >= y0 - 0.5 && b.x + b.w <= x1 + 0.5 && b.y + b.h <= y1 + 0.5
      && b.x >= 0 && b.y >= 0 && b.x + b.w <= cam.vw && b.y + b.h <= cam.vh;
  });
  let overlaps = 0;
  for (let i = 0; i < p.labels.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = p.labels[i].plate;
      const b = p.labels[j].plate;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlaps++;
    }
  }
  return { labels: p.labels, crumb: p.crumb, inside, overlaps };
});
report(whole.labels.length >= MIN_LABELS, `${whole.labels.length} directories named in the whole view, at least ${MIN_LABELS}`);
report(whole.overlaps === 0, `${whole.overlaps} labels overlapping`);
report(whole.inside, 'every label inside its directory and on screen');
report(whole.crumb === null, 'no breadcrumb with the whole project in view');

const on = await shot();
await page.evaluate(() => { window.__sanity.app.scene.labels = false; });
const off = await shot();
await page.evaluate(() => { window.__sanity.app.scene.labels = true; });
const dpr = on.width / 1400;
let weakest = 1;
for (const l of whole.labels.filter((x) => x.alpha >= 1)) {
  let changed = 0;
  let all = 0;
  for (let y = Math.ceil(l.plate.y * dpr); y < Math.floor((l.plate.y + l.plate.h) * dpr); y++) {
    for (let x = Math.ceil(l.plate.x * dpr); x < Math.floor((l.plate.x + l.plate.w) * dpr); x++) {
      const i = (y * on.width + x) * 4;
      const d = Math.abs(on.data[i] - off.data[i]) + Math.abs(on.data[i + 1] - off.data[i + 1])
        + Math.abs(on.data[i + 2] - off.data[i + 2]);
      all++;
      if (d > 30) changed++;
    }
  }
  weakest = Math.min(weakest, changed / all);
}
report(weakest >= MIN_DRAWN, `labels drawn: the weakest changes ${(weakest * 100).toFixed(0)} percent of its plate`);
const demoMs = await cost();

// Inside a directory three levels down.
const inside = await page.evaluate(async () => {
  const app = window.__sanity.app;
  const d = app.layout.dirs.filter((x) => x.depth >= 3).sort((a, b) => b.w * b.h - a.w * a.h)[0];
  app.cam.zoom = Math.min(app.cam.vw / d.w, app.cam.vh / d.h) * 3;
  app.cam.x = d.x + d.w / 2;
  app.cam.y = d.y + d.h / 2;
  app.invalidate();
  await new Promise((q) => requestAnimationFrame(() => requestAnimationFrame(q)));
  const want = app.layout.dirs
    .filter((x) => x.name && (d.path === x.path || d.path.startsWith(`${x.path}/`)))
    .sort((a, b) => a.depth - b.depth)
    .map((x) => x.path);
  return { want, got: app.scene.placement.crumb?.crumbs.map((c) => c.path) ?? [] };
});
report(
  inside.got.join(' > ') === inside.want.join(' > '),
  `breadcrumb inside ${inside.want.at(-1)}: ${inside.got.join(' > ') || 'none'}`,
);

// A click on the first crumb goes to its directory.
const flew = await page.evaluate(async () => {
  const app = window.__sanity.app;
  const c = app.scene.placement.crumb.crumbs[0];
  const r = document.querySelector('canvas').getBoundingClientRect();
  const at = { clientX: r.left + c.box.x + 2, clientY: r.top + c.box.y + c.box.h / 2, pointerId: 1, bubbles: true };
  const canvas = document.querySelector('canvas');
  canvas.dispatchEvent(new PointerEvent('pointerdown', at));
  canvas.dispatchEvent(new PointerEvent('pointerup', at));
  for (let i = 0; i < 120 && app.cam.flying; i++) await new Promise((q) => requestAnimationFrame(q));
  const d = app.layout.dirs.find((x) => x.path === c.path);
  const fit = app.cam.fitFor(d.x, d.y, d.x + d.w, d.y + d.h);
  return { path: c.path, zoom: app.cam.zoom / fit.zoom, dx: Math.abs(app.cam.x - fit.x) * app.cam.zoom };
});
report(
  Math.abs(flew.zoom - 1) < 0.02 && flew.dx < 2,
  `a click on "${flew.path}" fits it: zoom ${flew.zoom.toFixed(3)} of the fit, ${flew.dx.toFixed(1)} px off centre`,
);

// Cost, on the demo and at ten thousand files.
await open('files=10000&lines=100');
const bigMs = await cost();
const bigLabels = await page.evaluate(() => window.__sanity.app.scene.placement.labels.length);
report(Math.max(demoMs, bigMs) <= MAX_MS,
  `label pass ${demoMs.toFixed(2)} ms on the demo, ${bigMs.toFixed(2)} ms at 10000 files (${bigLabels} labels), at most ${MAX_MS}`);

await browser.close();
console.log(failures === 0 ? '\nthe directories are named' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
