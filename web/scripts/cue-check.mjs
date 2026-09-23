// What a change looks like after its flash, and when it is off screen; see
// `pushPanelBorder` and `pushEdgeMarks` in scene.ts, and edgemarks.ts.
//
//   afterglow   zoomed out, where the marks on the lines cannot be drawn, a
//               changed panel still stands out after its flash is over, and
//               stops once its lines are no longer marked.
//   off screen  zoomed into one file, a change to another puts a mark on the
//               edge of the view on its side, and a click on the mark goes
//               there.
import { decodePng } from './png.mjs';
import { base, canvasBox, frameOnScreen, launch, settled } from './browser.mjs';

let failures = 0;
const report = (ok, text) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${text}`);
  if (!ok) failures++;
};

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
await page.goto(`${base}/?demo=pathsim`, { waitUntil: 'load' });
await page.waitForFunction(() => (document.querySelector('footer')?.textContent ?? '').includes('files'), null, { timeout: 60000 });
await settled(page);
const box = await canvasBox(page);
const shot = async () => {
  await frameOnScreen(page);
  return decodePng(await page.screenshot({ clip: { x: box.x, y: box.y, width: box.w, height: box.h } }));
};

/** Pixels of a rectangle's outline, two device pixels wide, that differ. */
const outlineDiff = (a, b, r) => {
  const d = a.width / box.w;
  let n = 0;
  let all = 0;
  const x0 = Math.round(r.x * d), y0 = Math.round(r.y * d);
  const x1 = Math.round((r.x + r.w) * d), y1 = Math.round((r.y + r.h) * d);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (x - x0 > 2 && x1 - x > 3 && y - y0 > 2 && y1 - y > 3) continue;
      if (x < 0 || y < 0 || x >= a.width || y >= a.height) continue;
      const i = (y * a.width + x) * 4;
      const dd = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
      all++;
      if (dd > 40) n++;
    }
  }
  return n / Math.max(1, all);
};

// Zoomed out: the whole project.
const target = await page.evaluate(async () => {
  const app = window.__sanity.app;
  app.fit(0);
  for (let i = 0; i < 5; i++) { app.invalidate(); await new Promise((q) => requestAnimationFrame(q)); }
  // The largest panel, so its outline is a fair number of pixels.
  const f = [...app.scene.files.values()].filter((x) => !x.node.stub && !x.node.media)
    .sort((a, b) => b.node.w * b.node.h - a.node.w * a.node.h)[0];
  const [x0, y0] = app.cam.worldToScreen(f.node.x, f.node.y);
  const [x1, y1] = app.cam.worldToScreen(f.node.x + f.node.w, f.node.y + f.node.h);
  return { path: f.node.path, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
});
const before = await shot();
await page.evaluate((p) => window.__sanity.app.touch(p), target.path);
await page.waitForTimeout(1500);
const glowing = await shot();
await page.waitForTimeout(4500);
const after = await shot();
const glow = outlineDiff(before, glowing, target.rect);
const rest = outlineDiff(before, after, target.rect);
report(glow > 0.5, `1.5 s after a change, past its flash, ${(glow * 100).toFixed(0)} percent of its outline is lit`);
report(rest < 0.02, `6 s after, once its marks are gone, ${(rest * 100).toFixed(1)} percent`);

// Zoomed into one file, a change to another far away.
const off = await page.evaluate(async () => {
  const app = window.__sanity.app;
  const files = [...app.scene.files.values()].filter((x) => !x.node.stub);
  const [x0, y0, x1, y1] = app.layout.bounds;
  // One near the left edge of the project, and the change near the right.
  const left = files.sort((a, b) => a.node.x - b.node.x)[0];
  const right = files.sort((a, b) => b.node.x + b.node.w - a.node.x - a.node.w)[0];
  app.cam.stop();
  app.cam.zoom = Math.min(app.cam.vw / left.node.w, app.cam.vh / left.node.h) * 0.9;
  app.cam.x = left.node.x + left.node.w / 2;
  app.cam.y = left.node.y + left.node.h / 2;
  app.invalidate();
  await new Promise((q) => requestAnimationFrame(() => requestAnimationFrame(q)));
  app.touch(right.node.path);
  for (let i = 0; i < 5; i++) { app.invalidate(); await new Promise((q) => requestAnimationFrame(q)); }
  const edges = app.scene.edges;
  return { path: right.node.path, edges, vw: app.cam.vw, bounds: [x0, y0, x1, y1] };
});
const mark = off.edges.find((m) => m.path === off.path);
report(Boolean(mark), `a change off screen is marked on the edge (${off.edges.length} mark${off.edges.length === 1 ? '' : 's'})`);
if (mark) {
  report(mark.x + mark.w > off.vw - 10, `on the side it is on: x ${mark.x.toFixed(0)} of ${off.vw}`);
  const img = await shot();
  const d = img.width / box.w;
  const i = (Math.round((mark.y + mark.h / 2) * d) * img.width + Math.round((mark.x + mark.w / 2) * d)) * 4;
  const heat = await page.evaluate(() => window.__sanity.app.scene.pal.surface.heat);
  const want = [(heat >> 16) & 255, (heat >> 8) & 255, heat & 255];
  const got = [img.data[i], img.data[i + 1], img.data[i + 2]];
  const off3 = Math.max(...want.map((v, k) => Math.abs(v - got[k])));
  report(off3 < 40, `drawn in the heat colour: ${got.join(',')} against ${want.join(',')}`);

  // A click on it goes there.
  const landed = await page.evaluate(async (m) => {
    const app = window.__sanity.app;
    const c = document.querySelector('canvas');
    const r = c.getBoundingClientRect();
    const at = { clientX: r.left + m.x + m.w / 2, clientY: r.top + m.y + m.h / 2, pointerId: 1, bubbles: true };
    c.dispatchEvent(new PointerEvent('pointerdown', at));
    c.dispatchEvent(new PointerEvent('pointerup', at));
    for (let i = 0; i < 120 && app.cam.flying; i++) await new Promise((q) => requestAnimationFrame(q));
    const n = app.scene.files.get(m.path).node;
    const [vx0, vy0, vx1, vy1] = app.cam.visibleRect(0);
    return n.x >= vx0 && n.y >= vy0 && n.x + n.w <= vx1 && n.y + n.h <= vy1;
  }, mark);
  report(landed, 'a click on the mark puts the changed file in view');
}

await browser.close();
console.log(failures === 0 ? '\nchanges stay visible after their flash, and off screen' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
