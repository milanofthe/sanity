// Asserts that the website works on a phone.
//
// One finger panned from the start, since touches arrive as pointer events;
// two did nothing, and the toolbar and its menus were wider than the screen.
// Checked in a phone's viewport with touch, the gestures sent as the browser
// sends them:
//
//   one finger    pans, by as much as the finger moved
//   two fingers   zoom about their middle, by as much as their distance
//                 changed
//   double tap    fits, as a double click does
//   the chrome    one menu button instead of four, and nothing on the page,
//                 the open menu included, wider than the screen
import { base, launch } from './browser.mjs';
import { devices } from 'playwright';

const browser = await launch();
const context = await browser.newContext({ ...devices['iPhone 13'] });
const page = await context.newPage();
page.on('pageerror', (e) => console.log(`[error] ${e.message}`));
await page.goto(`${base}/?demo=pathsim`, { waitUntil: 'load' });
await page.waitForFunction(() => (document.querySelector('footer')?.textContent ?? '').includes('files'), null, { timeout: 60000 });
await page.waitForFunction(() => window.__sanity?.app?.settling?.() === false, null, { timeout: 30000 });

let failed = false;
const expect = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!ok) failed = true;
};

const cdp = await context.newCDPSession(page);
const touch = (type, points) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map(([x, y], id) => ({ x, y, id })),
  });
const cam = () => page.evaluate(() => {
  const c = window.__sanity.app.cam;
  return { x: c.x, y: c.y, zoom: c.zoom };
});
const settle = () => page.waitForTimeout(250);

// One finger, 80 by 50 pixels.
let a = await cam();
await touch('touchStart', [[200, 400]]);
for (let i = 1; i <= 10; i++) await touch('touchMove', [[200 + i * 8, 400 + i * 5]]);
await touch('touchEnd', []);
await settle();
let b = await cam();
const moved = [(a.x - b.x) * b.zoom, (a.y - b.y) * b.zoom];
expect(Math.abs(moved[0] - 80) < 2 && Math.abs(moved[1] - 50) < 2, `one finger pans with it (${moved.map((v) => v.toFixed(0)).join(' by ')})`);

// Two fingers from 40 to 200 pixels apart: five times the zoom.
a = await cam();
await touch('touchStart', [[180, 400], [220, 400]]);
for (let i = 1; i <= 10; i++) await touch('touchMove', [[180 - i * 8, 400], [220 + i * 8, 400]]);
await touch('touchEnd', []);
await settle();
b = await cam();
const ratio = b.zoom / a.zoom;
expect(Math.abs(ratio - 5) < 0.25, `two fingers zoom by their spread (${ratio.toFixed(2)} times)`);
// About their middle: the world point under it stays under it.
const under = (c, sx) => c.x + (sx - 390 / 2) / c.zoom;
expect(Math.abs((under(a, 200) - under(b, 200)) * b.zoom) < 2, 'and about their middle');

// A double tap over the background fits the project.
await page.evaluate(() => window.__sanity.zoomTo(0.2));
await settle();
const layout = await page.evaluate(() => {
  const { cam, layout } = window.__sanity.app;
  const f = cam.fitFor(...layout.bounds);
  return { zoom: f.zoom };
});
// A point outside the project: far to the left of it.
const bg = await page.evaluate(() => {
  const { cam, layout } = window.__sanity.app;
  cam.x = layout.bounds[0] - cam.vw / cam.zoom / 4;
  window.__sanity.app.invalidate();
  return [cam.vw / 8, cam.vh / 2];
});
await settle();
for (let i = 0; i < 2; i++) {
  await touch('touchStart', [bg]);
  await touch('touchEnd', []);
  await page.waitForTimeout(80);
}
await page.waitForTimeout(900);
b = await cam();
expect(Math.abs(b.zoom / layout.zoom - 1) < 0.01, `a double tap on the background fits the project (${b.zoom.toFixed(4)} of ${layout.zoom.toFixed(4)})`);

// The chrome.
const triggers = await page.locator('header .trigger').allTextContents();
expect(triggers.length === 1 && triggers[0].trim() === 'Menu', `one menu button (${triggers.map((t) => t.trim()).join(', ')})`);
await page.getByRole('button', { name: 'Menu', exact: true }).tap();
await page.waitForTimeout(300);
const wide = await page.evaluate(() => {
  const w = innerWidth;
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.right > w + 1 || r.left < -1)) out.push(`${el.tagName.toLowerCase()}.${el.className}`);
  }
  return out;
});
expect(wide.length === 0, `nothing wider than the screen with the menu open${wide.length ? ` (${wide.slice(0, 3).join(', ')})` : ''}`);
const sections = (await page.locator('.sheet .title').allTextContents()).map((t) => t.trim()).filter(Boolean);
expect(['Files', 'Theme'].every((t) => sections.some((s) => s.toLowerCase() === t.toLowerCase())), `the menu holds Files and Theme too (${sections.join(', ')})`);

await browser.close();
if (failed) process.exit(1);
console.log('\nthe website works on a phone');
