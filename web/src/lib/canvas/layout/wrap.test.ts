// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineAtRow, rowsFor, visualRows, wrapOffsets } from './wrap.ts';

test('a line takes as many rows as it needs, blank lines included', () => {
  assert.equal(rowsFor(0, 40), 1, 'a blank line is still a row');
  assert.equal(rowsFor(1, 40), 1);
  assert.equal(rowsFor(40, 40), 1, 'exactly full is one row');
  assert.equal(rowsFor(41, 40), 2);
  assert.equal(rowsFor(120, 40), 3);
  assert.equal(rowsFor(50, 0), 1, 'a zero width cannot loop forever');
});

test('offsets are a prefix sum with a terminator', () => {
  const cols = [10, 0, 45, 90] as const;
  const off = wrapOffsets(cols, 40);
  // rows: 1, 1, 2, 3
  assert.deepEqual([...off], [0, 1, 2, 4, 7]);
  assert.equal(off.length, cols.length + 1);
  assert.equal(off[cols.length], visualRows(cols, 40));
});

test('wrapping never loses characters', () => {
  // The property clipping violated: every character has a row to live on.
  const widths = [0, 1, 39, 40, 41, 200, 4095];
  for (const cols of [12, 24, 40, 80, 120]) {
    for (const len of widths) {
      assert.ok(
        rowsFor(len, cols) * cols >= len,
        `${len} characters do not fit in ${rowsFor(len, cols)} rows of ${cols}`,
      );
    }
  }
});

test('narrower columns cost height but not area', () => {
  // A long file, all lines the same length.
  const cols = new Array(100).fill(80);
  const wide = visualRows(cols, 80) * 80;
  const narrow = visualRows(cols, 40) * 40;
  const narrower = visualRows(cols, 20) * 20;
  assert.equal(wide, narrow, 'halving the width doubles the rows');
  assert.equal(narrow, narrower);
});

test('lineAtRow inverts the offsets', () => {
  const off = wrapOffsets([10, 0, 45, 90], 40);
  // rows 0 | 1 | 2,3 | 4,5,6
  assert.equal(lineAtRow(off, 0), 0);
  assert.equal(lineAtRow(off, 1), 1);
  assert.equal(lineAtRow(off, 2), 2);
  assert.equal(lineAtRow(off, 3), 2);
  assert.equal(lineAtRow(off, 4), 3);
  assert.equal(lineAtRow(off, 6), 3);
  // Past the end clamps rather than throwing: a caller walking rows off the
  // bottom of a panel is normal.
  assert.equal(lineAtRow(off, 99), 3);
});

test('lineAtRow handles an empty file', () => {
  assert.equal(lineAtRow(wrapOffsets([], 40), 0), 0);
});

test('every row maps back to a line that contains it', () => {
  const widths = [0, 7, 120, 40, 41, 300, 5];
  const off = wrapOffsets(widths, 40);
  for (let row = 0; row < off[widths.length]; row++) {
    const line = lineAtRow(off, row);
    assert.ok(off[line] <= row && row < off[line + 1], `row ${row} -> line ${line}`);
  }
});
