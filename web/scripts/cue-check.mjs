// What a change looks like; see `pushChangeBands`, `pushBand` and the leaving
// panels in scene.ts, and `update` in camera.ts.
//
//   lines        zoomed out, where the lines cannot be read, the lines a
//                change took away flash red and the ones it put in flash
//                green, in the theme's own colours.
//   deleted      a file that is gone fades out in red where it was, and its
//                texture is let go once it has.
//   flight       flying to a file moves it across the screen in a straight
//                line, not in a swing out and back.
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
const shot = async () =>
  decodePng(await page.screenshot({ clip: { x: box.x, y: box.y, width: box.w, height: box.h } }));

/** Pixels inside a screen rect within `tol` of a colour, per channel. */
const near = (img, r, hex, tol = 40) => {
  const d = img.width / box.w;
  const want = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
  let n = 0;
  for (let y = Math.max(0, Math.round(r.y * d)); y < Math.min(img.height, Math.round((r.y + r.h) * d)); y++) {
    for (let x = Math.max(0, Math.round(r.x * d)); x < Math.min(img.width, Math.round((r.x + r.w) * d)); x++) {
      const i = (y * img.width + x) * 4;
      if (Math.abs(img.data[i] - want[0]) < tol && Math.abs(img.data[i + 1] - want[1]) < tol
        && Math.abs(img.data[i + 2] - want[2]) < tol) n++;
    }
  }
  return n;
};

// The loop is taken over and frames are drawn at chosen moments: a
// screenshot of this canvas takes longer than the removal phase lasts, so one
// taken "right after" a change caught whatever phase it happened to land in.
// The canvas keeps its drawing buffer, so what a stepped frame drew is what
// the screenshot sees.
await page.evaluate(() => {
  const app = window.__sanity.app;
  cancelAnimationFrame(app.raf);
  app.running = true;
  window.__step = (seconds) => {
    // Every step drawn: a panel's animation advances as it is drawn.
    const dt = 1 / 60;
    for (let t = 0; t < seconds - 1e-9; t += dt) {
      app.scene.advance(dt);
      app.scene.render(app.cam, dt);
    }
    app.scene.render(app.cam, 0);
  };
});

const colours = await page.evaluate(() => {
  const s = window.__sanity.app.scene.pal.surface;
  return { added: s.added, deleted: s.deleted };
});

// The whole project, and the largest file in it.
const target = await page.evaluate(async () => {
  const app = window.__sanity.app;
  app.fit(0);
  window.__step(0);
  const f = [...app.scene.files.values()].filter((x) => !x.node.stub && !x.node.media)
    .sort((a, b) => b.node.w * b.node.h - a.node.w * a.node.h)[0];
  const [x0, y0] = app.cam.worldToScreen(f.node.x, f.node.y);
  const [x1, y1] = app.cam.worldToScreen(f.node.x + f.node.w, f.node.y + f.node.h);
  return { path: f.node.path, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, lines: f.data.lineCount };
});
const before = await shot();

// Forty lines in the middle replaced by forty from the start: a removal and
// an addition of the same size, which fits the panel it is in.
await page.evaluate((path) => {
  const app = window.__sanity.app;
  const d = app.scene.files.get(path).data;
  const mid = Math.floor(d.lineCount / 2);
  const order = [...Array(d.lineCount).keys()].map((i) => (i >= mid && i < mid + 40 ? i - mid : i));
  const spanStart = new Uint32Array(order.length + 1);
  const spans = [];
  order.forEach((i, k) => {
    spanStart[k] = spans.length;
    for (let s = d.spanStart[i]; s < d.spanStart[i + 1]; s++) spans.push(d.spans[s]);
  });
  spanStart[order.length] = spans.length;
  app.touch(path, {
    lineCount: order.length, langId: d.langId, flags: d.flags, spanStart,
    lineCols: Uint16Array.from(order.map((i) => d.lineCols[i])),
    lineIndent: Uint8Array.from(order.map((i) => d.lineIndent[i])),
    lineState: new Uint8Array(order.length),
    spans: Uint32Array.from(spans),
  });
  window.__step(0.05);
}, target.path);
const removing = await shot();
await page.evaluate(() => window.__step(0.3));
const adding = await shot();
await page.evaluate(() => window.__step(2));
const over = await shot();

const red = near(removing, target.rect, colours.deleted) - near(before, target.rect, colours.deleted);
const green = near(adding, target.rect, colours.added) - near(before, target.rect, colours.added);
const left = near(over, target.rect, colours.added) - near(before, target.rect, colours.added);
report(red > 200, `zoomed out, the lines taken away flash red: ${red} pixels`);
report(green > 200, `and the lines put in flash green: ${green} pixels`);
report(left < 20, `two seconds later nothing is left of it: ${left} pixels`);

// A file deleted.
const del = await page.evaluate(async (path) => {
  const app = window.__sanity.app;
  const layers = app.scene.textures.stats().layers;
  const src = app.lastSource;
  app.relayout({ ...src, entries: src.entries.filter((e) => e.path !== path) });
  // The rest of the panels arriving from the reopen, as the loop would.
  while (app.pending.length > 0) app.uploadBudget();
  window.__step(0.02);
  return { layers, leaving: app.scene.leaving.size };
}, target.path);
const fading = await shot();
const redWash = near(fading, target.rect, colours.deleted, 90) - near(before, target.rect, colours.deleted, 90);
const gone = await page.evaluate(() => {
  const app = window.__sanity.app;
  window.__step(1);
  window.__step(0);
  return { leaving: app.scene.leaving.size, layers: app.scene.textures.stats().layers };
});
const after = await shot();
const redAfter = near(after, target.rect, colours.deleted, 90) - near(before, target.rect, colours.deleted, 90);
report(del.leaving === 1, `a deleted file stays to fade out (${del.leaving} leaving)`);
report(redWash > 1000, `in red where it was: ${redWash} pixels`);
report(gone.leaving === 0 && redAfter < 200, `and is gone after the fade: ${gone.leaving} leaving, ${redAfter} red pixels left`);
report(gone.layers < del.layers, `its texture is let go: ${del.layers} layers, then ${gone.layers}`);

// A flight to a small file far from the centre of the view, with the loop
// given back.
const flight = await page.evaluate(async () => {
  const app = window.__sanity.app;
  app.running = false;
  app.invalidate();
  app.fit(0);
  const files = [...app.scene.files.values()].filter((x) => !x.node.stub);
  const f = files.sort((a, b) => (b.node.x + b.node.y) - (a.node.x + a.node.y))[0];
  const cx = f.node.x + f.node.w / 2;
  const cy = f.node.y + f.node.h / 2;
  const path = [];
  app.focusFile(f.node.path, 0.6);
  while (app.cam.flying) {
    await new Promise((q) => requestAnimationFrame(q));
    path.push(app.cam.worldToScreen(cx, cy));
  }
  const [a, b] = [path[0], path[path.length - 1]];
  let worst = 0;
  for (const p of path) {
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    worst = Math.max(worst, Math.abs(cross) / Math.max(1e-9, Math.hypot(b[0] - a[0], b[1] - a[1])));
  }
  return { frames: path.length, worst, travel: Math.hypot(b[0] - a[0], b[1] - a[1]) };
});
report(flight.worst < 1, `flying to a file, it strays ${flight.worst.toFixed(2)} px from a straight line over ${flight.travel.toFixed(0)} px (${flight.frames} frames)`);

await browser.close();
console.log(failures === 0 ? '\na change reads as red and green, a deletion fades, a flight goes straight' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
