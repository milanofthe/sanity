// Asserts that zooming and dragging do not flicker.
//
// Two causes were found by recording every frame of a gesture, and both are
// invisible in a screenshot and obvious in motion:
//
//   rest     The renderer draws a view at rest differently from one in motion:
//            text from an atlas rasterised at the exact size, pictures 1:1.
//            Rest used to mean the first frame without movement, and input
//            arrives at its own rate, so any frame drawn between two wheel
//            steps counted. A wheel zoom of 80 steps drew 160 frames, 80 of
//            them at rest, alternating: 159 switches, and the text changing
//            size and sharpness every other frame.
//   rounding Text, edges and exact pictures are rounded to the pixel grid in
//            float32. With the camera's position inside that rounding, each
//            step of a drag changed the float error, and whatever sat on a
//            half pixel hopped a pixel and back. A camera on a half pixel is
//            not contrived: a fit or a zoom to a round level puts it there,
//            and a drag by whole pixels keeps it there.
//
// So: a wheel zoom driven by real events draws no frame at rest until it has
// stopped, and then draws one and parks, which it also used not to do: with
// nothing else going on, the last frame of a zoom was the last frame, and the
// text stayed soft until something else drew; and a drag by whole pixels, from a
// camera on a half pixel, draws every frame as an exact shift of the one
// before, at every level of detail.
import { base, launch, settled } from './browser.mjs';

/** Share of pixels, in percent, a frame of a drag may differ from the one
 *  before it shifted by the drag. Measured: 0.00 to 0.01 at five zooms, from
 *  0.5 to 2.1 before the rounding was split. */
const SHIFT_LIMIT = 0.05;

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log(`[error] ${e.message}`));
await page.goto(`${base}/?demo=pathsim`, { waitUntil: 'load' });
await page.waitForFunction(() => (document.querySelector('footer')?.textContent ?? '').includes('files'), null, { timeout: 60000 });
await settled(page);

let failed = false;
const fail = (msg) => {
  console.log(`FAIL ${msg}`);
  failed = true;
};

// Rest: wheel events, which is what zooming is, at a trackpad's uneven pace.
for (const ppl of [9, 2.5]) {
  await page.evaluate((ppl) => window.__sanity.zoomTo(ppl / 14), ppl);
  await settled(page);
  await page.evaluate(() => {
    const s = window.__sanity.app.scene;
    window.__frames = [];
    if (!s.__logged) {
      const render = s.render.bind(s);
      s.render = (cam, dt) => {
        render(cam, dt);
        window.__frames?.push({ t: performance.now(), still: s.cameraStill });
      };
      s.__logged = true;
    }
  });
  // Something else keeping the loop going through the gesture, as detail
  // streaming in or a picture fading does, so frames are drawn between the
  // wheel steps; without that there is nothing between them to be at rest.
  await page.evaluate(() => {
    window.__busy = true;
    const busy = () => {
      if (!window.__busy) return;
      window.__sanity.app.invalidate();
      requestAnimationFrame(busy);
    };
    requestAnimationFrame(busy);
  });
  await page.mouse.move(500, 350);
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(0, i % 3 === 0 ? -6 : -4);
    await page.waitForTimeout(8 + (i * 7) % 17);
  }
  const stopped = await page.evaluate(() => {
    window.__busy = false;
    return performance.now();
  });
  await page.waitForTimeout(600);
  const r = await page.evaluate((stopped) => {
    const f = window.__frames;
    window.__frames = null;
    const during = f.filter((x) => x.t <= stopped);
    const after = f.filter((x) => x.t > stopped);
    return {
      frames: during.length,
      still: during.filter((x) => x.still).length,
      rest: after.filter((x) => x.still).length,
      parked: !window.__sanity.app.running,
    };
  }, stopped);
  console.log(`wheel at ${ppl} px/line: ${r.frames} frames, ${r.still} of them at rest, ${r.rest} at rest after, parked ${r.parked}`);
  if (r.still > 0) fail(`${r.still} frames of a zoom at ${ppl} px/line were drawn as if at rest`);
  if (r.rest < 1) fail(`the view at ${ppl} px/line was never drawn at rest after the zoom stopped`);
  if (!r.parked) fail(`the loop kept running after the zoom at ${ppl} px/line came to rest`);
}

// Rounding: a drag by whole pixels from a camera on a half pixel.
for (const ppl of [0.6, 1.5, 2.5, 4.5, 9]) {
  const r = await page.evaluate(async (ppl) => {
    const app = window.__sanity.app;
    const s = app.scene;
    const gl = s.gl;
    const cam = app.cam;
    window.__sanity.zoomTo(ppl / 14);
    for (let i = 0; i < 90; i++) await new Promise((q) => requestAnimationFrame(q));
    // Whole pixels across, half a pixel down.
    cam.x = Math.round(cam.x * cam.zoom) / cam.zoom;
    cam.y = (Math.round(cam.y * cam.zoom) + 0.5) / cam.zoom;
    app.invalidate();
    for (let i = 0; i < 20; i++) await new Promise((q) => requestAnimationFrame(q));
    const W = gl.drawingBufferWidth;
    const H = gl.drawingBufferHeight;
    const frames = [];
    const render = s.render.bind(s);
    s.render = (c, dt) => {
      render(c, dt);
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      frames.push({ px, x: c.x, y: c.y, z: c.zoom, still: s.cameraStill });
    };
    for (let i = 0; i < 30; i++) {
      cam.panBy(3, 2);
      app.invalidate();
      await new Promise((q) => setTimeout(q, 9 + (i * 7) % 15));
    }
    await new Promise((q) => setTimeout(q, 300));
    s.render = render;
    // Each frame against the one before it, moved by the drag, leaving out
    // the edges of the view, which have nothing before them to compare with.
    let worst = 0;
    for (let k = 1; k < frames.length; k++) {
      const a = frames[k - 1];
      const b = frames[k];
      if (b.still) continue;
      const dx = Math.round((a.x - b.x) * b.z);
      const dy = Math.round((a.y - b.y) * b.z);
      let n = 0;
      let off = 0;
      for (let y = 40; y < H - 40; y += 2) {
        for (let x = 40; x < W - 40; x += 2) {
          const ib = (y * W + x) * 4;
          const ia = ((y + dy) * W + x - dx) * 4;
          const d = Math.abs(a.px[ia] - b.px[ib]) + Math.abs(a.px[ia + 1] - b.px[ib + 1])
            + Math.abs(a.px[ia + 2] - b.px[ib + 2]);
          n++;
          if (d > 60) off++;
        }
      }
      worst = Math.max(worst, (100 * off) / n);
    }
    return { frames: frames.length, worst };
  }, ppl);
  console.log(`drag at ${ppl} px/line: ${r.frames} frames, worst ${r.worst.toFixed(2)}% off the shifted frame before`);
  if (r.frames < 10) fail(`a drag at ${ppl} px/line drew only ${r.frames} frames`);
  if (r.worst > SHIFT_LIMIT) fail(`a drag at ${ppl} px/line changed ${r.worst.toFixed(2)}% of the picture in one frame`);
}

await browser.close();
if (failed) process.exit(1);
console.log('flicker ok');
