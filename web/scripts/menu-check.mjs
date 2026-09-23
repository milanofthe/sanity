// Asserts that every dropdown lays out cleanly.
//
// The failure this exists for: menu rows that size themselves to their content
// came out 10 and 24 pixels tall in the same menu, and the taller labels
// overflowed their own buttons and drew on top of the next row. It looked like
// a rendering bug and was a CSS height bug, so it is worth a check that says
// which of the two it is.

import { launch, settled } from './browser.mjs';

const base = process.env.SANITY_URL ?? 'http://localhost:5183';
const browser = await launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`[error] ${e.message}`));
await page.goto(`${base}/?files=60&lines=80`, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__sanity), null, { timeout: 60000 });
await settled(page);
await page.waitForTimeout(800);

let failures = 0;
for (const menu of ['Project', 'View', 'Theme']) {
  await page.getByRole('button', { name: new RegExp(`^${menu}`) }).click();
  await page.waitForTimeout(250);
  const r = await page.evaluate(() => {
    const sheet = document.querySelector('.sheet');
    if (!sheet) return { err: 'no sheet' };
    // Rows, and the cells of a grid, which sit next to each other as well as
    // under: overlap is a question about rectangles, not about one bottom
    // passing the next top.
    const rows = [...sheet.querySelectorAll('.item, .row, .cell')];
    const sr = sheet.getBoundingClientRect();
    const boxes = rows.map((el) => el.getBoundingClientRect());
    let overlaps = 0;
    let spills = 0;
    let escaped = 0;
    for (let i = 0; i < rows.length; i++) {
      // Content taller than its own row: the label will draw over a neighbour.
      if (rows[i].scrollHeight > Math.ceil(boxes[i].height) + 1) spills++;
      for (let j = i + 1; j < rows.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) overlaps++;
      }
      // Contents outside their own row. Checking the rows alone missed the
      // real bug once: the buttons stacked correctly while every label inside
      // them was positioned at the top of the sheet by a stray global rule.
      for (const child of rows[i].querySelectorAll('*')) {
        const cb = child.getBoundingClientRect();
        if (cb.width === 0 && cb.height === 0) continue;
        if (cb.top < boxes[i].top - 1 || cb.bottom > boxes[i].bottom + 1) {
          escaped++;
          break;
        }
      }
    }
    const inside = boxes.every((b) => b.top >= sr.top - 0.5 && b.bottom <= sr.bottom + 0.5);
    const heights = [...new Set(boxes.map((b) => Math.round(b.height)))];
    return { rows: rows.length, heights, overlaps, spills, escaped, inside };
  });
  const problems = [];
  if (r.err) problems.push(r.err);
  if (r.overlaps) problems.push(`overlaps=${r.overlaps}`);
  if (r.spills) problems.push(`content spills=${r.spills}`);
  if (r.escaped) problems.push(`contents outside their row=${r.escaped}`);
  if (r.inside === false) problems.push('rows outside the sheet');
  if (r.heights && r.heights.length > 1) problems.push(`uneven rows ${r.heights.join('/')}`);
  if (problems.length) failures++;
  console.log(
    `${problems.length ? 'FAIL' : 'ok  '} ${menu.padEnd(8)} ${JSON.stringify(r)}` +
    (problems.length ? `  ${problems.join(' ')}` : ''),
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
}

await browser.close();
console.log(failures === 0 ? '\nall menus lay out cleanly' : `\n${failures} menu(s) broken`);
process.exit(failures === 0 ? 0 : 1);
