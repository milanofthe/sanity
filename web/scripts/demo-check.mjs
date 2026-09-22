// Asserts that the web demo opens, switches and can be linked to.
//
// The demo is the only configuration that runs without a backend: no folder,
// no watcher, the text arriving after the structure. That last part is what
// this exists for. Making texts.json a background fetch is what takes the
// first picture of pathsim from 8.9 to 1.8 megabytes, and the failure mode is
// silent, a canvas that looks finished and draws no characters, so the check
// waits for the text and counts the glyphs afterwards.
//
// Skips rather than fails when web/public/demo is not there: the dumps are
// generated, `npm run demo` writes them, and a working tree without them is
// the normal state of this repository.

import { frameOnScreen, launch, settled } from './browser.mjs';

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log(`[error] ${e.message}`));

const index = await page
  .goto('http://localhost:5183/demo/index.json')
  .then((r) => r.json())
  .catch(() => null);
if (!Array.isArray(index) || index.length === 0) {
  console.log('no demo in this build, run `npm run demo` first: skipped');
  await browser.close();
  process.exit(0);
}

let failures = 0;
const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  failures++;
};

const t0 = Date.now();
await page.goto('http://localhost:5183/', { waitUntil: 'load' });
await page.waitForFunction(
  () => (document.querySelector('footer')?.textContent ?? '').includes('files'),
  null,
  { timeout: 120000 },
);
const structure = Date.now() - t0;
const opened = await page.evaluate(() => location.search);
await settled(page);

// The text has to be in by now, since `settled` waits on the source, and a
// panel at a readable zoom has to have characters in it.
const path = await page.evaluate(() => {
  const app = window.__sanity.app;
  const f = [...app.scene.files.values()].find((x) => !x.node.stub && x.data.lineCount > 40);
  // The camera is placed rather than flown: focusFile animates, and two
  // frames later it is still on its way, which reads as a canvas with no
  // text on it.
  const rect = app.scene.lineRect(f.node.path, 3);
  app.cam.zoom = 15 / 14;
  app.cam.x = rect[0] + 200;
  app.cam.y = rect[1];
  app.invalidate();
  return f.node.path;
});
await settled(page);
await frameOnScreen(page);
const glyphs = await page.evaluate(() => ({
  count: window.__sanity.app.scene.glyphs.count,
}));
glyphs.path = path;

console.log(
  `${index.length} repositories · ${opened} in ${structure} ms · ` +
    `${glyphs.count} glyphs on ${glyphs.path}`,
);
if (!opened.includes('demo=')) fail('opening the demo left no repository in the address bar');
if (glyphs.count < 500) fail(`only ${glyphs.count} glyphs drawn, so the text never arrived`);

// Every repository in the index opens, which is the one thing a stale index
// or a half-written dump breaks.
for (const r of index) {
  await page.goto(`http://localhost:5183/?demo=${r.id}`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => (document.querySelector('footer')?.textContent ?? '').includes('files'),
    null,
    { timeout: 120000 },
  );
  await settled(page);
  const got = await page.evaluate(() => ({
    files: window.__sanity.app.scene.files.size,
    demo: document.querySelector('.badge')?.textContent ?? '',
  }));
  console.log(`${r.id.padEnd(10)} ${got.files} files of ${r.files}, badge "${got.demo}"`);
  if (got.files === 0) fail(`${r.id} opened with nothing in it`);
  if (got.demo !== 'demo') fail(`${r.id} does not say it is a demo`);
}

await browser.close();
console.log(failures === 0 ? '\nthe demo opens every repository' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
