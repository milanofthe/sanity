// Asserts that the text on screen is the text in the file.
//
// Two bugs this exists for, both of which looked like a font problem and were
// not:
//
//   A tab is four columns in the wire format and one character in a string.
//   The spans say "the identifier starts at column 4", the renderer read index
//   4 of a line whose identifier starts at index 1, and `COLOR_RED` came out
//   as `OR_RED`. Every line with a tab in it was drawn from the wrong offset.
//
//   The glyph pass iterated spans and drew what they covered, so a character
//   in no span was not drawn at all. In real code that is about a tenth of
//   them, and it read as stray spaces inside words. Together with the shift
//   above it also explains the second symptom, neighbouring letters of one
//   word in two different greys: the word straddled a span boundary it should
//   not have, so one half took a colour and the other fell through to none.
//
// So the invariant, per visible row: exactly one glyph per printable column,
// at that column, in the colour of the span covering it.
//
// Checked against the *file*, fetched here and expanded here, not against the
// text the canvas hands out. That distinction is the whole value of the check:
// the first version compared the drawing to the source's own lines, which
// meant the tab bug was invisible to it, because the drawing and the reference
// were wrong in exactly the same way. Put the bug back and it still passed.
// The reference has to be the bytes on disk.

import { base, frameOnScreen, launch, settled, src } from './browser.mjs';

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
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

let failures = 0;
const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  failures++;
};

// The fixture's own text, straight from the file the dump wrote, with tabs
// intact. Expanded in the browser by the function below rather than by
// canvas/data/tabs.ts, so the check and the thing it checks do not share an
// implementation.
// `fixture=x` lives at /x, `demo=x` at /demo/x. Being able to point this at a
// demo repository is what lets it check a notebook, whose text is assembled
// from its cells rather than read off the file: see crates/sanity-core's
// notebook module, and `scan::display_text`.
const q = (process.env.SANITY_SRC ?? src).split('=');
const fixture = q[0] === 'demo' ? `demo/${q[1]}` : (q[1] ?? 'fixture');
await page.evaluate(async (name) => {
  const raw = await fetch(`/${name}/texts.json`).then((r) => r.json());
  const TAB = 4;
  const expand = (line) => {
    if (!line.includes('\t')) return line;
    let out = '';
    for (const ch of line) {
      if (ch === '\t') out += ' '.repeat(TAB - (out.length % TAB));
      else out += ch;
    }
    return out;
  };
  window.__raw = {};
  window.__hasTabs = {};
  for (const [path, text] of Object.entries(raw)) {
    const lines = text.split('\n');
    window.__hasTabs[path] = lines.some((l) => l.includes('\t'));
    window.__hasTabLine ??= {};
    window.__hasTabLine[path] = lines.map((l) => l.includes('\t'));
    window.__raw[path] = lines.map((l) => expand(l.endsWith('\r') ? l.slice(0, -1) : l));
  }
}, fixture);

/** Compare drawn glyphs against the file, for whatever is on screen now. */
const compare = async () =>
  page.evaluate(async () => {
    const app = window.__sanity.app;
    const sc = app.scene;
    const { spanCol, spanLen, spanKind } = await import('/src/lib/canvas/data/wire.ts');
    const { GlyphAtlas } = await import('/src/lib/canvas/renderer/glyphatlas.ts');

    // What is drawn, grouped by row through the y it was placed at.
    const STRIDE = 6;
    const drawn = new Map();
    for (let i = 0; i < sc.glyphs.count; i++) {
      const o = i * STRIDE;
      const y = Math.round(sc.glyphs.data[o + 1] * 100) / 100;
      const x = sc.glyphs.data[o];
      const kind = sc.glyphs.data[o + 3];
      if (!drawn.has(y)) drawn.set(y, []);
      drawn.get(y).push({ x, kind });
    }
    for (const list of drawn.values()) list.sort((a, b) => a.x - b.x);

    // What should be drawn, from the same rows the renderer walked.
    const [vx0, vy0, vx1, vy1] = app.cam.visibleRect(64);
    const report = {
      rows: 0, chars: 0, missing: 0, extra: 0, wrongKind: 0, tabRows: 0, examples: [],
    };
    const tf = { scale: 1, bx: 0, by: 0 };

    for (const f of sc.files.values()) {
      if (f.node.stub) continue;
      const n = f.node;
      if (n.x > vx1 || n.y > vy1 || n.x + n.w < vx0 || n.y + n.h < vy0) continue;
      const g = n.geom;
      const cols = g.cols;
      // The same bounds `pushGlyphs` uses, including the horizontal ones: a
      // code column off the side of the window is not drawn, and comparing
      // against it counts every one of its characters as missing.
      for (const run of sc.visibleRuns(f, vx0, vy0, vx1, vy1)) {
        const [c, colX, firstRow, lastRow] = run;
        for (let row = firstRow; row <= lastRow; row++) {
          sc.rowInfo(f, row, c);
          const line = sc.riLine;
          // The file, not the canvas's copy of it.
          const text = window.__raw[n.path]?.[line];
          if (text === undefined) continue;
          const from = sc.riWrap * cols;
          const to = Math.min(from + cols, text.length);
          if (to <= from) continue;

          // The kind of every column, from the spans, first span wins.
          const kinds = new Map();
          for (let s = f.data.spanStart[line]; s < f.data.spanStart[line + 1]; s++) {
            const p = f.data.spans[s];
            const col = spanCol(p);
            const end = col + spanLen(p);
            for (let k = col; k < end; k++) if (!kinds.has(k)) kinds.set(k, spanKind(p));
          }

          const want = [];
          for (let k = from; k < to; k++) {
            if (GlyphAtlas.index(text.charCodeAt(k)) < 0) continue;
            want.push({ col: k, kind: kinds.has(k) ? kinds.get(k) : 0 });
          }
          if (want.length === 0) continue;

          // Rows are matched by the nearest drawn y rather than an exact one:
          // the renderer lifts a line by the descender overhang so the last
          // line of a panel is not clipped, and a check that insists on the
          // row's own y finds nothing at all. Half a line of tolerance is far
          // less than the distance to the next row.
          const y = sc.riY * tf.scale + tf.by;
          let got = [];
          let best = Infinity;
          for (const [key, quads] of drawn) {
            const d = Math.abs(key - y);
            if (d < best && d < 7 * tf.scale) {
              best = d;
              got = quads;
            }
          }
          // The glyphs of this row and column range, by their x.
          const cw = 7;
          const mine = got.filter((q) => {
            const k = Math.round((q.x - colX) / cw) + from;
            return k >= from && k < to;
          });

          report.rows++;
          report.chars += want.length;
          // How many of the rows compared actually exercise the tab path. A
          // check that never sees a tab cannot catch a tab bug, and this one
          // did not: it reported success with the bug reinstated because the
          // camera happened to be over a region without any.
          if (window.__hasTabLine?.[n.path]?.[line]) report.tabRows++;
          if (mine.length !== want.length) {
            const d = want.length - mine.length;
            if (d > 0) report.missing += d;
            else report.extra += -d;
            if (report.examples.length < 4) {
              report.examples.push(
                `${n.path}:${line + 1} wants ${want.length} glyphs, drew ${mine.length}: ` +
                  JSON.stringify(text.slice(from, Math.min(to, from + 40))),
              );
            }
            continue;
          }
          for (let i = 0; i < want.length; i++) {
            if (mine[i].kind !== want[i].kind) {
              report.wrongKind++;
              if (report.examples.length < 4) {
                report.examples.push(
                  `${n.path}:${line + 1} column ${want[i].col} drawn as kind ` +
                    `${mine[i].kind}, spans say ${want[i].kind}`,
                );
              }
            }
          }
        }
      }
    }
    return report;
  });

