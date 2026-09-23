// Whether a picture at rest is drawn crisp: its source averaged down to the
// exact pixels it covers, and put on the pixel grid.
//
// The reference is computed here, from the source file, by the same rule the
// renderer is meant to follow: every screen pixel the area-weighted average of
// the source pixels under it, composited on the paper the canvas puts under a
// translucent picture. What is on screen is compared against it, pixel for
// pixel, at the position the renderer says it drew the picture at.
//
// Before this rule the picture was decoded to a power of two by the browser
// and scaled onto the screen at a fractional position, and the result depended
// on the engine: grainy in WebKit, soft in Chromium, and off by a pixel in
// both. Measured against a Lanczos reference, WebKit was twice as far off.
//
// Run at dpr 1, so a screenshot clip in CSS pixels is a clip in device pixels.
import { readFileSync } from 'node:fs';
import { decodePng } from './png.mjs';
import { base, canvasBox, frameOnScreen, launch, settled } from './browser.mjs';

const NAMES = [
  'linear_feedback_blockdiagram_g.png',
  'algebraicloop_blockdiagram_g.png',
  'stick_slip_blockdiagram_g.png',
];

/**
 * Largest mean difference from the reference, per channel, 0 to 255.
 *
 * Measured with the rule in place: 0.02 to 0.05, in Chromium and WebKit alike,
 * the rest being the GPU's bilinear sub-samples against an exact area average.
 * Decoded to a power of two by the browser and scaled onto the screen, as
 * before, it was 1.30 to 5.61 in Chromium and 1.67 to 13.72 in WebKit.
 */
const LIMIT = 0.5;

/** Area-weighted average of `src` down to `dw` by `dh`, over `paper`. */
function reference(src, dw, dh, paper) {
  const sx = src.width / dw;
  const sy = src.height / dh;
  const out = new Float64Array(dw * dh * 3);
  for (let j = 0; j < dh; j++) {
    const y0 = j * sy;
    const y1 = y0 + sy;
    for (let i = 0; i < dw; i++) {
      const x0 = i * sx;
      const x1 = x0 + sx;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let area = 0;
      for (let y = Math.floor(y0); y < Math.min(src.height, Math.ceil(y1)); y++) {
        const wy = Math.min(y1, y + 1) - Math.max(y0, y);
        for (let x = Math.floor(x0); x < Math.min(src.width, Math.ceil(x1)); x++) {
          const w = wy * (Math.min(x1, x + 1) - Math.max(x0, x));
          const o = (y * src.width + x) * 4;
          const al = src.data[o + 3] / 255;
          r += src.data[o] * al * w;
          g += src.data[o + 1] * al * w;
          b += src.data[o + 2] * al * w;
          a += al * w;
          area += w;
        }
      }
      const k = (j * dw + i) * 3;
      const cover = a / area;
      out[k] = r / area + paper[0] * (1 - cover);
      out[k + 1] = g / area + paper[1] * (1 - cover);
      out[k + 2] = b / area + paper[2] * (1 - cover);
    }
  }
  return out;
}

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
await page.goto(`${base}/?demo=pathsim`, { waitUntil: 'load' });
await page.waitForFunction(() => (document.querySelector('footer')?.textContent ?? '').includes('files'), null, { timeout: 60000 });
await settled(page);

