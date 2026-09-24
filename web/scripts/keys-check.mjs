// Asserts what the keyboard shortcuts do, and where they do nothing.
//
//   Space and f   fit the whole project, even with a toolbar button focused,
//                 which a click leaves behind and which space would otherwise
//                 press again
//   left, right   older and newer through the history, as the ticker's
//                 arrows are laid out; [ and ] too
//   in the search field none of them: space is a space and the arrows move
//                 the caret
//   with Cmd      nothing, since Cmd and an arrow is the system's
//
// The history is only there in the desktop app, so it is given four commits
// here, and `at` is made to follow `target`: without a scan a step returns at
// once, and what is being checked is where the keys send the ticker, not the
// step itself.
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

const cam = () => page.evaluate(() => {
  const c = window.__sanity.app.cam;
  return { x: c.x, y: c.y, zoom: c.zoom };
});
const same = (a, b) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6
  && Math.abs(a.zoom - b.zoom) < 1e-9;
const fitted = await cam();

// Space with the Project button focused.
await page.evaluate(() => window.__sanity.zoomTo(0.5));
await page.locator('header button').first().click();
await page.keyboard.press('Escape');
await page.keyboard.press(' ');
await page.waitForFunction(() => !window.__sanity.app.cam.flying, null, { timeout: 5000 });
expect(same(await cam(), fitted), 'space fits the project with a toolbar button focused');
expect(await page.evaluate(() => document.querySelectorAll('[role=menu]').length === 0), 'and does not press the button again');

// f.
await page.evaluate(() => window.__sanity.zoomTo(0.5));
await page.keyboard.press('f');
await page.waitForFunction(() => !window.__sanity.app.cam.flying, null, { timeout: 5000 });
expect(same(await cam(), fitted), 'f fits the project');

// The history.
await page.evaluate(async () => {
  const url = performance.getEntriesByType('resource').map((e) => e.name)
    .find((n) => n.includes('state/history.svelte'));
  const { history } = await import(url);
  window.__history = history;
  history.commits = [1, 2, 3, 4].map((i) => ({
    sha: `c${i}000000`, subject: `commit ${i}`, author: 'someone', time: 0,
  }));
  Object.defineProperty(history, 'at', { get() { return this.target; }, set() {} });
});
const target = () => page.evaluate(() => window.__history.target);
await page.mouse.click(500, 400);
await page.keyboard.press('ArrowLeft');
expect((await target()) === 0, 'the left arrow steps to an older commit');
await page.keyboard.press('[');
expect((await target()) === 1, '[ steps to an older one too');
await page.keyboard.press('ArrowRight');
expect((await target()) === 0, 'the right arrow steps to a newer one');
await page.keyboard.press(']');
await page.keyboard.press(']');
expect((await target()) === -1, 'and ] as well, stopping at the present');
await page.keyboard.press('Meta+ArrowLeft');
expect((await target()) === -1, 'Cmd and an arrow is left to the system');

// The search field.
const before = await cam();
await page.keyboard.press('/');
await page.keyboard.type('a b');
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('f');
await page.waitForTimeout(300);
expect((await target()) === -1, 'an arrow in the search field does not step');
expect(same(await cam(), before), 'space and f in the search field do not fit');
expect(
  (await page.evaluate(() => document.activeElement?.value)) === 'a fb',
  'they are typed and move the caret instead',
);

await browser.close();
if (failed) process.exit(1);
console.log('\nthe shortcuts do what they say');
