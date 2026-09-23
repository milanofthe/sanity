// Run with: npm test
//
// The transform ends in the right place whatever it does on the way, so a
// wrong version looks plausible. These assert the two ends and the shape in
// between.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTo, easeOut, fadeOut, finished, IDENTITY, progress, same, settleIn, slideFrom,
  transformFor, type Rect,
} from './anim.ts';
import { timing } from '../metrics.ts';

const centre = (r: Rect) => [r.x + r.w / 2, r.y + r.h / 2] as const;
const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

test('a slide starts at the old rect', () => {
  const was: Rect = { x: 100, y: 40, w: 200, h: 120 };
  const target: Rect = { x: 500, y: 300, w: 300, h: 90 };
  const anim = slideFrom(was, target);

  const drawn = applyTo(transformFor(target, anim), target);
  const [cx, cy] = centre(drawn);
  const [wx, wy] = centre(was);
  assert.ok(close(cx, wx), `x centre ${cx} should start at ${wx}`);
  assert.ok(close(cy, wy), `y centre ${cy} should start at ${wy}`);
  // Area matched, since a uniform scale cannot match both sides of a rect
  // whose aspect ratio also changed.
  assert.ok(
    close(drawn.w * drawn.h, was.w * was.h, 1e-3),
    `area ${drawn.w * drawn.h} should start at ${was.w * was.h}`,
  );
});

test('a slide ends exactly at the target', () => {
  const was: Rect = { x: 100, y: 40, w: 200, h: 120 };
  const target: Rect = { x: 500, y: 300, w: 300, h: 90 };
  const anim = { ...slideFrom(was, target), t: timing.reflow };

  const drawn = applyTo(transformFor(target, anim), target);
  for (const k of ['x', 'y', 'w', 'h'] as const) {
    assert.ok(close(drawn[k], target[k]), `${k}: ${drawn[k]} should be ${target[k]}`);
  }
  assert.ok(finished(anim));
});

test('a settle keeps the panel centred while it grows', () => {
  const target: Rect = { x: 500, y: 300, w: 300, h: 90 };
  const anim = settleIn(target, 0);

  const start = applyTo(transformFor(target, anim), target);
  const [sx, sy] = centre(start);
  const [tx, ty] = centre(target);
  assert.ok(close(sx, tx), `x centre ${sx} should stay at ${tx}`);
  assert.ok(close(sy, ty), `y centre ${sy} should stay at ${ty}`);
  assert.ok(start.w < target.w, 'it has to start smaller');
  assert.ok(close(start.w, target.w * timing.appearScale));

  // And it is invisible at the start, or it would pop rather than settle.
  assert.equal(transformFor(target, anim).alpha, 0);
});

test('a delay holds the panel at its starting state', () => {
  const target: Rect = { x: 0, y: 0, w: 100, h: 100 };
  const anim = settleIn(target, 0.3);
  assert.equal(progress(anim), 0);
  assert.equal(progress({ ...anim, t: 0.29 }), 0);
  assert.ok(progress({ ...anim, t: 0.3 + timing.appear / 2 }) > 0.4);
  assert.equal(progress({ ...anim, t: 0.3 + timing.appear }), 1);
  assert.ok(!finished({ ...anim, t: 0.29 }));
  assert.ok(finished({ ...anim, t: 0.3 + timing.appear }));
});

test('nothing moves backwards or overshoots', () => {
  const was: Rect = { x: 0, y: 0, w: 400, h: 400 };
  const target: Rect = { x: 1000, y: 0, w: 100, h: 100 };
  const anim = slideFrom(was, target);

  let lastX = -Infinity;
  for (let i = 0; i <= 20; i++) {
    const at = { ...anim, t: (i / 20) * timing.reflow };
    const drawn = applyTo(transformFor(target, at), target);
    assert.ok(drawn.x >= lastX - 1e-6, `x went backwards at ${i}`);
    lastX = drawn.x;
    // Between the two rects, never past either.
    assert.ok(drawn.x >= was.x - 1e-6 && drawn.x <= target.x + 1e-6);
    assert.ok(drawn.w <= was.w + 1e-6 && drawn.w >= target.w - 1e-6);
  }
});

test('an extreme size change is clamped rather than exploding', () => {
  // A one line file becoming a ten thousand line one. Without the clamp the
  // panel would start a hundred times too big and wipe the screen.
  const was: Rect = { x: 0, y: 0, w: 10000, h: 10000 };
  const target: Rect = { x: 0, y: 0, w: 10, h: 10 };
  const anim = slideFrom(was, target);
  assert.ok(anim.s0 <= 4, `scale ${anim.s0} should be clamped`);

  const tiny = slideFrom({ x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 5000, h: 5000 });
  assert.ok(tiny.s0 >= 0.25, `scale ${tiny.s0} should be clamped`);
});

test('the identity transform changes nothing', () => {
  const r: Rect = { x: 3, y: 7, w: 11, h: 13 };
  assert.deepEqual(applyTo(IDENTITY, r), r);
});

test('easing is monotonic and hits both ends', () => {
  assert.equal(easeOut(0), 0);
  assert.equal(easeOut(1), 1);
  let last = -1;
  for (let i = 0; i <= 10; i++) {
    const v = easeOut(i / 10);
    assert.ok(v > last, 'easing has to increase');
    last = v;
  }
});

test('an unmoved panel is recognised so it can animate not at all', () => {
  // The common case, and it has to cost nothing: the median small edit moves
  // no panel at all.
  const r: Rect = { x: 1, y: 2, w: 3, h: 4 };
  assert.ok(same(r, { ...r }));
  assert.ok(!same(r, { ...r, x: 1.5 }));
  assert.ok(!same(r, { ...r, h: 5 }));
});

test('a panel fading out starts where it is and ends invisible, about its centre', () => {
  const r = { x: 100, y: 50, w: 400, h: 200 };
  const a = fadeOut(r);
  const start = transformFor(r, a);
  assert.equal(start.scale, 1);
  assert.equal(start.alpha, 1);
  assert.equal(start.bx, 0);
  a.t = a.dur;
  const end = transformFor(r, a);
  assert.ok(end.alpha < 1e-9, `alpha ${end.alpha}`);
  const drawn = applyTo(end, r);
  // Shrunk, with its centre where it was.
  assert.ok(drawn.w < r.w);
  assert.ok(Math.abs(drawn.x + drawn.w / 2 - (r.x + r.w / 2)) < 1e-9);
  assert.ok(Math.abs(drawn.y + drawn.h / 2 - (r.y + r.h / 2)) < 1e-9);
  // Most of the fade early, out of the way of what slides in.
  a.t = a.dur / 3;
  assert.ok(transformFor(r, a).alpha < 0.5);
});
