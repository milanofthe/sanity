// Run with: npm test
//
// The lattice is an invariant, not a style choice. The text is monospace, so
// the content lives on a grid of charWidth by lineHeight; if any chrome
// measurement is off that grid, the text of two adjacent panels cannot share a
// baseline, and the canvas reads as scattered no matter how well the treemap
// packs. An earlier version had a 16 unit title over 4 units of padding, which
// put every panel's text six units out of step with its neighbour's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CELL, metrics } from './metrics.ts';

const { charWidth, lineHeight } = metrics;

test('the cell divides evenly by the character metrics', () => {
  assert.equal(CELL % lineHeight, 0, 'cell must be whole lines tall');
  assert.equal(CELL % charWidth, 0, 'cell must be whole characters wide');
});

test('the text origin lands on the lattice', () => {
  // Panels sit at multiples of CELL, so the offset to their first text line
  // has to be a whole number of lines, and to their first column a whole
  // number of characters.
  assert.equal((metrics.titleHeight + metrics.panelPadY) % lineHeight, 0);
  assert.equal(metrics.panelPadX % charWidth, 0);
});

test('column gutters and directory frames stay on the lattice', () => {
  assert.equal(metrics.columnGutter % charWidth, 0);
  assert.equal(metrics.dirPad % CELL, 0);
  assert.equal(metrics.dirLabelHeight % CELL, 0);
});

test('a panel of whole cells holds whole lines and characters', () => {
  // The property the layout relies on: for any slot size in cells, the inner
  // region comes out as an exact number of lines and characters.
  for (const cellsW of [4, 7, 13, 40, 97]) {
    for (const cellsH of [2, 3, 11, 30, 64]) {
      const innerW = cellsW * CELL - 2 * metrics.panelPadX;
      const innerH = cellsH * CELL - metrics.titleHeight - 2 * metrics.panelPadY;
      assert.equal(innerW % charWidth, 0, `${cellsW}x${cellsH} width off lattice`);
      assert.equal(innerH % lineHeight, 0, `${cellsW}x${cellsH} height off lattice`);
    }
  }
});
