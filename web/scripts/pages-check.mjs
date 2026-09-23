// Expanded documents: every page of a PDF, as an option; see `pageGrid` and
// `pushPages`.
//
//   layout    a document of many pages is a grid of them near a screen's
//             proportion, in the area the layout gave it anyway.
//   asking    zoomed out, no page is asked for; with the document filling the
//             view, each page once and small; zoomed into one page, only the
//             pages in view, at the size they are shown.
//
// The web build has no PDF renderer, so a page is answered here with the
// document's first page, which the demo carries. What is checked is which
// pages are asked for and how large, not what is on them.
import { decodePng } from './png.mjs';
import { base, canvasBox, launch, settled } from './browser.mjs';

let failures = 0;
const report = (ok, text) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${text}`);
  if (!ok) failures++;
};

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
await page.goto(`${base}/?demo=nanospice`, { waitUntil: 'load' });
await page.waitForFunction(() => (document.querySelector('footer')?.textContent ?? '').includes('files'), null, { timeout: 60000 });
await settled(page);

const DOC = 'talk/slides.pdf';
const layout = await page.evaluate(async (DOC) => {
  const app = window.__sanity.app;
  const src = app.lastSource;
  app.relayout({
    ...src,
    entries: src.entries.map((e) => (e.media?.kind === 'document' ? { ...e, media: { ...e.media, expanded: true } } : e)),
  });
  // Every page asked for, recorded, and answered with the first.
  window.__asks = [];
  const media = app.scene.media;
  const fetch = media.fetchBytes;
  // At the width asked for, as the backend renders a page: a fixed-size
  // answer would be too small or too large for most asks, and the pipeline
  // would behave as it never does with the real thing.
  media.fetchBytes = async (key, level) => {
    const m = /^(.*)#page=(\d+)$/.exec(key);
    if (!m) return fetch(key, level);
    window.__asks.push({ page: Number(m[2]), level });
    const bytes = await fetch(m[1], level);
    if (!bytes) return null;
    const bmp = await createImageBitmap(new Blob([bytes]));
    const c = new OffscreenCanvas(level, Math.max(1, Math.round((level * bmp.height) / bmp.width)));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return (await c.convertToBlob({ type: 'image/png' })).arrayBuffer();
  };
  const n = app.layout.files.find((f) => f.path === DOC);
  return { pages: n.media.pages, w: n.w, h: n.h, aspect: n.media.w / n.media.h };
}, DOC);
const panelAspect = layout.w / layout.h;
report(
  layout.pages === 26 && panelAspect > 1 && panelAspect < 2.4,
  `${layout.pages} slides laid out as a grid, the panel ${panelAspect.toFixed(2)} wide for 1 tall`,
);

const asksAt = async (fit) => {
  await page.evaluate(async ({ DOC, fit }) => {
    const app = window.__sanity.app;
    window.__asks.length = 0;
    const n = app.layout.files.find((f) => f.path === DOC);
    if (fit === 'all') app.fit(0);
    else if (fit === 'doc') app.cam.fit(n.x, n.y, n.x + n.w, n.y + n.h, 0.02);
    else {
      // The first slide filling the view, where `pushPages` puts it.
      const { pageGrid, PAGE_GAP } = await import('/src/lib/canvas/layout/tree.ts');
      const { metrics } = await import('/src/lib/metrics.ts');
      const pw = n.media.w;
      const ph = n.media.h;
      const { cols, rows } = pageGrid(n.media.pages, pw / ph);
      const availW = n.w - 2 * metrics.panelPadX;
      const availH = n.h - metrics.titleHeight - 2 * metrics.panelPadY;
      const gridW = cols * pw + (cols - 1) * PAGE_GAP * pw;
      const gridH = rows * ph + (rows - 1) * PAGE_GAP * pw;
      const k = Math.min(availW / gridW, availH / gridH);
      const x0 = n.x + metrics.panelPadX + (availW - gridW * k) / 2;
      const y0 = n.y + metrics.titleHeight + metrics.panelPadY + (availH - gridH * k) / 2;
      app.cam.fit(x0, y0, x0 + pw * k, y0 + ph * k, 0.02);
    }
    for (let i = 0; i < 30; i++) {
      app.invalidate();
      await new Promise((r) => requestAnimationFrame(r));
    }
    await app.scene.media.settled();
    // Which pages are on screen, from the same geometry `pushPages` uses.
    const { pageGrid, PAGE_GAP } = await import('/src/lib/canvas/layout/tree.ts');
    const { metrics } = await import('/src/lib/metrics.ts');
    const pw = n.media.w;
    const ph = n.media.h;
    const { cols, rows } = pageGrid(n.media.pages, pw / ph);
    const availW = n.w - 2 * metrics.panelPadX;
    const availH = n.h - metrics.titleHeight - 2 * metrics.panelPadY;
    const k = Math.min(availW / (cols * pw + (cols - 1) * PAGE_GAP * pw), availH / (rows * ph + (rows - 1) * PAGE_GAP * pw));
    const gw = cols * pw + (cols - 1) * PAGE_GAP * pw;
    const gh = rows * ph + (rows - 1) * PAGE_GAP * pw;
    const x0 = n.x + metrics.panelPadX + (availW - gw * k) / 2;
    const y0 = n.y + metrics.titleHeight + metrics.panelPadY + (availH - gh * k) / 2;
    const [vx0, vy0, vx1, vy1] = app.cam.visibleRect(0);
    window.__visible = [];
    for (let p = 0; p < n.media.pages; p++) {
      const x = x0 + (p % cols) * (pw + PAGE_GAP * pw) * k;
      const y = y0 + Math.floor(p / cols) * (ph + PAGE_GAP * pw) * k;
      if (x < vx1 && x + pw * k > vx0 && y < vy1 && y + ph * k > vy0) window.__visible.push(p);
    }
  }, { DOC, fit });
  await settled(page);
  const r = await page.evaluate(() => ({ asks: window.__asks.slice(), visible: window.__visible }));
  return Object.assign(r.asks, { visible: r.visible });
};

const whole = await asksAt('all');
report(whole.length === 0, `the whole project in view: ${whole.length} pages asked for`);

const doc = await asksAt('doc');
const docPages = new Set(doc.map((a) => a.page));
const docMax = Math.max(0, ...doc.map((a) => a.level));
report(docPages.size === 26 && docMax <= 512, `the document filling the view: ${docPages.size} pages asked for, the largest at ${docMax} px`);

const one = await asksAt('one');

const onePages = new Set(one.map((a) => a.page));
const oneMax = Math.max(0, ...one.map((a) => a.level));
const onScreen = new Set(one.visible);
report(
  onePages.size > 0 && onePages.size < 26 && [...onePages].every((p) => onScreen.has(p)),
  `zoomed into one page: ${onePages.size} pages asked for, all of them among the ${onScreen.size} on screen`,
);
report(oneMax >= 700, `and the one in view at the size it is shown: ${oneMax} px`);

// A picture of it, for looking at.
await asksAt('doc');
const box = await canvasBox(page);
await page.screenshot({ path: '/tmp/pages-check.png', clip: { x: box.x, y: box.y, width: box.w, height: box.h } });

await browser.close();
console.log(failures === 0 ? '\ndocuments expand, and ask only for the pages in view' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
