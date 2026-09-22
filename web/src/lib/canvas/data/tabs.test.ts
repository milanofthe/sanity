// Run with: npm test
//
// The same stops as `line_metrics` in crates/sanity-core/src/scan.rs, whose
// own tests pin `\tx` at width 5 and indent 4. Two implementations of one
// definition of a column, so both are tested against the same cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandLines, expandTabs, TAB_WIDTH } from './tabs.ts';

test('a tab advances to the next stop', () => {
  assert.equal(TAB_WIDTH, 4);
  assert.equal(expandTabs('\tx'), '    x');
  assert.equal(expandTabs('  \tx'), '    x');
  assert.equal(expandTabs('ab\tc'), 'ab  c');
  assert.equal(expandTabs('abc\td'), 'abc d');
  assert.equal(expandTabs('abcd\te'), 'abcd    e');
});

test('several tabs each advance to their own stop', () => {
  assert.equal(expandTabs('\t\tx'), '        x');
  assert.equal(expandTabs('a\tb\tc'), 'a   b   c');
});

test('a line without tabs comes back unchanged, and as the same string', () => {
  const line = 'const x = 1;';
  assert.equal(expandTabs(line), line);
});

test('an expanded index is a column', () => {
  // The property the renderer depends on: the character at index n is drawn at
  // column n, which is what the spans refer to.
  const raw = '\tCOLOR_RED,';
  const wide = expandTabs(raw);
  assert.equal(wide.indexOf('COLOR_RED'), 4);
  assert.equal(raw.indexOf('COLOR_RED'), 1);
});

test('lines are split and their line endings dropped', () => {
  assert.deepEqual(expandLines('a\n\tb\r\nc'), ['a', '    b', 'c']);
});

test('an empty file is one empty line', () => {
  assert.deepEqual(expandLines(''), ['']);
});
