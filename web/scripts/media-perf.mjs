// What the pictures cost, in frames and in decodes.
//
// The cache is about memory, and memory it keeps: 37 MB worst case, measured
// by media-check. What that number does not say is what the machine does to
// arrive there. A picture costs a full decode of its source whatever level
// comes out of it, so a project of renders is tens of megapixels of PNG going
// through the main thread, and the frame loop is what pays for it.
//
// So this measures three things on a repository full of pictures:
//
//   the first ten seconds   long tasks while the project opens, which is what
//                           a dropped frame is made of
//   a zoom sweep            the app's own bench, with the pictures on and then
//                           with the cache detached, so the difference is the
//                           pictures rather than the repository
//   decodes                 how often a source was decoded, and how many bytes
//                           went through it, over the whole run
//
// Not a pass/fail check: it prints numbers to compare a change against.

import { base, launch, settled } from './browser.mjs';

const repo = process.env.SANITY_DEMO ?? 'pathsim';
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log(`[error] ${e.message}`));

// Long tasks: anything holding the main thread past 50 ms, which is what a
// user feels as the window not answering.
await page.addInitScript(() => {
  window.__long = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__long.push(Math.round(e.duration));
  }).observe({ entryTypes: ['longtask'] });
});

const t0 = Date.now();
await page.goto(`${base}/?demo=${repo}`, { waitUntil: 'load' });
const ok = await page
  .waitForFunction(
    () => {
      const t = document.querySelector('footer')?.textContent ?? '';
      return t.length > 0 && t.includes('files') && !t.includes('indexing');
    },
    null,
    { timeout: 60000 },
  )
  .then(() => true)
  .catch(() => false);
if (!ok) {
  console.log('no demo in this build, run `npm run demo` first: skipped');
  await browser.close();
  process.exit(0);
}
const ready = Date.now() - t0;
await settled(page);
// The pictures keep arriving after the layout is up, and that is the part
// being measured, so the window is fixed rather than waiting for quiet.
await page.waitForTimeout(10000 - Math.min(9000, Date.now() - t0));

const opening = await page.evaluate(() => ({
  long: window.__long.slice(),
  media: window.__sanity.app.scene.media?.stats() ?? null,
  pictures: [...window.__sanity.app.scene.files.values()].filter((f) => f.node.media).length,
}));
if (!opening.media || opening.pictures === 0) {
  console.log(`${repo} has no pictures in it, nothing to measure`);
  await browser.close();
  process.exit(0);
}
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
console.log(
  `${repo}: ${opening.pictures} pictures, canvas up after ${ready} ms\n` +
    `opening   ${opening.long.length} long tasks, ${sum(opening.long)} ms held in total, ` +
    `worst ${Math.max(0, ...opening.long)} ms`,
);
const cost = (m) =>
  `${m.decodes} decodes, ${(m.fetched / 1048576).toFixed(1)} MB read, ` +
  `${Math.round(m.decodeMs)} ms decoding (worst ${m.worstDecode.toFixed(0)}), ` +
  `${Math.round(m.uploadMs)} ms uploading (worst ${m.worstUpload.toFixed(0)}), ` +
  `${(m.bytes / 1048576).toFixed(1)} MB held`;
console.log(`opened    ${cost(opening.media)}`);

/** The app's own zoom sweep, which pans and zooms across the whole project. */
const sweep = async () => {
  const line = await page.evaluate(() => window.__sanity.bench(8));
  const after = await page.evaluate(() => window.__sanity.app.scene.media?.stats() ?? null);
  return { line, after };
};

const withPictures = await sweep();
console.log(`pictures  ${withPictures.line.replace('bench over ', '')}`);
const swept = withPictures.after;
console.log(`swept     ${cost(swept)} (running totals)`);

// The same sweep with the cache detached: the panels keep their placeholders,
// everything else about the scene is identical, so the difference between the
// two lines is what the pictures cost to draw.
await page.evaluate(() => {
  const scene = window.__sanity.app.scene;
  scene.media.dispose();
  scene.media = null;
  window.__sanity.app.invalidate();
});
const without = await page.evaluate(() => window.__sanity.bench(8));
console.log(`without   ${without.replace('bench over ', '')}`);

await browser.close();
