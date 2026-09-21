// Asserts that no character of source text has nowhere to go.
//
// Panels used to clip: a column was as wide as it was and anything past it was
// dropped. Measured on a real repository that cut 18 percent of the lines and
// 19 percent of the characters, and what it cut was the ends of the longest
// lines, which is where the arguments, the conditions and the types are.
//
// Lines wrap now, which trades width for height, and the failure mode moves:
// instead of a line losing its tail, a panel can come out too short for its
// own wrapped rows. This checks both, on whatever the page is showing, since
// the real repositories are what exposed it.

import { launch } from './browser.mjs';

const base = process.env.SANITY_URL ?? 'http://localhost:5183';
const src = process.env.SANITY_SRC ?? 'fixture=fixture';

const browser = await launch();
const page = await browser.newPage();
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
await page.waitForTimeout(1200);

const stats = await page.evaluate(() => {
  const scene = window.__sanity.app.scene;
  let panels = 0;
  let lines = 0;
  let wrapped = 0;
  let chars = 0;
  let lost = 0;
  let overflowing = 0;

  for (const f of scene.files.values()) {
    if (f.node.stub) continue;
    panels++;
    const g = f.node.geom;
    const capacity = g.columns * g.linesPerColumn;
    if (f.rows[f.data.lineCount] > capacity) overflowing++;
    for (let i = 0; i < f.data.lineCount; i++) {
      const width = f.data.lineCols[i];
      lines++;
      chars += width;
      if (Math.ceil(width / g.cols) > 1) wrapped++;
      // A line whose first row is past the panel's capacity is not drawn.
      if (f.rows[i] >= capacity) lost += width;
    }
  }
  return { panels, lines, wrapped, chars, lost, overflowing };
});

const wrappedPct = ((stats.wrapped / stats.lines) * 100).toFixed(2);
const lostPct = ((stats.lost / stats.chars) * 100).toFixed(4);
console.log(
  `${stats.panels} panels, ${stats.lines.toLocaleString('en-US')} lines, ` +
  `${wrappedPct}% wrapped`,
);
console.log(`characters with nowhere to go: ${lostPct}% (${stats.lost})`);

let failures = 0;
if (stats.overflowing !== 0) {
  console.log(`FAIL  ${stats.overflowing} panels are too short for their wrapped rows`);
  failures++;
} else {
  console.log('ok    every panel holds all of its rows');
}
if (stats.lost !== 0) {
  console.log(`FAIL  ${lostPct}% of characters are not drawn anywhere`);
  failures++;
} else {
  console.log('ok    no text is lost');
}
// A run that wrapped nothing proves nothing about wrapping.
if (stats.wrapped === 0) {
  console.log('FAIL  nothing wrapped, so this run tested nothing');
  failures++;
}

await browser.close();
console.log(failures === 0 ? '\nall source text has a row' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
