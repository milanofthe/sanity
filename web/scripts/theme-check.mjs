// Asserts that every theme is complete, legible, and its own.
//
// Worth a check because a theme is a block of about forty custom properties
// and a missing one does not fail: it falls back to the value in `:root`,
// which is Mariana. A Gruvbox with Mariana's string colour in it looks almost
// right and is wrong, and nobody would notice from a screenshot of one theme.
//
// Three properties, per theme:
//
//   complete   every colour the renderer reads resolves to something, and to
//              something other than the Mariana default unless the theme
//              means it. Checked as "how many of the palette's colours differ
//              from Mariana's", which is high for a real theme and zero for a
//              theme that forgot its block.
//   legible    the text has real contrast against the panel it sits on, and
//              the panel against the canvas behind it. A theme that fails
//              this is unusable rather than merely ugly.
//   distinct   the canvas actually looks different from the theme before it.
//              This is the one that catches a theme wired up in the list and
//              never given a block.

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
// A zoom where panels, their headers and their code are all on screen, so a
// theme's token colours are part of the picture being compared.
await page.evaluate(() => window.__sanity.zoomTo(5 / 14));
await settled(page);

let failures = 0;
const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  failures++;
};

const themes = await page.evaluate(() =>
  window.__sanity.app ? [...document.querySelectorAll('[data-theme]')].length : 0,
);
const list = await page.evaluate(async () => {
  const { THEMES } = await import('/src/lib/theme.ts');
  return THEMES.map((t) => ({ id: t.id, label: t.label }));
});
console.log(`${list.length} themes: ${list.map((t) => t.id).join(', ')}${themes ? '' : ''}`);

/** Relative luminance of a 0xRRGGBB integer. */
const lum = (hex) => {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const apply = async (id) => {
  await page.evaluate((t) => {
    document.documentElement.setAttribute('data-theme', t);
    window.__sanity.app.refreshTheme();
  }, id);
  await settled(page);
  await frameOnScreen(page);
  return {
    shot: await page.screenshot({ type: 'png' }),
    pal: await page.evaluate(async () => {
      const { readPalette } = await import('/src/lib/theme.ts');
      const p = readPalette();
      return { token: p.token, surface: p.surface, data: p.data };
    }),
  };
};

const mariana = await apply('mariana');
let previous = null;
let previousId = '';

for (const { id, label } of list) {
  const now = id === 'mariana' ? mariana : await apply(id);
  const pal = now.pal;

  // Complete: count the colours that differ from Mariana's. Mariana itself is
  // the baseline and is skipped.
  const same =
    pal.token.filter((c, i) => c === mariana.pal.token[i]).length
    + pal.data.filter((c, i) => c === mariana.pal.data[i]).length;
  const total = pal.token.length + pal.data.length;

  // Legible: text against panel, and panel against canvas.
  const textGap = Math.abs(lum(pal.surface.panelLabel) - lum(pal.surface.panelBg));
  const panelGap = Math.abs(lum(pal.surface.panelBg) - lum(pal.surface.bg));

  const diff = previous ? pixelDiff(decodePng, previous, now.shot) : null;
  console.log(
    `${label.padEnd(9)} ${total - same}/${total} colours its own · ` +
      `text/panel ${textGap.toFixed(2)} · panel/canvas ${panelGap.toFixed(3)}` +
      (diff === null ? '' : ` · ${diff} pixels against ${previousId}`),
  );

  if (id !== 'mariana' && total - same < total / 2) {
    fail(`${label} shares ${same} of ${total} colours with Mariana, so its block is incomplete`);
  }
  if (textGap < 0.25) {
    fail(`${label} puts its panel text at ${textGap.toFixed(2)} contrast, which is unreadable`);
  }
  if (panelGap < 0.004) {
    fail(`${label} draws its panels in the canvas colour, so the layout disappears`);
  }
  if (diff !== null && diff < 20000) {
    fail(`${label} renders ${diff} pixels differently from ${previousId}, so it is not its own theme`);
  }

  previous = now.shot;
  previousId = label;
}

await browser.close();
console.log(failures === 0 ? '\nevery theme is complete and legible' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
