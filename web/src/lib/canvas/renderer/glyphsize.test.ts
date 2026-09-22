// Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { exactSize, oneToOne } from './glyphsize.ts';

// At rest a glyph is drawn 1:1 from an atlas built at its em rounded to a whole
// pixel, so it may come out up to half a pixel off the em it asked for. What
// must never happen is the clamp to the smallest size leaking into that: text
// at three pixels an em drawn from a four pixel atlas without scaling.
test('a glyph drawn 1:1 is never more than half a pixel off its em', () => {
  for (let em = 1; em <= 300; em += 0.01) {
    if (!oneToOne(em)) continue;
    assert.ok(Math.abs(exactSize(em) - em) <= 0.5 + 1e-9, `em ${em} drawn at ${exactSize(em)}`);
  }
});

test('below and above the sizes built, glyphs are scaled rather than drawn 1:1', () => {
  assert.equal(oneToOne(3), false);
  assert.equal(oneToOne(3.4), false);
  assert.equal(oneToOne(3.6), true);
  assert.equal(oneToOne(240.4), true);
  assert.equal(oneToOne(260), false);
});
