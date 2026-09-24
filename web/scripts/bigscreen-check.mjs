// Asserts that pictures hold still on a large screen.
//
// At rest every picture on screen is made for exactly the pixels it covers.
// On a 5K screen with sixteen of them in view that came to more than the
// fixed 64 MB the pictures had, the ones on screen were thrown out to make
// room for themselves, asked for again at once, and the pictures flickered
// for as long as the view held still: 70 drops in half a second, the pictures
// drawn going between 16 and 4. The budget follows the screen now.
//
// So: 2560 by 1440 at twice the density, the widest picture fitted, and once
// the pictures have arrived, a few seconds at rest in which nothing on screen
// is dropped and the same pictures are drawn in every frame.
import { base, launch, settled } from './browser.mjs';

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log(`[error] ${e.message}`));
await page.goto(`${base}/?demo=pathsim`, { waitUntil: 'load' });
await page.waitForFunction(() => (document.querySelector('footer')?.textContent ?? '').includes('files'), null, { timeout: 60000 });
await settled(page);

const r = await page.evaluate(async () => {
  const app = window.__sanity.app;
  const s = app.scene;
  const m = s.media;
  const f = app.layout.files.filter((x) => x.media).sort((a, b) => b.w * b.h - a.w * a.h)[0];
  app.cam.stop();
  app.cam.x = f.x + f.w / 2;
  app.cam.y = f.y + f.h / 2;
  app.cam.zoom = Math.min(app.cam.vw / f.w, app.cam.vh / f.h);
  app.invalidate();
  // Until the pictures for this view have arrived.
  for (let i = 0; i < 300 && (i < 30 || m.stats().loading > 0); i++) {
    app.invalidate();
    await new Promise((q) => requestAnimationFrame(q));
  }
  let drops = 0;
  const drop = m.drop.bind(m);
  m.drop = (p, slot) => {
    drops++;
    drop(p, slot);
  };
  const drawn = new Set();
  const render = s.render.bind(s);
  s.render = (cam, dt) => {
    render(cam, dt);
    drawn.add(s.imageDraws.length);
  };
  const t0 = performance.now();
  while (performance.now() - t0 < 3000) {
    app.invalidate();
    await new Promise((q) => requestAnimationFrame(q));
  }
  s.render = render;
  m.drop = drop;
  return { drops, drawn: [...drawn], held: m.stats().bytes, budget: typeof m.budget === 'function' ? m.budget() : m.budget };
});

console.log(`3 s at rest: ${r.drops} dropped, pictures drawn per frame ${r.drawn.join(', ')}, ${(r.held / 1e6).toFixed(0)} of ${(r.budget / 1e6).toFixed(0)} MB`);
await browser.close();
let failed = false;
if (r.drops > 0) {
  console.log(`FAIL pictures were dropped while the view held still`);
  failed = true;
}
if (r.drawn.length !== 1 || r.drawn[0] === 0) {
  console.log(`FAIL the pictures drawn changed from frame to frame`);
  failed = true;
}
if (failed) process.exit(1);
console.log('pictures hold still on a large screen');
