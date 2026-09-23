// The pictures in the README, and the ones on the project page of the
// homepage, made the same way every time.
//
//   npm run readme-shots                     README pictures into assets/, as WebP
//   SANITY_HOME_OUT=../home/static/images npm run readme-shots
//                                            and the homepage's as well
//
// Against the dev server, in the sanity theme, at 1600 by 1000 and twice the
// pixels. Each scene is set up through the app's own methods and then drawn
// frame by frame at chosen moments, so a change is caught in the middle of
// its flash rather than wherever a screenshot happened to land.
//
// Two things are staged, because the web build cannot do them: a change is
// an edit made in the page to real files of the demo, since a dump cannot be
// written to; and the history ticker is given the real commits of the demo's
// repository, read here with git, since the web build has no backend to ask.
// The history scene plays the four files the shown commit really changed.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { base, launch, settled } from './browser.mjs';

const OUT = process.env.SANITY_OUT ?? 'assets';
const HOME = process.env.SANITY_HOME_OUT ?? null;
mkdirSync(OUT, { recursive: true });
if (HOME) mkdirSync(HOME, { recursive: true });

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log(`[error] ${e.message}`));
await page.addInitScript(() => {
  localStorage.setItem('sanity.theme', 'sanity');
  localStorage.setItem('sanity.dirLabels', '1');
});

async function open(demo) {
  await page.goto(`${base}/?demo=${demo}`, { waitUntil: 'load' });
  await page.waitForFunction(() => (document.querySelector('footer')?.textContent ?? '').includes('files'), null, { timeout: 60000 });
  await settled(page);
}

/** Stop the loop and draw frames by hand; see `__step`. */
async function takeOver() {
  await page.evaluate(() => {
    const app = window.__sanity.app;
    cancelAnimationFrame(app.raf);
    app.running = true;
    window.__step = (seconds) => {
      const dt = 1 / 60;
      for (let t = 0; t < seconds - 1e-9; t += dt) {
        app.scene.advance(dt);
        app.scene.render(app.cam, dt);
      }
      app.scene.render(app.cam, 0);
    };
    // An edit to a file: `count` lines at `at` taken out and `add` lines
    // copied from `from` put in their place, as a payload of the kind the
    // backend sends, so the diff sees a real removal and a real addition.
    window.__edit = (path, at, count, from, add) => {
      const d = app.scene.files.get(path).data;
      const order = [];
      for (let i = 0; i < d.lineCount; i++) {
        if (i === at) for (let k = 0; k < add; k++) order.push(from + k);
        if (i < at || i >= at + count) order.push(i);
      }
      const spanStart = new Uint32Array(order.length + 1);
      const spans = [];
      order.forEach((i, k) => {
        spanStart[k] = spans.length;
        for (let s = d.spanStart[i]; s < d.spanStart[i + 1]; s++) spans.push(d.spans[s]);
      });
      spanStart[order.length] = spans.length;
      return {
        lineCount: order.length, langId: d.langId, flags: d.flags, spanStart,
        lineCols: Uint16Array.from(order.map((i) => d.lineCols[i])),
        lineIndent: Uint8Array.from(order.map((i) => d.lineIndent[i])),
        lineState: new Uint8Array(order.length),
        spans: Uint32Array.from(spans),
      };
    };
  });
}

/** The text of what is on screen, for the scenes readable enough to show it. */
const textIn = () => page.evaluate(async () => {
  window.__step(0);
  await window.__sanity.app.lastSource?.ready?.();
  window.__step(0);
});

/**
 * The README's copy as WebP, the homepage's as PNG, which its build turns
 * into WebP itself. Encoded by the browser, so this needs nothing installed:
 * at 0.9 a canvas of the whole project is a third of its PNG, and the text in
 * the close-up stays as sharp as it was.
 */
async function shoot(name, homeName = null) {
  const png = await page.screenshot();
  if (name) {
    const webp = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/webp', 0.9).split(',')[1];
    }, png.toString('base64'));
    writeFileSync(join(OUT, name), Buffer.from(webp, 'base64'));
  }
  if (HOME && homeName) writeFileSync(join(HOME, homeName), png);
  console.log([name, HOME && homeName].filter(Boolean).join(' and '));
}

// --- The whole project, its directories named. -----------------------------
await open('pathsim');
await takeOver();
await page.evaluate(() => {
  window.__sanity.app.fit(0);
  window.__step(0.1);
});
await shoot('screenshot-project.webp');

// --- A batch of changes, as a wave, zoomed out. ----------------------------
await open('pathsim');
await takeOver();
await page.evaluate(async () => {
  const app = window.__sanity.app;
  const d = app.layout.dirs.find((x) => x.path === 'src/pathsim');
  app.cam.fit(d.x, d.y, d.x + d.w, d.y + d.h, 0.02);
  window.__step(0.1);
  const paths = [
    'src/pathsim/blocks/scope.py', 'src/pathsim/simulation.py', 'src/pathsim/events/schedule.py',
    'src/pathsim/solvers/esdirk43.py', 'src/pathsim/blocks/lti.py',
  ].filter((p) => app.scene.files.has(p));
  // As many lines in as out, so each still fits its panel and the batch
  // plays in place.
  const batch = paths.map((p, i) => [p, window.__edit(p, 30 + i * 17, 14, 4, 14)]);
  await app.applyBatch(batch, [], async () => {}, true);
  // The first files are adding their lines, the last are still taking theirs
  // away: the wave caught halfway across.
  window.__step(0.36);
});
await shoot(null, 'sanity-change.png');

