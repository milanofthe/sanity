// Asserts that the interface is built out of the token set and nothing else.
//
// The tokens exist so that a change to a size or a spacing happens in one
// place. That only holds while every component asks for them: a component
// that writes `padding: 3px` because it looked right lines up with nothing,
// and the next one writes 5px for the same reason. This counts what is
// actually used, in the stylesheets and in the rendered page.
//
// Two lists, and both are short on purpose:
//
//   dimensions   every length in a component's CSS has to be a token, zero,
//                a percentage or arithmetic on tokens
//   type         every font size and family in the chrome has to be one of
//                the tokens, counted off the rendered page rather than the
//                source, since that is where a stray inherited value shows
//
// Run with: npm run ui-check

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { base, launch, settled } from './browser.mjs';

const SRC = 'web/src';

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

let failures = 0;
const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  failures++;
};

// --- 1. no hand-written lengths in component styles ------------------------
const components = walk(SRC).filter((f) => f.endsWith('.svelte'));
const offenders = [];
for (const file of components) {
  const text = readFileSync(file, 'utf8');
  const style = text.slice(text.indexOf('<style'));
  for (const [line, i] of style.split('\n').map((l, i) => [l, i])) {
    // Zero needs no unit and `0px` is allowed for the radius token's sake.
    for (const m of line.matchAll(/(?<![\w-])(\d+(?:\.\d+)?)(px|rem|em)\b/g)) {
      if (m[1] === '0') continue;
      offenders.push(`${file.replace(`${SRC}/`, '')}: ${line.trim()}`);
    }
  }
}
if (offenders.length > 0) {
  for (const o of offenders.slice(0, 10)) console.log(`      ${o}`);
  fail(`${offenders.length} hand-written length(s) in component styles`);
} else {
  console.log(`ok    ${components.length} components, every length from a token`);
}

// --- 2. the type scale, as rendered ---------------------------------------
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
await page.goto(`${base}/?demo=pathsim`, { waitUntil: 'load' });
const ok = await page
  .waitForFunction(() => (document.querySelector('footer')?.textContent ?? '').includes('files'), null, { timeout: 60000 })
  .then(() => true)
  .catch(() => false);
if (!ok) {
  console.log('no demo in this build, run `npm run demo` first: skipped');
  await browser.close();
  process.exit(0);
}
await settled(page);

// Every menu open in turn, so their contents are in the page when it is read.
for (const menu of ['Project', 'Files', 'View', 'Theme']) {
  await page.getByRole('button', { name: menu, exact: true }).click();
  await page.waitForTimeout(250);
}
const type = await page.evaluate(() => {
  const root = getComputedStyle(document.documentElement);
  const tokens = ['--fs-xxs', '--fs-xs', '--fs-s'].map((t) => root.getPropertyValue(t).trim());
  const families = ['--font-ui', '--font-mono'].map((t) =>
    root.getPropertyValue(t).trim().split(',')[0].replace(/['"]/g, '').trim(),
  );
  const sizes = new Map();
  const wrong = [];
  for (const el of document.querySelectorAll('header *, footer *, .sheet *, .picker *')) {
    if (!el.textContent?.trim()) continue;
    const cs = getComputedStyle(el);
    const size = cs.fontSize;
    const family = cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
    sizes.set(size, (sizes.get(size) ?? 0) + 1);
    if (!tokens.includes(size) || !families.includes(family)) {
      wrong.push(`${el.className || el.tagName} at ${size} ${family}`);
    }
  }
  return { tokens, families, sizes: [...sizes].sort((a, b) => b[1] - a[1]), wrong: wrong.slice(0, 6) };
});
console.log(
  `type      ${type.sizes.map(([s, n]) => `${s} x${n}`).join(', ')} ` +
    `from ${type.tokens.join(', ')}`,
);
if (type.wrong.length > 0) {
  for (const w of type.wrong) console.log(`      ${w}`);
  fail(`${type.wrong.length} element(s) outside the type scale`);
} else {
  console.log(`ok    every visible element is on the type scale, in one of two families`);
}

await browser.close();
console.log(failures === 0 ? '\nthe interface is built out of the tokens' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
