// Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout, mediaShape, pageGrid, type FileEntry, type Layout } from './tree.ts';

const files = (n: number): FileEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    path: `${['src', 'lib', 'tests'][i % 3]}/${i % 5 === 0 ? 'deep/' : ''}f${i}.rs`,
    lineCount: 40 + ((i * 37) % 400),
    maxCols: 30 + ((i * 13) % 60),
  }));

const view = { w: 1400, h: 900 };
const rects = (l: Layout) => new Map(l.files.map((f) => [f.path, [f.x, f.y, f.w, f.h]]));

test('laid out again from itself, a layout does not move', () => {
  const all = files(120);
  const first = computeLayout(all, view);
  const again = computeLayout(all, view, first);
  assert.equal(again.continued, true);
  assert.deepEqual(rects(again), rects(first));
});

test('a new file moves little, and nothing far, laid out from the layout before', () => {
  const all = files(120);
  const first = computeLayout(all, view);
  const next = computeLayout([...all, { path: 'lib/fresh.rs', lineCount: 60, maxCols: 50 }], view, first);
  assert.equal(next.continued, true);
  assert.ok(next.files.some((f) => f.path === 'lib/fresh.rs'));
  // Centres as a share of the canvas, so the canvas growing is not movement.
  // Three directories share the root, so the one that gained a file pushes
  // the other two along by a little; nothing may jump.
  const centre = (l: Layout, f: { x: number; y: number; w: number; h: number }) => {
    const [x0, y0, x1, y1] = l.bounds;
    return [(f.x + f.w / 2 - x0) / (x1 - x0), (f.y + f.h / 2 - y0) / (y1 - y0)];
  };
  // The room the file takes comes from the end of its directory, where the
  // new file goes, so the panels there give way and the rest stay. From
  // scratch the same file reshuffles most of the canvas.
  const moves = (l: Layout) => {
    const before = new Map(first.files.map((f) => [f.path, centre(first, f)]));
    let far = 0;
    let noticeable = 0;
    for (const f of l.files) {
      const p = before.get(f.path);
      if (!p) continue;
      const q = centre(l, f);
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      far = Math.max(far, d);
      if (d > 0.01) noticeable++;
    }
    return { far, noticeable };
  };
  const carried = moves(next);
  const fresh = moves(computeLayout([...all, { path: 'lib/fresh.rs', lineCount: 60, maxCols: 50 }], view));
  assert.ok(carried.far < 0.08, `a panel moved ${(carried.far * 100).toFixed(1)} percent of the canvas`);
  assert.ok(
    carried.noticeable * 3 < fresh.noticeable,
    `${carried.noticeable} panels moved noticeably, ${fresh.noticeable} from scratch`,
  );
});

test('the pages of a document are a grid near a screen, and never an empty row', () => {
  // Two A4 pages side by side, not one above the other.
  assert.deepEqual(pageGrid(2, 595 / 842), { cols: 2, rows: 1 });
  for (const [pages, aspect] of [[3, 0.707], [7, 0.707], [26, 454 / 255], [40, 0.707], [400, 0.707]]) {
    const { cols, rows } = pageGrid(pages, aspect);
    assert.ok(cols * rows >= pages, `${pages} pages fit`);
    assert.ok((rows - 1) * cols < pages, `${pages} pages leave no empty row`);
    const w = cols * aspect;
    assert.ok(w / rows > 0.6 && w / rows < 4, `${pages} pages at ${cols} by ${rows}`);
  }
});

test('expanding a document changes its shape and not its area', () => {
  const doc = { kind: 'document' as const, w: 595, h: 842, pages: 16 };
  const one = mediaShape(doc);
  const all = mediaShape({ ...doc, expanded: true });
  assert.equal(all.pixels, one.pixels);
  assert.ok(all.aspect > one.aspect * 2, `${all.aspect} against ${one.aspect}`);
  // A single page has nothing to expand into.
  assert.deepEqual(mediaShape({ ...doc, pages: 1, expanded: true }), mediaShape({ ...doc, pages: 1 }));
});

test('a folder filling in follows its files from the layout of its estimates', () => {
  // Estimated sizes off by up to a fifth either way, as they are for a file
  // whose head is not like the rest of it; then the real ones arrive.
  const real = files(120);
  const estimated = real.map((f, i) => ({ ...f, lineCount: Math.max(1, Math.round(f.lineCount * (0.8 + (i % 5) * 0.1))) }));
  const first = computeLayout(estimated, view);
  const filled = computeLayout(real, view, first, true);
  assert.equal(filled.continued, true);
  const centre = (l: Layout, f: { x: number; y: number; w: number; h: number }) => {
    const [x0, y0, x1, y1] = l.bounds;
    return [(f.x + f.w / 2 - x0) / (x1 - x0), (f.y + f.h / 2 - y0) / (y1 - y0)];
  };
  const before = new Map(first.files.map((f) => [f.path, centre(first, f)]));
  let far = 0;
  for (const f of filled.files) {
    const p = before.get(f.path)!;
    const q = centre(filled, f);
    far = Math.max(far, Math.hypot(q[0] - p[0], q[1] - p[1]));
  }
  // Nothing jumps: the panels slide to their real sizes where they are.
  assert.ok(far < 0.1, `a panel moved ${(far * 100).toFixed(1)} percent of the canvas`);
});
