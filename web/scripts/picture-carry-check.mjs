// Whether pictures are there at the overview, and go where their panels go.
//
//   loaded    at the zoom a project opens at, every picture in view is drawn
//             from a texture rather than as an empty sheet. Pictures under 24
//             pixels across used to be left out, and in a large project that
//             was most of them until somebody zoomed in.
//   carried   while a relayout slides the panels to their new places, every
//             picture is drawn over the sheet under it, which moves with the
//             panel. The picture used to be drawn at the panel's destination
//             from the first frame, and the frame slid in to meet it.
import { base, launch, settled } from './browser.mjs';

let failures = 0;
const report = (ok, text) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${text}`);
  if (!ok) failures++;
};

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
await page.goto(`${base}/?demo=pathsim`, { waitUntil: 'load' });
await page.waitForFunction(() => (document.querySelector('footer')?.textContent ?? '').includes('files'), null, { timeout: 60000 });
await settled(page);

const loaded = await page.evaluate(() => {
  const { scene, cam } = window.__sanity.app;
  const x0 = cam.x - cam.vw / 2 / cam.zoom;
  const y0 = cam.y - cam.vh / 2 / cam.zoom;
  const x1 = cam.x + cam.vw / 2 / cam.zoom;
  const y1 = cam.y + cam.vh / 2 / cam.zoom;
  const held = new Set([...scene.media.slots.keys()].map((k) => k.split('\u0000')[0]));
  let shown = 0;
  const empty = [];
  for (const f of scene.files.values()) {
    const n = f.node;
    if (n.media?.kind !== 'image' || n.x > x1 || n.y > y1 || n.x + n.w < x0 || n.y + n.h < y0) continue;
    shown++;
    if (!held.has(n.path)) empty.push(`${n.path} at ${(n.w * cam.zoom).toFixed(0)} px`);
  }
  return { shown, empty };
});
report(
  loaded.shown > 0 && loaded.empty.length === 0,
  `${loaded.shown - loaded.empty.length} of ${loaded.shown} pictures in view drawn at the overview` +
    (loaded.empty.length ? ` (empty: ${loaded.empty.slice(0, 3).join(', ')})` : ''),
);

// Half the files go, so the rest are laid out again and slide.
const carried = await page.evaluate(async () => {
  const app = window.__sanity.app;
  const scene = app.scene;
  const src = app.lastSource;
  let keep = 0;
  app.relayout({ ...src, entries: src.entries.filter((e) => e.media || keep++ % 2 === 0) });
  const frames = [];
  const t0 = performance.now();
  while (performance.now() - t0 < 600) {
    await new Promise((r) => requestAnimationFrame(r));
    const rects = scene.bgRects;
    const sheets = [];
    for (let i = 0; i < rects.count; i++) {
      const o = i * rects.stride;
      sheets.push(rects.data.slice(o, o + 4));
    }
    const near = (a, b) => Math.abs(a - b) <= 1e-3 * Math.max(1, Math.abs(b));
    let off = 0;
    for (const d of scene.imageDraws) {
      if (!sheets.some((s) => near(d.x, s[0]) && near(d.y, s[1]) && near(d.w, s[2]) && near(d.h, s[3]))) off++;
    }
    frames.push({ pictures: scene.imageDraws.length, off, moving: scene.animating });
  }
  return frames;
});
const moving = carried.filter((f) => f.moving && f.pictures > 0);
const off = moving.reduce((a, f) => a + f.off, 0);
report(
  moving.length > 0 && off === 0,
  `${moving.length} frames of a relayout with pictures, ${off} pictures drawn away from their sheet`,
);

await browser.close();
console.log(failures === 0
  ? '\npictures are drawn at the overview and travel with their panels'
  : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