/** Put a file on screen at a readable zoom and check it. */
const look = async (label, pick, wantTabs = false) => {
  const path = await page.evaluate((body) => {
    const app = window.__sanity.app;
    // eslint-disable-next-line no-new-func
    const choose = new Function('files', body);
    const f = choose([...app.scene.files.values()]);
    if (!f) return null;
    app.cam.zoom = 15 / 14;
    // On the first line that has what this case is about, rather than at a
    // fixed offset into the panel: the camera landed past the tabs and the
    // check compared 108 rows without a single one in them.
    const rows = window.__hasTabLine?.[f.node.path] ?? [];
    const at = Math.max(0, rows.findIndex(Boolean));
    const rect = app.scene.lineRect(f.node.path, at);
    app.cam.x = rect ? rect[0] + 200 : f.node.x + 300;
    app.cam.y = rect ? rect[1] : f.node.y + 300;
    app.invalidate();
    return f.node.path;
  }, pick);
  if (!path) {
    fail(`${label}: no file matched, so nothing was checked`);
    return;
  }
  await settled(page);
  await frameOnScreen(page);
  const r = await compare();
  console.log(
    `${label.padEnd(22)} ${r.rows} rows (${r.tabRows} with tabs), ${r.chars} characters: ` +
      `${r.missing} missing, ${r.extra} extra, ${r.wrongKind} miscoloured  (${path})`,
  );
  for (const e of r.examples) console.log(`        ${e}`);
  if (r.rows < 10) fail(`${label}: only ${r.rows} rows were on screen`);
  if (wantTabs && r.tabRows < 3) {
    fail(`${label}: only ${r.tabRows} of the rows compared contain a tab, so the case is untested`);
  }
  if (r.missing || r.extra || r.wrongKind) {
    fail(`${label}: ${r.missing} missing, ${r.extra} extra, ${r.wrongKind} miscoloured`);
  }
};

// A file with tabs in it, which is the regression, and one without.
await look(
  'a file with tabs',
  `return files.find((f) => !f.node.stub && f.data.lineCount > 40
     && window.__hasTabs[f.node.path]) ?? null;`,
  true,
);
await look(
  'the largest file in view',
  `return files.filter((f) => !f.node.stub).sort((a, b) => b.data.lineCount - a.data.lineCount)[0] ?? null;`,
);

// A notebook, when the project has one. Its lines exist nowhere on disk: they
// are the cells, flattened, and the spans come from two parses over two views
// of that same line space. So this is the case where the text the renderer
// draws and the text the check compares against could drift apart while both
// look plausible.
const notebooks = await page.evaluate(
  () => [...window.__sanity.app.scene.files.values()].filter((f) => f.node.path.endsWith('.ipynb')).length,
);
if (notebooks === 0) {
  console.log('no notebook in this project, so the cell path is not checked here');
} else {
  await look(
    'a notebook',
    `return files.filter((f) => !f.node.stub && f.node.path.endsWith('.ipynb'))
       .sort((a, b) => b.data.lineCount - a.data.lineCount)[0] ?? null;`,
  );
}

await browser.close();
console.log(
  failures === 0 ? '\nthe text on screen is the text in the file' : `\n${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
