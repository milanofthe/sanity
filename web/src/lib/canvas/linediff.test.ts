// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, seams, signatures } from './linediff.ts';

const sig = (...lines: number[]) => new Uint32Array(lines);

test('an identical file has no changes', () => {
  const a = sig(1, 2, 3, 4, 5);
  assert.deepEqual(diffLines(a, a.slice()), { removed: [], added: [], wholesale: false });
});

test('appended lines are additions at the end', () => {
  const d = diffLines(sig(1, 2, 3), sig(1, 2, 3, 4, 5));
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.added, [3, 4]);
});

test('lines cut from the middle are removals at their old positions', () => {
  const d = diffLines(sig(1, 2, 3, 4, 5), sig(1, 2, 5));
  assert.deepEqual(d.removed, [2, 3]);
  assert.deepEqual(d.added, []);
});

test('a changed line is one removal and one addition', () => {
  // What an edit in place actually is, and both halves have to be reported so
  // the animation can take one away before putting the other back.
  const d = diffLines(sig(1, 2, 3), sig(1, 9, 3));
  assert.deepEqual(d.removed, [1]);
  assert.deepEqual(d.added, [1]);
});

test('an insertion at the top does not report the whole file', () => {
  // The case a naive index comparison gets wrong: every line moved down by
  // one, and none of them changed.
  const d = diffLines(sig(1, 2, 3, 4), sig(9, 1, 2, 3, 4));
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.added, [0]);
});

test('an empty file either way', () => {
  assert.deepEqual(diffLines(sig(), sig()), { removed: [], added: [], wholesale: false });
  assert.deepEqual(diffLines(sig(), sig(1, 2)).added, [0, 1]);
  assert.deepEqual(diffLines(sig(1, 2), sig()).removed, [0, 1]);
});

test('a rewrite of everything gives up rather than grinding', () => {
  // A checkout. Reported wholesale, which is what the renderer wants for it.
  const a = new Uint32Array(5000).map((_, i) => i);
  const b = new Uint32Array(5000).map((_, i) => i + 100000);
  const d = diffLines(a, b);
  assert.ok(d.wholesale);
  assert.equal(d.removed.length, 5000);
  assert.equal(d.added.length, 5000);
});

test('the reported indices are inside their own file', () => {
  // Nothing else in the renderer checks this, and an index past the end would
  // read another file's row.
  const cases: [number[], number[]][] = [
    [[1, 2, 3], [1, 2, 3, 4]],
    [[1, 2, 3, 4], [2, 3]],
    [[5], [1, 2, 3, 4, 5]],
    [[1, 2, 3, 4, 5], [5]],
    [[1, 1, 1], [1, 1]],
    [[1, 2, 1, 2], [2, 1, 2, 1]],
  ];
  for (const [a, b] of cases) {
    const d = diffLines(sig(...a), sig(...b));
    for (const i of d.removed) assert.ok(i >= 0 && i < a.length, `removed ${i} of ${a.length}`);
    for (const i of d.added) assert.ok(i >= 0 && i < b.length, `added ${i} of ${b.length}`);
  }
});

test('the edits actually turn one file into the other', () => {
  // The property that makes the diff a diff rather than a plausible list.
  const cases: [number[], number[]][] = [
    [[1, 2, 3, 4, 5], [1, 3, 5]],
    [[1, 2, 3], [4, 5, 6]],
    [[1, 2, 3, 4], [1, 9, 2, 3, 4]],
    [[], [1]],
    [[1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 9, 4, 5, 10, 7, 8]],
  ];
  for (const [a, b] of cases) {
    const d = diffLines(sig(...a), sig(...b));
    const kept = a.filter((_, i) => !d.removed.includes(i));
    const rebuilt: number[] = [];
    let ki = 0;
    for (let i = 0; i < b.length; i++) {
      if (d.added.includes(i)) rebuilt.push(b[i]);
      else rebuilt.push(kept[ki++]);
    }
    assert.deepEqual(rebuilt, b, `${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  }
});

test('signatures tell different lines apart and equal ones together', () => {
  // Two lines of the same width but different tokens must differ, or an edit
  // that replaces a line would look like no change at all.
  const cols = [10, 10, 10];
  const spanStart = [0, 1, 2, 3];
  const a = signatures(3, cols, spanStart, [0x111, 0x222, 0x333]);
  const b = signatures(3, cols, spanStart, [0x111, 0x999, 0x333]);
  assert.equal(a[0], b[0]);
  assert.notEqual(a[1], b[1]);
  assert.equal(a[2], b[2]);

  // And a line whose width changed is a different line.
  const c = signatures(3, [10, 11, 10], spanStart, [0x111, 0x222, 0x333]);
  assert.notEqual(a[1], c[1]);
});

test('a removal leaves a seam at the line that took its place', () => {
  const before = sig(1, 2, 3, 4, 5);
  const after = sig(1, 2, 5);
  const d = diffLines(before, after);
  assert.deepEqual(d.removed, [2, 3]);
  // Old lines 3 and 4 are gone; new line 2, the old line 5, now sits there.
  assert.deepEqual(seams(d, before.length, after.length), [{ line: 2, side: 'above' }]);
});

test('a replacement has no seam of its own', () => {
  // The arrival is already marked, and marking both would say less.
  const before = sig(1, 2, 3);
  const after = sig(1, 9, 3);
  const d = diffLines(before, after);
  assert.deepEqual(seams(d, before.length, after.length), []);
});

test('a removal at the end of the file marks the last line', () => {
  const before = sig(1, 2, 3, 4);
  const after = sig(1, 2);
  const d = diffLines(before, after);
  const s = seams(d, before.length, after.length);
  // Nothing sits below it, so the line above carries it, and the gap is drawn
  // under that line rather than over it.
  assert.deepEqual(s, [{ line: 1, side: 'below' }]);
});

test('a pure addition has no seams', () => {
  const before = sig(1, 2);
  const after = sig(1, 2, 3);
  assert.deepEqual(seams(diffLines(before, after), before.length, after.length), []);
});

test('seams are inside the new file', () => {
  const cases: [number[], number[]][] = [
    [[1, 2, 3, 4, 5], [3]],
    [[1, 2, 3], []],
    [[1, 2, 3, 4, 5, 6], [1, 6]],
    [[5, 4, 3, 2, 1], [5, 1]],
  ];
  for (const [a, b] of cases) {
    const d = diffLines(sig(...a), sig(...b));
    for (const { line, side } of seams(d, a.length, b.length)) {
      assert.ok(line >= 0 && line < Math.max(1, b.length), `seam ${line} of ${b.length}`);
      // A gap below is only ever the last line: anywhere else there is a line
      // under the removal to carry it.
      if (side === 'below') assert.equal(line, b.length - 1, 'a gap below is not at the end');
    }
  }
});
