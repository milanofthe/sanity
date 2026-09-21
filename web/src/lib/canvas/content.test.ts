// Run with: npm test
//
// The same cases as the Rust tests in crates/sanity-core/src/find.rs. Two
// implementations of one definition of "a hit" will drift apart otherwise, and
// the drift would show up as a search that finds different things depending on
// whether a real folder or a fixture is open.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countHits, findInText, findInTexts } from './content.ts';

test('finds every occurrence with its line and column', () => {
  const { at, more } = findInText('let x = 1;\nlet y = x + x;\n', 'x', 10);
  assert.equal(more, 0);
  // Line 1 is "let y = x + x;", so its x's are at 8 and 12; column 4 is the y.
  assert.deepEqual(at, [0, 4, 1, 8, 1, 12]);
});

test('ignores case on both sides', () => {
  assert.equal(findInText('Foo FOO foo', 'foo', 10).at.length / 2, 3);
});

test('an empty query finds nothing', () => {
  const { at, more } = findInText('anything', '', 10);
  assert.deepEqual(at, []);
  assert.equal(more, 0);
});

test('a hit does not overlap the one before it', () => {
  assert.deepEqual(findInText('aaa', 'aa', 10).at, [0, 0]);
  assert.deepEqual(findInText('aaaa', 'aa', 10).at, [0, 0, 0, 2]);
});

test('columns are characters, not bytes', () => {
  assert.deepEqual(findInText('übüb x', 'x', 10).at, [0, 5]);
});

test('the cap counts what it leaves out', () => {
  const { at, more } = findInText('x x x x x', 'x', 2);
  assert.equal(at.length / 2, 2);
  assert.equal(more, 3);
});

test('a line shorter than the query is skipped', () => {
  assert.deepEqual(findInText('a\nab\nabc\n', 'abc', 10).at, [2, 0]);
});

test('a needle with no hit reports none', () => {
  const { at, more } = findInText('the quick brown fox', 'zebra', 10);
  assert.deepEqual(at, []);
  assert.equal(more, 0);
});

test('a carriage return is not part of the line', () => {
  // Only this side has to deal with it: the Rust side splits on `lines()`,
  // which already drops it.
  assert.deepEqual(findInText('ab\r\nxb\r\n', 'b', 10).at, [0, 1, 1, 1]);
});

test('files with no hit are left out, and the rest come in path order', () => {
  const files = findInTexts(
    [
      ['b.ts', 'nothing at all'],
      ['a.ts', 'a hit here\nand here\n'],
      ['c.ts', 'here too'],
    ],
    'here',
    10,
  );
  assert.deepEqual(files.map((f) => f.path), ['a.ts', 'c.ts']);
  assert.deepEqual(countHits(files), { shown: 3, total: 3 });
});

test('the count separates what is shown from what there is', () => {
  const files = findInTexts([['a.ts', 'x x x x']], 'x', 2);
  assert.deepEqual(countHits(files), { shown: 2, total: 4 });
});
