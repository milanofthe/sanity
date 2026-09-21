// Run with: npm test
//
// The canvas takes the window's proportions so that fitting it leaves no
// screen unused. The fraction of the window a fitted canvas covers is
// min(a / v, v / a) for canvas aspect a and window aspect v, which is 1 only
// when they agree: a fixed 16:9 canvas covered 67 percent of a 1200x1000
// window and there was nothing the camera could do about it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Fraction of the window a fitted canvas covers. */
const coverage = (canvasAspect: number, windowAspect: number): number =>
  Math.min(canvasAspect / windowAspect, windowAspect / canvasAspect);

/** Mirrors rootAspect in tree.ts. */
const ROOT_ASPECT_MIN = 0.8;
const ROOT_ASPECT_MAX = 3.2;
const rootAspect = (w: number, h: number): number =>
  Math.min(ROOT_ASPECT_MAX, Math.max(ROOT_ASPECT_MIN, w / h));

test('matching the window covers all of it', () => {
  for (const [w, h] of [[1600, 900], [1400, 900], [1200, 1000], [2560, 1080]] as const) {
    const a = rootAspect(w, h);
    assert.ok(
      coverage(a, w / h) > 0.999,
      `${w}x${h}: canvas ${a.toFixed(2)} covers only ${(coverage(a, w / h) * 100).toFixed(1)}%`,
    );
  }
});

test('a fixed aspect wastes screen on any other window', () => {
  // The state this replaced, kept as a statement of what was wrong.
  const fixed = 16 / 9;
  assert.ok(coverage(fixed, 1200 / 1000) < 0.7);
  assert.ok(coverage(fixed, 2560 / 1080) < 0.8);
});

test('the clamp bounds how extreme the canvas can get', () => {
  // A very tall window still gets a navigable canvas rather than a ribbon.
  assert.equal(rootAspect(900, 1200), ROOT_ASPECT_MIN);
  assert.equal(rootAspect(4000, 600), ROOT_ASPECT_MAX);
  // And the clamp is the only reason coverage is ever below one.
  assert.ok(coverage(rootAspect(900, 1200), 900 / 1200) > 0.85);
});