// --- One change, where the code can be read. --------------------------------
await open('pathsim');
await takeOver();
await page.evaluate(() => {
  const app = window.__sanity.app;
  const path = 'src/pathsim/blocks/scope.py';
  // No breadcrumb over the code: this one is about the lines.
  app.setDirLabels(false);
  const n = app.scene.files.get(path).node;
  const g = n.geom;
  const at = 60;
  // Line `at` of the first column, at a size where the text reads well.
  // The panel's left edge a little inside the view, the changed lines a
  // third of the way down.
  app.cam.zoom = 1.25;
  app.cam.x = n.x - 12 + app.cam.vw / 2 / app.cam.zoom;
  app.cam.y = n.y + 14 + at * 14 + app.cam.vh / 6 / app.cam.zoom;
  window.__step(0.1);
  // The file with six of its lines taken out, quietly, and then the file as
  // it is: the six arrive as added lines. The other way round, an edit of
  // the file, would draw the demo's text, which cannot be edited, in the
  // colours of lines moved from elsewhere.
  const original = app.scene.files.get(path).data;
  app.touch(path, window.__edit(path, at, 6, 0, 0), false);
  window.__step(2);
  app.touch(path, original);
  // Into the arrival: the new lines at their greenest.
  window.__step(0.4);
});
await textIn();
await page.evaluate(() => window.__step(0));
await shoot('screenshot-code.webp');

// --- The history: a real commit of the demo, its real files. ----------------
const repo = join('.demo-src', 'pathsim');
const log = execFileSync('git', ['-C', repo, 'log', '--first-parent', '-n', '40', '--format=%H%x1f%ct%x1f%an%x1f%s'])
  .toString().trim().split('\n').map((l) => {
    const [sha, time, author, subject] = l.split('\x1f');
    return { sha, time: Number(time), author, subject };
  });
const shown = log.findIndex((c) => c.sha.startsWith('4055017'));
const touched = execFileSync('git', ['-C', repo, 'diff', '--name-only', `${log[shown].sha}^1`, log[shown].sha])
  .toString().trim().split('\n');
await open('pathsim');
await takeOver();
await page.evaluate(async ({ log, shown, touched }) => {
  const history = window.__sanity.history;
  history.commits = log;
  history.at = shown;
  history.target = shown;
  const app = window.__sanity.app;
  const paths = touched.filter((p) => app.scene.files.has(p));
  // The whole project: the commit's four files are in tests and src, far
  // apart, and the box around them is most of it anyway.
  app.fit(0);
  window.__step(0.1);
  const batch = paths.map((p, i) => [p, window.__edit(p, 20 + i * 9, 12, 2, 12)]);
  await app.applyBatch(batch, [], async () => {}, true);
  window.__step(0.34);
}, { log, shown, touched });
await shoot('screenshot-history.webp', 'sanity-history.png');

// --- Search, over names and contents. ----------------------------------------
await open('pathsim');
await page.evaluate(() => window.__sanity.app.fit(0));
await page.keyboard.press('/');
await page.keyboard.type('integrator');
// The names match at once and the contents a moment later, from the
// backend's search; the count settles once they are in.
let last = '';
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(250);
  const now = await page.evaluate(() => document.querySelector('.count')?.textContent ?? '');
  if (now === last && /\/\d{2,}/.test(now)) break;
  last = now;
}
await settled(page);
await shoot('screenshot-search.webp', 'sanity-search.png');

// --- Pictures and the first pages of PDFs. -----------------------------------
await open('rslab');
await page.evaluate(async () => {
  const app = window.__sanity.app;
  // The directory with the most pictures in it, with some of its
  // neighbourhood.
  const count = new Map();
  for (const f of app.layout.files) {
    if (!f.media) continue;
    const d = f.path.split('/').slice(0, -1).join('/');
    count.set(d, (count.get(d) ?? 0) + 1);
  }
  const best = [...count].sort((a, b) => b[1] - a[1])[0][0];
  const d = app.layout.dirs.find((x) => x.path === best);
  const grow = 0.6;
  app.cam.fit(d.x - d.w * grow, d.y - d.h * grow, d.x + d.w * (1 + grow), d.y + d.h * (1 + grow), 0);
  for (let i = 0; i < 20; i++) {
    app.invalidate();
    await new Promise((r) => requestAnimationFrame(r));
  }
  await app.scene.media?.settled();
});
await settled(page);
await shoot('screenshot-pictures.webp', 'sanity-pdf.png');

await browser.close();
