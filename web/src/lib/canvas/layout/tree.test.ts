// Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout, type FileEntry } from './tree.ts';

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
