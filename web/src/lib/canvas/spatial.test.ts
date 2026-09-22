// Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { SpatialGrid, type Box } from './spatial.ts';

/** A treemap-like tiling: a grid of rectangles of uneven size, no gaps. */
function tiling(n: number, seed = 1): Box[] {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out: Box[] = [];
  let y = 0;
  while (out.length < n) {
    const h = 20 + rand() * 200;
    let x = 0;
    while (x < 4000 && out.length < n) {
      const w = 20 + rand() * 300;
      out.push({ x, y, w, h });
      x += w;
    }
    y += h;
  }
  return out;
}

const overlaps = (b: Box, x0: number, y0: number, x1: number, y1: number) =>
  !(b.x > x1 || b.y > y1 || b.x + b.w < x0 || b.y + b.h < y0);

// What culling depends on: nothing on screen may be missing from the answer.
// The grid may report extra candidates, never fewer.
test('every box that overlaps the query is reported, and once', () => {
  const boxes = tiling(5000);
  const grid = new SpatialGrid(boxes);
  const out: number[] = [];
  for (const [x0, y0, x1, y1] of [
    [0, 0, 100, 100], [1000, 2000, 1400, 2300], [-50, -50, 5000, 99999], [3990, 10, 4100, 20],
  ]) {
    grid.near(x0, y0, x1, y1, out);
    const got = new Set(out);
    assert.equal(got.size, out.length, 'reported twice');
    boxes.forEach((b, i) => {
      if (overlaps(b, x0, y0, x1, y1)) assert.ok(got.has(i), `box ${i} missing`);
    });
  }
});

test('a small view is answered with a few candidates, not the whole list', () => {
  const boxes = tiling(20000);
  const grid = new SpatialGrid(boxes);
  const out = grid.near(1000, 1000, 1200, 1200, []);
  const exact = boxes.filter((b) => overlaps(b, 1000, 1000, 1200, 1200)).length;
  assert.ok(out.length < exact * 6, `${out.length} candidates for ${exact} boxes`);
});

test('a view outside the layout is answered with nothing', () => {
  const grid = new SpatialGrid(tiling(100));
  assert.equal(grid.near(1e6, 1e6, 1e6 + 10, 1e6 + 10, []).length, 0);
  assert.equal(grid.near(-1e6, -1e6, -1e6 + 10, -1e6 + 10, []).length, 0);
});

test('an empty layout answers every query with nothing', () => {
  const grid = new SpatialGrid([]);
  assert.equal(grid.near(0, 0, 100, 100, []).length, 0);
});
