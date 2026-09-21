// Asserts that at the outermost zoom a file's colour says what language it is,
// and that saying so does not cost the structure the texture was drawing.
//
// The reason this exists: at 0.22 pixels per line a panel is a few pixels
// tall and the texture is nothing but a grey smear. Measured before building
// anything, on 988 files: the luminance varies by 0.106 *within* a panel and
// by 0.032 *between* panels, and at one pixel per line by 0.167 against 0.041.
// So the texture carries the shape of the code, which is worth keeping, and
// says little about which file it is, which is worth adding.
//
// Hence the tint rather than a flat quad per file: the language's hue applied
// at each texel's own luminance. Both halves of that need a check. The hue has
// to actually separate the families, and the luminance has to survive, because
// re-tinting at the wrong luminance would flatten the texture and give up the
// structure for the identity instead of getting both.
//
// What gets measured is chroma and not plain RGB distance. Two things move a
// panel's mean colour: how dense its code is, which is brightness, and what
// language it is, which is hue. Untinted, the mean RGB distance between panels
// of different languages already measures 0.097, and every bit of that is
// density: a header file and a test file are different shades of the same
// grey. So the measure has to divide the brightness out, or the check passes on
// a difference that says nothing about the language.
//
// And the question is then not "did the distance grow" but "does the colour
// predict the language", so it is the between-family distance against the
// within-family distance. One means colour carries no information about which
// family a panel belongs to, which is exactly the state the tint is there to
// fix.

import { decodePng } from './png.mjs';
import { base, canvasBox, frameOnScreen, launch, settled, src } from './browser.mjs';

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
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

/** Panels on screen, big enough to sample inside, with their family.
 *
 *  In device pixels of the screenshot, so the canvas origin is added: without
 *  it every window is displaced by the height of the toolbar, which at this
 *  zoom is several panels, and the measurement compares files to the wrong
 *  files. Inset by two pixels so a panel's own border is not in its sample. */
const box = await canvasBox(page);
const rects = await page.evaluate(
  ([bx, by]) => {
    const app = window.__sanity.app;
    app.fit(0);
    app.invalidate();
    const out = [];
    const dpr = app.cam.dpr;
    for (const f of app.scene.files.values()) {
      if (f.node.stub) continue;
      const [sx, sy] = app.cam.worldToScreen(f.node.x, f.node.y);
      const w = f.node.w * app.cam.zoom;
      const h = f.node.h * app.cam.zoom;
      if (w < 14 || h < 14) continue;
      if (sx < 0 || sy < 0 || sx + w > app.cam.vw || sy + h > app.cam.vh) continue;
      out.push({
        family: f.family,
        x: Math.round((bx + sx) * dpr) + 2,
        y: Math.round((by + sy) * dpr) + 2,
        w: Math.round(w * dpr) - 4,
        h: Math.round(h * dpr) - 4,
      });
    }
    return out;
  },
  [box.x, box.y],
);
await settled(page);

/** Mean colour and luminance spread of every panel, per family. */
function sample(png) {
  const { width, data } = decodePng(png);
  const panels = [];
  for (const r of rects) {
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let sl = 0;
    let sll = 0;
    let n = 0;
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const o = (y * width + x) * 4;
        const cr = data[o] / 255;
        const cg = data[o + 1] / 255;
        const cb = data[o + 2] / 255;
        const l = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
        sr += cr;
        sg += cg;
        sb += cb;
        sl += l;
        sll += l * l;
        n++;
      }
    }
    if (n < 40) continue;
    const mean = sl / n;
    const rgb = [sr / n, sg / n, sb / n];
    // The mean colour at unit luminance: what is left once density is out of
    // it. The shader tints the same way, applying the family hue at each
    // texel's own luminance, so this is the axis the pass actually writes on.
    const k = 1 / Math.max(1e-4, mean);
    panels.push({
      family: r.family,
      chroma: [rgb[0] * k, rgb[1] * k, rgb[2] * k],
      lum: mean,
      // Within-panel luminance spread: the structure the texture is drawing.
      sd: Math.sqrt(Math.max(0, sll / n - mean * mean)),
    });
  }
  return panels;
}

/** Mean chroma distance between panels of different families, and between
 *  panels of the same family, over every pair on screen. */
