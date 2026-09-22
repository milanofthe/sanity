// Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { levelFor, levelUnder } from './mediatex.ts';

// The two roundings, which are not the same rounding. A cache held 84 MB in a
// 64 MB budget because one was used for both: a request rounds up, so a
// picture is never drawn from less than it needs, and a ceiling rounds down,
// or it doubles the area it was meant to cap.
test('a request for a picture rounds up to a level', () => {
  assert.equal(levelFor(1), 32);
  assert.equal(levelFor(33), 64);
  assert.equal(levelFor(256), 256);
  assert.equal(levelFor(700), 1024);
  assert.equal(levelFor(1e9), 2048);
});

test('a ceiling on a picture rounds down to a level', () => {
  assert.equal(levelUnder(700), 512);
  assert.equal(levelUnder(512), 512);
  assert.equal(levelUnder(31), 32);
  assert.equal(levelUnder(1e9), 2048);
});

test('a ceiling is never above what the same width would request', () => {
  for (let w = 1; w < 4096; w += 7) {
    assert.ok(levelUnder(w) <= levelFor(w), `${w}: ${levelUnder(w)} > ${levelFor(w)}`);
  }
});

// The budget share is turned into a level with this arithmetic, so what
// decides how many pictures fit is worth pinning down: 64 MB over 47 pictures
// at four bytes a pixel plus a third for the mip chain is 512 a side.
test('a budget share becomes a level that fits inside it', () => {
  const budget = 64 * 1024 * 1024;
  const perPicture = budget / 47;
  const level = levelUnder(Math.sqrt(perPicture / 5.36));
  assert.equal(level, 512);
  assert.ok(level * level * 5.36 < perPicture * 1.1);
});
