// Run with: npm test
//
// The invariant these exist for: the weights have to be a partition of one.
// The previous version was not, and at 11.5 pixels per line it drew the
// overview texture, the token bars and the glyphs all at half strength on top
// of each other. That is hard to see in a screenshot and trivial to catch
// here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bandsFromQuery,
  languageTint,
  lodBands,
  lodName,
  lodWeights,
  spanBarHeight,
} from './lod.ts';

/** Zoom levels across the whole useful range, including both hand-overs. */
const SAMPLES = (() => {
  const xs: number[] = [];
  for (let ppl = 0; ppl <= 40; ppl += 0.05) xs.push(Number(ppl.toFixed(2)));
  return xs;
})();

test('the weights always sum to one', () => {
  for (const ppl of SAMPLES) {
    const w = lodWeights(ppl);
    const sum = w.overview + w.spans + w.glyphs;
    assert.ok(
      Math.abs(sum - 1) < 1e-9,
      `at ${ppl} px/line the weights sum to ${sum.toFixed(4)}, not 1`,
    );
  }
});

test('no weight leaves the unit range', () => {
  for (const ppl of SAMPLES) {
    for (const [name, v] of Object.entries(lodWeights(ppl))) {
      assert.ok(v >= 0 && v <= 1, `${name} is ${v} at ${ppl} px/line`);
    }
  }
});

test('a representation that has handed over does not come back', () => {
  // The exact failure of the old weights: the texture returned to 0.5 during
  // the tokens-to-text transition.
  let prevOverview = Infinity;
  let prevGlyphs = -Infinity;
  for (const ppl of SAMPLES) {
    const w = lodWeights(ppl);
    assert.ok(w.overview <= prevOverview + 1e-9, `overview rose again at ${ppl}`);
    assert.ok(w.glyphs >= prevGlyphs - 1e-9, `glyphs fell again at ${ppl}`);
    prevOverview = w.overview;
    prevGlyphs = w.glyphs;
  }
});

test('the texture is alone below the first band and gone above it', () => {
  assert.equal(lodWeights(lodBands.tokensFrom - 0.01).overview, 1);
  assert.equal(lodWeights(lodBands.tokensTo + 0.01).overview, 0);
});

test('glyphs are alone above the second band', () => {
  const w = lodWeights(lodBands.textTo + 0.01);
  assert.equal(w.glyphs, 1);
  assert.equal(w.spans, 0);
  assert.equal(w.overview, 0);
});

test('token bars are the only thing between the bands', () => {
  const mid = (lodBands.tokensTo + lodBands.textFrom) / 2;
  const w = lodWeights(mid);
  assert.equal(w.spans, 1);
  assert.equal(w.overview, 0);
  assert.equal(w.glyphs, 0);
});

test('the weights are continuous', () => {
  // A jump would read as a switch rather than a transition. The bound is the
  // steepest a smoothstep can be, 1.5 over the band width, times the sample
  // step, with a little slack: picking a constant instead just encodes the
  // sample rate and fails when either changes.
  const step = 0.05;
  const narrowest = Math.min(
    lodBands.tokensTo - lodBands.tokensFrom,
    lodBands.textTo - lodBands.textFrom,
  );
  const bound = (1.5 / narrowest) * step * 1.05;

  let prev = lodWeights(0);
  for (const ppl of SAMPLES) {
    const w = lodWeights(ppl);
    for (const k of ['overview', 'spans', 'glyphs'] as const) {
      const jump = Math.abs(w[k] - prev[k]);
      assert.ok(
        jump <= bound,
        `${k} jumps by ${jump.toFixed(4)} at ${ppl} px/line, bound ${bound.toFixed(4)}`,
      );
    }
    prev = w;
  }
});

test('the reported name follows the dominant weight', () => {
  assert.equal(lodName(0.5), 'structure');
  assert.equal(lodName(1.5), 'overview');
  assert.equal(lodName((lodBands.tokensTo + lodBands.textFrom) / 2), 'tokens');
  assert.equal(lodName(lodBands.textTo + 1), 'text');
});

test('token bars thin out as glyphs arrive', () => {
  const before = spanBarHeight(lodBands.textFrom - 1);
  const after = spanBarHeight(lodBands.textTo + 1);
  assert.ok(after < before, 'bars should be thinner once text is up');
  assert.ok(after > 0, 'bars must not invert');
});

test('the language tint is exactly the overview texture, and no more', () => {
  // The tint colours the texture, so it lasts as long as the texture does and
  // is gone the moment the token bars have it to themselves. Tied to the same
  // band rather than to numbers of its own, which is what keeps a bar from
  // ever being drawn over a fully tinted texture: the two weights sum to one.
  assert.equal(languageTint(lodBands.tokensFrom), 1);
  assert.equal(languageTint(lodBands.tokensTo), 0);
  for (const ppl of SAMPLES) {
    assert.ok(
      Math.abs(languageTint(ppl) - lodWeights(ppl).overview) < 1e-9,
      `tint ${languageTint(ppl)} against texture ${lodWeights(ppl).overview} at ${ppl}`,
    );
  }
});

test('the language tint is full at the outermost zoom and falls monotonically', () => {
  assert.equal(languageTint(0), 1);
  assert.equal(languageTint(0.1), 1);
  let prev = Infinity;
  for (const ppl of SAMPLES) {
    const t = languageTint(ppl);
    assert.ok(t >= 0 && t <= 1, `tint is ${t} at ${ppl} px/line`);
    assert.ok(t <= prev + 1e-9, `tint rose again at ${ppl} px/line`);
    prev = t;
  }
});

test('a query override is parsed, and nonsense is rejected', () => {
  assert.deepEqual(bandsFromQuery('?lod=2,4,10,14'), {
    tokensFrom: 2,
    tokensTo: 4,
    textFrom: 10,
    textTo: 14,
  });
  // Out of order, crossing, wrong arity, non-numeric, negative.
  for (const bad of ['?lod=4,2,10,14', '?lod=2,12,10,14', '?lod=2,4,10', '?lod=a,b,c,d', '?lod=-1,4,10,14']) {
    assert.equal(bandsFromQuery(bad), null, bad);
  }
  assert.equal(bandsFromQuery('?files=10'), null);
});
