// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flashAt, markAt, markStep, recent } from './recency.ts';
import { timing } from '../metrics.ts';

test('the flash is full at the moment of the change and gone after it', () => {
  assert.equal(flashAt(0), 1);
  assert.equal(flashAt(timing.flash), 0);
  assert.equal(flashAt(timing.flash + 1), 0);
  assert.equal(flashAt(Infinity), 0);
});

test('the flash falls fastest at the start', () => {
  // Half way through in time, less than half the brightness is left: that is
  // what makes it read as a flash rather than a pulse.
  assert.ok(flashAt(timing.flash / 2) < 0.3);
  let prev = Infinity;
  for (let t = 0; t <= timing.flash; t += timing.flash / 20) {
    const v = flashAt(t);
    assert.ok(v <= prev + 1e-9, `the flash rose again at ${t}`);
    assert.ok(v >= 0 && v <= 1, `the flash is ${v} at ${t}`);
    prev = v;
  }
});

test('the mark is held, then ramps out', () => {
  assert.equal(markAt(0), 1);
  assert.equal(markAt(timing.markHold - timing.markFade), 1);
  assert.equal(markAt(timing.markHold), 0);
  const mid = timing.markHold - timing.markFade / 2;
  assert.ok(Math.abs(markAt(mid) - 0.5) < 1e-9);
});

test('the lines flash longer than the panel', () => {
  // The panel says where, the lines say what, and the what is the one that
  // has to be read: at full strength until the panel's flash is over, then
  // fading, and gone well before it could read as a glow.
  assert.equal(flashAt(timing.flash + 0.1), 0);
  assert.equal(markAt(timing.flash), 1);
  assert.ok(timing.markHold > timing.flash * 2);
  assert.ok(timing.markHold <= 2);
});

test('a file with no change reports nothing', () => {
  assert.equal(flashAt(Infinity), 0);
  assert.equal(markAt(Infinity), 0);
  assert.equal(recent(Infinity), false);
  // Waiting for its turn in a batch is not over.
  assert.equal(recent(-0.1), true);
});

test('recent covers exactly the window something is drawn in', () => {
  assert.equal(recent(0), true);
  assert.equal(recent(timing.markHold - 0.01), true);
  assert.equal(recent(timing.markHold), false);
});

test('the mark steps are monotone and reach both ends', () => {
  assert.equal(markStep(0), 1);
  assert.equal(markStep(timing.markHold), 0);
  let prev = Infinity;
  const seen = new Set<number>();
  for (let t = 0; t <= timing.markHold; t += 0.01) {
    const v = markStep(t);
    assert.ok(v <= prev + 1e-9, `a step rose again at ${t}`);
    prev = v;
    seen.add(v);
  }
  // A frame per step and no more: the point of quantising is the frame count.
  assert.ok(seen.size <= 14, `${seen.size} distinct steps over the hold`);
});
