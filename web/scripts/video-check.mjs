// Asserts that a replay renders to a video that is what the plan says.
//
// The history is only there in the desktop app, so the replay here plays a
// made-up one: twelve commits, each of which only records that it was shown.
// What is checked is everything around the history, which is the part that
// can go wrong without anyone seeing it until the file is opened:
//
//   the file    a valid MP4, H.264, 1920 by 1080, as many frames as planned,
//               as long as planned
//   the steps   every commit of the plan shown, in order, oldest first
//   a frame     the project in it, and the commit line along the bottom in
//               the theme's colours
//   after       the canvas and the camera back as they were, and the clock
//               running on without going back in time
//   cancel      nothing kept, and the canvas back all the same
//   codecs      H.264 found by trying, and VP9, the fallback where there is
//               no H.264 encoder, writing a video as well
import { base, launch, settled } from './browser.mjs';

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
page.on('pageerror', (e) => console.log(`[error] ${e.message}`));
await page.goto(`${base}/?demo=pathsim`, { waitUntil: 'load' });
await page.waitForFunction(() => (document.querySelector('footer')?.textContent ?? '').includes('files'), null, { timeout: 60000 });
await settled(page);

let failed = false;
const expect = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!ok) failed = true;
};

const r = await page.evaluate(async () => {
  const app = window.__sanity.app;
  const V = await import('/src/lib/video.ts');
  const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('mediabunny'));
  const mb = await import(url);
  const before = {
    w: app.canvas.width, h: app.canvas.height, x: app.cam.x, y: app.cam.y, zoom: app.cam.zoom,
  };

  const shown = [];
  const source = {
    go: async (i) => { shown.push(i); },
    caption: (i) => ({ meta: `2026-09-${String(24 - i).padStart(2, '0')}  c${i}`, subject: `commit number ${i}` }),
  };
  const fps = 30;
  const plan = V.planReplay(12, 0, 6, fps);
  const sink = V.memorySink();
  const t0 = performance.now();
  const where = await V.renderReplay(app, plan, source, sink, { size: '1080p', fps });
  const took = performance.now() - t0;
  const bytes = sink.bytes();
  const shownOnce = [...shown];

  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BufferSource(bytes) });
  const track = await input.getPrimaryVideoTrack();
  const stats = await track.computePacketStats();
  const duration = await input.computeDuration();
  const codec = await track.getCodecParameterString();
  // A frame from the middle of the second step, drawn to read its pixels.
  const frames = new mb.CanvasSink(track, { poolSize: 1 });
  const at = (plan.introFrames + plan.stepFrames * 1.5) / fps;
  const wrapped = await frames.getCanvas(at);
  const c = wrapped.canvas;
  const g = c.getContext('2d');
  const lum = (y0, y1) => {
    const d = g.getImageData(0, y0, c.width, y1 - y0).data;
    let sum = 0;
    let sq = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
      sum += l;
      sq += l * l;
    }
    const mean = sum / n;
    return { mean, sd: Math.sqrt(sq / n - mean * mean) };
  };
  const band = Math.round((1080 / 48) * 2.2);
  const middle = lum(200, 800);
  const bottom = lum(1080 - band + 4, 1080 - 4);

  const after = {
    w: app.canvas.width, h: app.canvas.height, x: app.cam.x, y: app.cam.y, zoom: app.cam.zoom,
  };

  // Cancelled a few frames in.
  const ctl = new AbortController();
  const sink2 = V.memorySink();
  const cancelled = await V.renderReplay(app, plan, source, sink2, {
    size: '1080p', fps, onProgress: (done) => { if (done === 10) ctl.abort(); }, signal: ctl.signal,
  });
  const afterCancel = { w: app.canvas.width, h: app.canvas.height };

  // The codec found by trying, and the fallback the export takes where
  // H.264 cannot be encoded, which is some Windows machines.
  const found = await V.videoCodec('1080p');
  const sink3 = V.memorySink();
  await V.renderReplay(app, V.planReplay(2, 0, 3, fps), source, sink3, { size: '1080p', fps, codec: 'vp9' });
  const vp9 = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BufferSource(sink3.bytes()) });
  const vp9Track = await vp9.getPrimaryVideoTrack();
  const fallback = { codec: await vp9Track.getCodecParameterString(), packets: (await vp9Track.computePacketStats()).packetCount };
  await new Promise((q) => requestAnimationFrame(() => requestAnimationFrame(q)));

  return {
    where, took, plan: { frames: plan.frames, seconds: plan.seconds, start: plan.start, targets: plan.targets },
    shown: shownOnce, packets: stats.packetCount, duration, codec, width: track.displayWidth, height: track.displayHeight,
    found: found?.codec ?? null, fallback, middle, bottom, before, after, cancelled, kept: sink2.bytes(), afterCancel,
    // The app's own clock module, not a second copy of it.
    clockAhead: await (async () => {
      const u = performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('canvas/clock.ts'));
      return (await import(u)).clock.now() - performance.now();
    })(),
  };
});

console.log(`rendered ${r.plan.frames} frames in ${(r.took / 1000).toFixed(1)} s`);
expect(r.where === 'memory', 'the video was written');
expect(r.codec.startsWith('avc1'), `H.264 (${r.codec})`);
expect(r.width === 1920 && r.height === 1080, `1920 by 1080 (${r.width} by ${r.height})`);
expect(r.packets === r.plan.frames, `as many frames as planned (${r.packets} of ${r.plan.frames})`);
expect(Math.abs(r.duration - r.plan.seconds) < 0.05, `as long as planned (${r.duration.toFixed(2)} s of ${r.plan.seconds.toFixed(2)})`);
expect(JSON.stringify(r.shown) === JSON.stringify([r.plan.start, ...r.plan.targets]), `every step shown, in order (${r.shown.join(' ')})`);
expect(r.middle.sd > 8, `the project is in the frame (spread ${r.middle.sd.toFixed(1)})`);
expect(r.bottom.sd > 3 && Math.abs(r.bottom.mean - r.middle.mean) < 60, `the commit line is along the bottom (mean ${r.bottom.mean.toFixed(0)}, spread ${r.bottom.sd.toFixed(1)})`);
expect(r.after.w === r.before.w && r.after.h === r.before.h, 'the canvas is its own size again');
expect(r.after.x === r.before.x && r.after.y === r.before.y && r.after.zoom === r.before.zoom, 'the camera is where it was');
// A video renders faster than it plays, and the clock keeps the lead rather
// than go back in time: never behind the wall, never ahead by more than was
// rendered.
expect(r.clockAhead >= -1 && r.clockAhead <= 2 * r.plan.seconds * 1000, `the clock runs on, ${(r.clockAhead / 1000).toFixed(1)} s ahead of the wall`);
expect(r.found === 'avc', `trying finds H.264 here (${r.found})`);
expect(r.fallback.codec.startsWith('vp09') && r.fallback.packets > 0, `and VP9 writes a video too (${r.fallback.codec}, ${r.fallback.packets} frames)`);
expect(r.cancelled === null && r.kept === null, 'a cancelled video keeps nothing');
expect(r.afterCancel.w === r.before.w && r.afterCancel.h === r.before.h, 'and gives the canvas back');

await browser.close();
if (failed) process.exit(1);
console.log('\na replay renders to the video it plans');