function separation(panels) {
  let between = 0;
  let nb = 0;
  let within = 0;
  let nw = 0;
  for (let i = 0; i < panels.length; i++) {
    for (let j = i + 1; j < panels.length; j++) {
      const a = panels[i].chroma;
      const b = panels[j].chroma;
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (panels[i].family === panels[j].family) {
        within += d;
        nw++;
      } else {
        between += d;
        nb++;
      }
    }
  }
  return {
    between: between / Math.max(1, nb),
    within: within / Math.max(1, nw),
    pairs: nb,
    samePairs: nw,
  };
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

const runs = {};
for (const on of [false, true]) {
  await page.evaluate((v) => (window.__sanity.app.scene.tintLanguages = v), on);
  await frameOnScreen(page);
  const panels = sample(await page.screenshot({ type: 'png' }));
  const sep = separation(panels);
  runs[on ? 'tinted' : 'plain'] = {
    panels: panels.length,
    families: new Set(panels.map((p) => p.family)).size,
    ...sep,
    ratio: sep.between / Math.max(1e-6, sep.within),
    structure: mean(panels.map((p) => p.sd)),
    lum: mean(panels.map((p) => p.lum)),
  };
}

for (const [name, r] of Object.entries(runs)) {
  console.log(
    `${name.padEnd(6)}  ${r.panels} panels in ${r.families} families  chroma: ` +
      `${r.between.toFixed(4)} between families, ${r.within.toFixed(4)} within one, ` +
      `ratio ${r.ratio.toFixed(2)}  within-panel structure ${r.structure.toFixed(4)}  ` +
      `mean luminance ${r.lum.toFixed(4)}`,
  );
}

let failures = 0;
const { plain, tinted } = runs;

if (plain.families < 3 || plain.pairs < 20 || plain.samePairs < 20) {
  console.log(
    `FAIL  only ${plain.families} families over ${plain.pairs} pairs on screen: ` +
      'there is nothing here to tell apart',
  );
  failures++;
} else {
  console.log(`ok    ${plain.pairs} cross-family pairs from ${plain.families} families to compare`);
}

// The bar is a statement about the picture rather than a tuned number: a
// family has to sit further from another family than its own members sit from
// each other, by enough that the regions read as regions.
//
// Untinted the measurement is not 1.00 but about 1.9, which is not noise.
// Syntax highlighting leaks a little of the language even at this distance,
// since a JSON file is mostly string colour and a Markdown file mostly plain
// text. It is still only just outside a family's own spread, which is the
// definition of not telling them apart, and it is what the screenshots showed:
// one grey field. So the pass has to beat that baseline by a multiple rather
// than clear a fixed number, and the absolute floor is there for the case
// where the baseline itself collapses.
const BAR = 4;
const GAIN = 2.5;
if (tinted.ratio < BAR) {
  console.log(
    `FAIL  tinted ratio is only ${tinted.ratio.toFixed(2)}: the families do not separate`,
  );
  failures++;
} else if (tinted.ratio < GAIN * plain.ratio) {
  console.log(
    `FAIL  tinted ratio ${tinted.ratio.toFixed(2)} is less than ${GAIN} times the ` +
      `untinted ${plain.ratio.toFixed(2)}: the tint adds little to what highlighting leaks`,
  );
  failures++;
} else {
  console.log(
    `ok    tinted ratio ${tinted.ratio.toFixed(2)}, up from ${plain.ratio.toFixed(2)}: ` +
      'a panel\'s colour says which family it is',
  );
}

// The other half: the texture still has to be a picture of the code. The tint
// puts each family's hue at the texel's own luminance, so the within-panel
// spread should come through near enough unchanged. A drop here is the failure
// mode worth guarding, since it is what a flat quad per file would have done.
const kept = tinted.structure / Math.max(1e-6, plain.structure);
if (kept < 0.8) {
  console.log(
    `FAIL  within-panel structure fell to ${(kept * 100).toFixed(0)} percent ` +
      `(${plain.structure.toFixed(4)} to ${tinted.structure.toFixed(4)}): the tint is flattening the texture`,
  );
  failures++;
} else {
  console.log(`ok    ${(kept * 100).toFixed(0)} percent of the within-panel structure survives the tint`);
}

// And it must not change how bright the canvas is overall, which is the thing
// that made the earlier token-bar palette read as a flash at the hand-over.
const step = Math.abs(tinted.lum - plain.lum);
if (step > 0.03) {
  console.log(
    `FAIL  mean luminance moves by ${step.toFixed(4)} ` +
      `(${plain.lum.toFixed(4)} to ${tinted.lum.toFixed(4)}): the tint changes the exposure`,
  );
  failures++;
} else {
  console.log(`ok    mean luminance moves by ${step.toFixed(4)}, so the canvas keeps its exposure`);
}

// Every theme, because the colours are the theme's own data hues and how well
// they separate is a property of the palette rather than of the pass. sanity's
// own is red, white and charcoal: three of its six data colours are the same
// grey hue at three luminances, and the tint normalises luminance away, so
// three families land on top of each other there. That is the price of a
// two-hue palette and it is worth having in the output rather than in a
// comment, so a theme that collapses further is visible as a number.
console.log('');
for (const theme of ['sanity', 'mariana', 'monokai', 'breakers']) {
  await page.evaluate((t) => {
    document.documentElement.setAttribute('data-theme', t);
    window.__sanity.app.refreshTheme();
  }, theme);
  await settled(page);
  await frameOnScreen(page);
  const panels = sample(await page.screenshot({ type: 'png' }));
  const sep = separation(panels);
  const ratio = sep.between / Math.max(1e-6, sep.within);

  // How many family pairs are closer than a fifth of the spread the untinted
  // canvas already had, which is the threshold below which two regions read
  // as one.
  const byFamily = new Map();
  for (const p of panels) {
    if (!byFamily.has(p.family)) byFamily.set(p.family, []);
    byFamily.get(p.family).push(p.chroma);
  }
  const means = [...byFamily.entries()].map(([f, cs]) => [
    f,
    [0, 1, 2].map((i) => cs.reduce((a, c) => a + c[i], 0) / cs.length),
  ]);
  let close = 0;
  let pairs = 0;
  for (let i = 0; i < means.length; i++) {
    for (let j = i + 1; j < means.length; j++) {
      const [a, b] = [means[i][1], means[j][1]];
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.05) close++;
      pairs++;
    }
  }
  const verdict = ratio >= BAR ? 'ok  ' : 'FAIL';
  if (ratio < BAR) failures++;
  console.log(
    `${verdict}  ${theme.padEnd(8)} ratio ${ratio.toFixed(2)}, ` +
      `${close} of ${pairs} family pairs closer than 0.05`,
  );
}

await browser.close();
console.log(failures === 0 ? '\nthe overview says what language it is' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
