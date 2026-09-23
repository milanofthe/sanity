// Run with: npm test
//
// `distribute` is the one piece of the treemap that is pure arithmetic with a
// property worth stating: the pieces add up to the whole, and nobody is below
// the size at which there is any point drawing them. Both were broken in ways
// a screenshot does not show. The cumulative rounding that keeps the tiling
// exact took a panel frozen at its 14 cell minimum down to 13, which is under
// the width where a code column can hold twelve characters, and the panel was
// then drawn, correctly, as something unreadable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distribute, subdivide } from './treemap.ts';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

test('the pieces add up to the whole, and are whole cells', () => {
  const cases: [number[], number, number[]][] = [
    [[10, 10, 10], 30, [1, 1, 1]],
    [[97, 2, 1], 100, [1, 1, 1]],
    [[97, 2, 1], 100, [14, 14, 14]],
    [[1, 1, 1, 1, 1, 1, 1], 23, [3, 3, 3, 3, 3, 3, 3]],
    [[5], 7, [2]],
    [[0, 0], 10, [1, 1]],
  ];
  for (const [areas, side, mins] of cases) {
    const out = distribute(areas, side, mins);
    assert.equal(sum(out), side, `${JSON.stringify(areas)} in ${side}: ${JSON.stringify(out)}`);
    for (const v of out) assert.ok(Number.isInteger(v), `${v} is not a whole cell`);
  }
});

test('nothing lands below its minimum while the minimums fit', () => {
  const areas = [200, 3, 2, 1];
  const mins = [4, 6, 6, 6];
  const out = distribute(areas, 40, mins);
  assert.equal(sum(out), 40);
  for (let i = 0; i < out.length; i++) {
    assert.ok(out[i] >= mins[i], `member ${i} got ${out[i]}, minimum ${mins[i]}`);
  }
  // And the one with almost all the weight still gets almost everything left.
  assert.ok(out[0] >= 20, `the large member got only ${out[0]} of 40`);
});

test('a member that does not need its minimum keeps its share', () => {
  // The flexbox property: clamping one member must not change the proportions
  // among the others.
  const out = distribute([50, 50, 1], 101, [1, 1, 20]);
  assert.equal(sum(out), 101);
  assert.equal(out[2], 20);
  assert.ok(Math.abs(out[0] - out[1]) <= 1, `${out[0]} against ${out[1]}`);
});

test('minimums that cannot all be met come out proportional instead', () => {
  // No arrangement works, so the answer is the best available: everyone
  // present, nobody overlapping, and the tiling still exact. The layout
  // reports these as unusable and asks for a larger rectangle.
  const out = distribute([1, 1, 1], 9, [14, 14, 14]);
  assert.equal(sum(out), 9);
  for (const v of out) assert.ok(v >= 1, `a member got ${v} cells`);
});

test('one member takes the whole side', () => {
  assert.deepEqual(distribute([7], 12, [3]), [12]);
});

test('the largest weight gets the largest piece', () => {
  const out = distribute([1, 2, 4, 8], 60, [1, 1, 1, 1]);
  assert.equal(sum(out), 60);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i] >= out[i - 1], `${JSON.stringify(out)} is not ordered by weight`);
  }
});

test('a subdivision given its own rows comes out the same', () => {
  const items = [40, 31, 22, 17, 9, 6, 3, 2].map((area) => ({ area }));
  const rect = { x: 0, y: 0, w: 60, h: 40 };
  const first = subdivide(items, rect, []);
  const again = subdivide(items, rect, first.rows);
  assert.deepEqual(again.rects, first.rects);
  assert.deepEqual(again.rows, first.rows);
});

test('given rows hold when a weight changes, and the tiling stays exact', () => {
  const items = [40, 31, 22, 17, 9, 6, 3, 2].map((area) => ({ area }));
  const rect = { x: 0, y: 0, w: 60, h: 40 };
  const { rows } = subdivide(items, rect, []);
  const grown = items.map((it, i) => (i === 3 ? { area: it.area * 1.5 } : it));
  const out = subdivide(grown, rect, rows);
  assert.deepEqual(out.rows, rows);
  const cells = out.rects.reduce((s, r) => s + r.w * r.h, 0);
  assert.equal(cells, rect.w * rect.h);
});

test('a given row the rectangle cannot hold ends the given ones', () => {
  const items = [10, 10, 10].map((area) => ({ area, minW: 8 }));
  // Three abreast need 24 cells of width, and there are 12.
  const out = subdivide(items, { x: 0, y: 0, w: 12, h: 40 }, [{ count: 3, horizontal: true }]);
  for (const r of out.rects) assert.ok(r.w >= 8, `${r.w} wide`);
});