let failures = 0;
for (const frac of [0.5, 0.25]) {
  for (const name of NAMES) {
    const r = await page.evaluate(async ([name, frac]) => {
      const app = window.__sanity.app;
      const f = app.layout.files.find((x) => x.path.endsWith(`/${name}`));
      if (!f) return null;
      app.cam.zoom = (app.cam.vw * frac) / f.w;
      app.cam.x = f.x + f.w / 2;
      app.cam.y = f.y + f.h / 2;
      app.invalidate();
      // Until the exact version has been made and has faded in all the way.
      // A fixed wait was not enough in WebKit, which took 620 ms to make it,
      // and a screenshot mid-fade measures the level it is fading from.
      const mine = () => app.scene.imageDraws.find(
        (d) => d.x >= f.x - 1 && d.x < f.x + f.w && d.y >= f.y - 1 && d.y < f.y + f.h,
      );
      for (let t = 0; t < 100; t++) {
        app.invalidate();
        await new Promise((q) => requestAnimationFrame(() => requestAnimationFrame(q)));
        const d = mine();
        if (d && (d.exact ?? true) && (d.mix ?? 1) >= 1 && !app.scene.media.fading?.()) break;
        await new Promise((q) => setTimeout(q, 50));
      }
      const d = mine();
      if (!d) return null;
      const cam = app.cam;
      const s = cam.zoom * cam.dpr;
      const left = Math.round((cam.vw / 2 - cam.x * cam.zoom) * cam.dpr + d.x * s);
      const top = Math.round((cam.vh / 2 - cam.y * cam.zoom) * cam.dpr + d.y * s);
      const hex = app.scene.pal.surface.paper;
      // A renderer from before exact pictures has no texture size to report;
      // then the rect as it lands on the grid.
      const w = d.tw ?? Math.round((d.x + d.w) * s) - Math.round(d.x * s);
      const h = d.th ?? Math.round((d.y + d.h) * s) - Math.round(d.y * s);
      return {
        path: f.path, left, top, w, h, exact: d.exact ?? false,
        paper: [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255],
      };
    }, [name, frac]);
    if (!r) {
      console.log(`FAIL  ${name}: not on screen`);
      failures++;
      continue;
    }
    await frameOnScreen(page);
    const box = await canvasBox(page);
    const raw = await page.screenshot({
      clip: { x: box.x + r.left, y: box.y + r.top, width: r.w, height: r.h },
    });
    const shot = decodePng(raw);
    const src = decodePng(readFileSync(`web/public/demo/pathsim/media/${r.path}`));
    const ref = reference(src, r.w, r.h, r.paper);
    // Interior only: the outermost pixel row and column meet the panel's own
    // edge, which is the panel's to draw.
    let sum = 0;
    let n = 0;
    for (let y = 1; y < r.h - 1; y++) {
      for (let x = 1; x < r.w - 1; x++) {
        const o = (y * shot.width + x) * 4;
        const k = (y * r.w + x) * 3;
        sum += Math.abs(shot.data[o] - ref[k]) + Math.abs(shot.data[o + 1] - ref[k + 1])
          + Math.abs(shot.data[o + 2] - ref[k + 2]);
        n += 3;
      }
    }
    const err = sum / n;
    const bad = !r.exact || err > LIMIT;
    console.log(
      `${bad ? 'FAIL' : 'ok  '}  ${String(frac).padEnd(4)} ${name.padEnd(40)} ${r.w}x${r.h}` +
        ` ${r.exact ? 'drawn 1:1' : 'SCALED'}, ${err.toFixed(2)} off the area average`,
    );
    if (bad) failures++;
  }
}

// A drawing: an SVG has no pixels of its own, so it is drawn at exactly the
// size it is shown at rather than scaled from some resolution. Before, it was
// handed to the browser's image decoder like a PNG, which cannot read one, and
// every SVG in a project stayed an empty placeholder.
// rapidfem, of the demos `npm run demo` makes, is the one with an SVG in it.
await page.goto(`${base}/?demo=rapidfem`, { waitUntil: 'load' });
await page.waitForFunction(() => (document.querySelector('footer')?.textContent ?? '').includes('files'), null, { timeout: 60000 });
await settled(page);
for (const frac of [0.05, 0.3]) {
  const v = await page.evaluate(async (frac) => {
    const app = window.__sanity.app;
    const m = app.scene.media;
    const f = app.layout.files.find((x) => x.path.endsWith('.svg'));
    if (!f) return null;
    app.cam.zoom = (app.cam.vw * frac) / f.w;
    app.cam.x = f.x + f.w / 2;
    app.cam.y = f.y + f.h / 2;
    app.invalidate();
    // Until what is drawn is made for this size and has faded in: the one
    // from the zoom before is exact too, for the size it was.
    const mine = () => app.scene.imageDraws.find(
      (d) => d.x >= f.x - 1 && d.x < f.x + f.w && d.y >= f.y - 1 && d.y < f.y + f.h,
    );
    for (let t = 0; t < 100; t++) {
      app.invalidate();
      await new Promise((q) => requestAnimationFrame(() => requestAnimationFrame(q)));
      const d = mine();
      if (d?.exact && d.mix >= 1 && !m.fading()) break;
      await new Promise((q) => setTimeout(q, 50));
    }
    const d = mine();
    return {
      path: f.path, held: d ? `${d.tw}x${d.th}` : null, exact: d?.exact ?? false,
      failed: m.failed.has(f.path),
    };
  }, frac);
  const ok = v !== null && v.held !== null && v.exact && !v.failed;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${String(frac).padEnd(4)} ${v?.path ?? 'no svg'} drawn at ${v?.held ?? 'nothing'}${v?.exact ? ', exactly its size on screen' : ''}`);
  if (!ok) failures++;
}

await browser.close();
console.log(failures === 0
  ? '\npictures at rest are their source averaged onto the pixels they cover, drawings drawn at them'
  : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
