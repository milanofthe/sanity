// Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { INTRO_S, MAX_STEP_S, MIN_STEP_S, OUTRO_S, planReplay } from './video.ts';

test('a long history is played in the time asked for, several commits a step', () => {
  // The ticker's list is newest first: from 999, the oldest, to 0.
  const p = planReplay(999, 0, 60, 60);
  assert.equal(p.start, 999);
  assert.equal(p.targets.at(-1), 0, 'ends on the newest');
  for (let i = 1; i < p.targets.length; i++) assert.ok(p.targets[i] < p.targets[i - 1], 'always forwards');
  assert.ok(p.targets[0] < 999);
  assert.equal(p.targets.length, Math.floor((60 - INTRO_S - OUTRO_S) / MIN_STEP_S));
  assert.ok(Math.abs(p.seconds - 60) < 0.5, `${p.seconds} s`);
  assert.equal(p.frames, p.introFrames + p.targets.length * p.stepFrames + p.outroFrames);
});

test('a short history steps through every commit and does not stretch', () => {
  const p = planReplay(4, 0, 60, 60);
  assert.deepEqual(p.targets, [3, 2, 1, 0]);
  assert.equal(p.stepFrames, MAX_STEP_S * 60);
  assert.ok(p.seconds < 60);
});

test('a range that is not the whole history ends where it says', () => {
  const p = planReplay(120, 30, 20, 30);
  assert.equal(p.start, 120);
  assert.equal(p.targets.at(-1), 30);
  assert.ok(p.targets.every((t) => t >= 30 && t < 120));
  assert.equal(new Set(p.targets).size, p.targets.length, 'no step to where it already is');
});

test('a range of one commit is a still', () => {
  const p = planReplay(0, 0, 60, 60);
  assert.deepEqual(p.targets, []);
  assert.equal(p.frames, p.introFrames + p.outroFrames);
});
