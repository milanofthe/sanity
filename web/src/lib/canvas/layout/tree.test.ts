// Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout, mediaShape, pageGrid, type FileEntry } from './tree.ts';

const files = (n: number): FileEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    path: `${['src', 'lib', 'tests'][i % 3]}/${i % 5 === 0 ? 'deep/' : ''}f${i}.rs`,
    lineCount: 40 + ((i * 37) % 400),
    maxCols: 30 + ((i * 13) % 60),
  }));

test('a file marked absent keeps its place and is not listed', () => {
  const all = files(60);
  const gone = new Set(['src/deep/f0.rs', 'lib/f7.rs', 'tests/f11.rs']);
  const full = computeLayout(all, { w: 1400, h: 900 });
  const holed = computeLayout(all.map((e) => ({ ...e, absent: gone.has(e.path) })), { w: 1400, h: 900 });

  assert.equal(holed.files.length, full.files.length - gone.size);
  assert.ok(holed.files.every((f) => !gone.has(f.path)));
  // Every file that is there is exactly where it would be with all of them.
  const at = new Map(full.files.map((f) => [f.path, f]));
  for (const f of holed.files) {
    const g = at.get(f.path)!;
    assert.deepEqual([f.x, f.y, f.w, f.h], [g.x, g.y, g.w, g.h], f.path);
  }
  assert.deepEqual(holed.bounds, full.bounds);
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
