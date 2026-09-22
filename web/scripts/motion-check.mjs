// Whether moving over pictures stays smooth.
//
// The case that stuttered was stop and go, the way a wheel zooms: a few frames
// of movement, a pause long enough for the pictures to start loading, and the
// next movement landing on top of their uploads. In WebKit, which the desktop
// app draws with, uploading a decoded ImageBitmap cost 31 to 33 ms whatever
// its size, and that pattern came out at 47 frames over 25 ms in 240, the
// worst at 99. Pictures are now decoded to raw pixels on a worker, and what is
// left on the main thread is an upload of those, a few milliseconds at most.
//
// Run it in the engine that matters: SANITY_ENGINE=webkit.
import { base, launch, settled } from './browser.mjs';

/** Frames of the 240 that may take longer than 25 ms, and the longest a
 *  single upload may take. Measured in WebKit: 4 and 4 ms; in Chromium: 0
 *  and 5 ms. The same run without pictures has 1 in WebKit. */
const SLOW_FRAMES = 10;
const WORST_UPLOAD_MS = 12;

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
await page.goto(`${base}/?demo=pathsim`, { waitUntil: 'load' });
await page.waitForFunction(() => (document.querySelector('footer')?.textContent ?? '').includes('files'), null, { timeout: 60000 });
await settled(page);

const r = await page.evaluate(async () => {
  const app = window.__sanity.app;
  const media = app.scene.media;
  // The directory with the most pictures in it.
  const count = new Map();
  for (const f of app.layout.files) {
    if (!f.media) continue;
    const d = f.path.split('/').slice(0, -1).join('/');
    count.set(d, (count.get(d) ?? 0) + 1);
  }
  const dirPath = [...count].sort((a, b) => b[1] - a[1])[0][0];
  const d = app.layout.dirs.find((x) => x.path === dirPath);
  const z0 = Math.min(app.cam.vw / d.w, app.cam.vh / d.h);
  const before = { ...media.stats() };
  // The worst upload is kept since the project opened; this run is what is
  // being measured.
  media.worstUpload = 0;
  const gaps = [];
  let last = performance.now();
  for (let i = 0; i < 240; i++) {
    const t = i / 240;
    app.cam.zoom = z0 * (1.2 + 3.8 * Math.sin(t * Math.PI));
    app.cam.x = d.x + d.w * (0.2 + 0.6 * t);
    app.cam.y = d.y + d.h * (0.3 + 0.4 * Math.sin(t * 5) ** 2);
    app.invalidate();
    await new Promise((q) => requestAnimationFrame(q));
    const now = performance.now();
    gaps.push(now - last);
    last = now;
    // Stop and go: a pause after every ten frames, long enough for loading
    // to start, which is what the next movement then lands on.
    if (i % 10 === 9) {
      await new Promise((q) => setTimeout(q, 180));
      last = performance.now();
    }
  }
  const after = media.stats();
  gaps.sort((a, b) => a - b);
  return {
    slow: gaps.filter((g) => g > 25).length,
    worst: gaps[gaps.length - 1],
    p95: gaps[Math.floor(gaps.length * 0.95)],
    decodes: after.decodes - before.decodes,
    uploadMs: after.uploadMs - before.uploadMs,
    worstUpload: after.worstUpload,
  };
});

let failures = 0;
const report = (ok, text) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${text}`);
  if (!ok) failures++;
};
console.log(
  `stop and go over pictures: p95 ${r.p95.toFixed(1)} ms, worst ${r.worst.toFixed(0)} ms,` +
    ` ${r.decodes} decodes, ${r.uploadMs.toFixed(0)} ms uploading`,
);
report(r.slow <= SLOW_FRAMES, `${r.slow} frames over 25 ms, at most ${SLOW_FRAMES}`);
report(r.worstUpload <= WORST_UPLOAD_MS, `worst upload ${r.worstUpload.toFixed(0)} ms, at most ${WORST_UPLOAD_MS}`);

await browser.close();
console.log(failures === 0 ? '\nmoving over pictures is smooth' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
