// Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeMarkAt, edgeMarks, type EdgeTarget } from './edgemarks.ts';

const at = (path: string, x: number, y: number, since = 0): EdgeTarget => ({ path, x, y, alpha: 1, since });

test('a change to the right is marked on the right edge, upright', () => {
  const [m] = edgeMarks([at('r', 3000, 450)], 1400, 900, 2);
  assert.ok(m.x + m.w <= 1400 && m.x > 1380, `x ${m.x}`);
  assert.ok(m.h > m.w, 'upright on a side');
  assert.ok(Math.abs(m.y + m.h / 2 - 450) < 1);
});

test('a change above and to the left lands where the line to it leaves the view', () => {
  const [m] = edgeMarks([at('tl', -700, -900)], 1400, 900, 1);
  // The line from (700, 450) towards (-700, -900) leaves through the top.
  assert.ok(m.y < 10 && m.w > m.h, `${JSON.stringify(m)}`);
  const cx = m.x + m.w / 2;
  assert.ok(cx > 200 && cx < 300, `${cx}`);
});

test('every mark stays inside the view', () => {
  const targets = [at('a', -5000, -5000), at('b', 9000, 9000), at('c', 700, -9000), at('d', -9000, 450)];
  for (const m of edgeMarks(targets, 800, 600, 2)) {
    assert.ok(m.x >= 0 && m.y >= 0 && m.x + m.w <= 800 && m.y + m.h <= 600, JSON.stringify(m));
  }
});

test('changes in the same direction are one mark, the newest', () => {
  const marks = edgeMarks([at('old', 3000, 460, 2), at('new', 3000, 440, 0.1)], 1400, 900, 2);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].path, 'new');
});

test('a click near a mark lands on it', () => {
  const marks = edgeMarks([at('r', 3000, 450)], 1400, 900, 2);
  const m = marks[0];
  assert.equal(edgeMarkAt(marks, m.x - 4, m.y + 2), 'r');
  assert.equal(edgeMarkAt(marks, 700, 450), null);
});
