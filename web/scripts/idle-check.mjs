// Asserts that the renderer draws on demand rather than sixty times a second.
//
// A canvas nobody is touching has nothing to redraw. Drawing it anyway costs a
// millisecond of CPU and several thousand quads of GPU work per frame for as
// long as the window is open, which is the whole day.
//
// Four properties, and three of them are ways this goes wrong:
//
//   1. An idle canvas draws nothing.
//   2. It still shows its picture. WebGL clears the drawing buffer after every
//      composite unless `preserveDrawingBuffer` is set, so skipping a frame
//      without it turns the canvas blank.
//   3. A drag draws every frame. Driven with real pointer events rather than
//      by moving the camera from script: the loop parks itself when there is
//      nothing to draw and the input handlers are what start it again, so
//      reaching past them would test the wrong thing and pass while dragging
//      did nothing.
//   4. A decaying glow keeps time without drawing every frame. The glow fades
//      over ninety seconds and nobody is touching the mouse, so the loop has
//      to keep asking, or a fade measured in wall-clock time freezes at
//      whatever it had reached. What it must not do is draw for all of it:
//      that was 5400 frames for one save, at 0.7 milliseconds each, and an app
//      meant to sit in the background while an agent works never parked. The
//      glow is drawn in steps, so the frames are a few and the ticks are 4
//      microseconds each.

import { decodePng } from './png.mjs';
import { base, frameOnScreen, launch, pixelDiff, settled, src } from './browser.mjs';

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log(`[error] ${e.message}`));
await page.goto(`${base}/?${src}`, { waitUntil: 'load' });
await page.waitForFunction(
  () => {
    const t = document.querySelector('footer')?.textContent ?? '';
    return t.length > 0 && !t.includes('indexing');
  },
  null,
  { timeout: 180000 },
);
await settled(page);

let failures = 0;
const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  failures++;
};

const count = async (body) =>
  page.evaluate(async (src) => {
    const app = window.__sanity.app;
    app.drawn = 0;
    app.skipped = 0;
    // eslint-disable-next-line no-new-func
    await new Function('app', `return (async () => { ${src} })()`)(app);
    return { drawn: app.drawn, skipped: app.skipped };
  }, body);

const idle = await count(`
  for (let i = 0; i < 120; i++) await new Promise((r) => requestAnimationFrame(r));
`);
console.log(`idle:    ${idle.drawn} drawn, ${idle.skipped} considered and skipped`);
if (idle.drawn > 0) fail(`${idle.drawn} frames drawn at an idle canvas`);
else console.log('ok    an idle canvas draws nothing');
// And the loop parks rather than running to decide not to draw, which is the
// difference between a background process costing nothing and costing a
// callback and a composite sixty times a second.
if (idle.skipped > 4) {
  fail(`${idle.skipped} frames were still scheduled at an idle canvas`);
} else {
  console.log('ok    the loop stops instead of idling');
}

// And it still shows what it drew last.
await frameOnScreen(page);
const a = await page.screenshot({ type: 'png' });
await page.waitForTimeout(700);
const b = await page.screenshot({ type: 'png' });
const drift = pixelDiff(decodePng, a, b);
if (drift > 540) fail(`a skipped canvas lost its picture (${drift} pixels)`);
else console.log(`ok    it keeps its picture while skipping (${drift} pixels differ)`);

// A real drag across the canvas, through the handlers the app ships.
await page.evaluate(() => {
  window.__sanity.app.drawn = 0;
  window.__sanity.app.skipped = 0;
});
const box = await page.locator('canvas').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
for (let i = 0; i < 30; i++) {
  await page.mouse.move(box.x + box.width / 2 + i * 3, box.y + box.height / 2 + i);
  await page.waitForTimeout(16);
}
await page.mouse.up();
const panning = await page.evaluate(() => ({
  drawn: window.__sanity.app.drawn,
  skipped: window.__sanity.app.skipped,
}));
console.log(`drag:    ${panning.drawn} drawn over 30 pointer moves`);
if (panning.drawn < 20) fail(`a drag drew only ${panning.drawn} frames`);
else console.log('ok    a drag draws');

// A change over the window it lasts: the loop has to keep time, draw for the
// flash, and then park again. The third part is the one that matters for an
// app that sits in the background while an agent works.
const warm = await page.evaluate(async () => {
  const app = window.__sanity.app;
  const f = app.scene.files.get([...app.scene.files.keys()][0]);
  // Through `touch`, the way the watcher reports a write. Setting the clock
  // on the file directly used to work and no longer does: the scene only
  // advances files it knows have something running.
  app.scene.touch(f.node.path);
  app.invalidate();
  app.drawn = 0;
  app.skipped = 0;
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, 1500));
  const flash = { drawn: app.drawn, ticked: app.skipped };
  // Past the end of the mark window, where everything should be over.
  await new Promise((r) => setTimeout(r, 4000));
  const done = { drawn: app.drawn, ticked: app.skipped, since: f.since };
  // And then: nothing at all.
  await new Promise((r) => setTimeout(r, 1200));
  return {
    flash,
    done,
    after: { drawn: app.drawn - done.drawn, ticked: app.skipped - done.ticked },
    seconds: (performance.now() - t0) / 1000,
  };
});
console.log(
  `a change: ${warm.flash.drawn} frames drawn in the first 1.5 s, ` +
    `${warm.done.drawn} by the end of the window, ` +
    `${warm.after.drawn} drawn and ${warm.after.ticked} ticked after it`,
);

if (warm.flash.drawn < 10) {
  fail(`the flash drew ${warm.flash.drawn} frames, which is not an animation`);
} else if (warm.flash.drawn > 70) {
  fail(`the flash drew ${warm.flash.drawn} frames in 1.5 s, which is the old per-frame glow`);
} else {
  console.log(`ok    the flash is animated, ${warm.flash.drawn} frames for it`);
}
if (warm.flash.ticked + warm.flash.drawn < 30) {
  fail('the loop is not keeping time, so a fade measured in seconds would freeze');
} else {
  console.log('ok    and the loop keeps time while the marks are held');
}
if (warm.after.drawn !== 0 || warm.after.ticked !== 0) {
  fail(
    `after the window the loop still ran: ${warm.after.drawn} drawn, ` +
      `${warm.after.ticked} ticked`,
  );
} else {
  console.log('ok    and stops completely once the change is over');
}

await browser.close();
console.log(failures === 0 ? '\nthe renderer draws on demand' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
