// Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { levelAt, levelUnder } from './mediatex.ts';

// What a panel of a given width on screen is fetched at. Rounding up meant a
// panel one pixel past a power of two paid for four times the texture it could
// show; rounding down with a quarter of slack means a picture is at worst a
// fifth under its own resolution, which a mip chain turns into softness rather
// than into aliasing.
test('a panel is fetched at the level under its own width', () => {
  assert.equal(levelAt(1), 32);
  assert.equal(levelAt(300), 256);
  assert.equal(levelAt(256), 256);
  assert.equal(levelAt(700), 512);
  assert.equal(levelAt(1e9), 2048);
});

// The floor that rounding down puts under picture quality. Levels are powers
// of two and the slack is a quarter, so the worst case is a level 1.6 times
// under its panel, which is five eighths of the panel's own resolution.
test('a level is never under five eighths of the panel it is drawn in', () => {
  for (let w = 32; w < 2048; w += 13) {
    assert.ok(levelAt(w) * 1.6 >= Math.min(w, 2048), `${w}: ${levelAt(w)}`);
  }
});

test('a ceiling on a picture rounds down to a level', () => {
  assert.equal(levelUnder(700), 512);
  assert.equal(levelUnder(512), 512);
  assert.equal(levelUnder(31), 32);
  assert.equal(levelUnder(1e9), 2048);
});

test('a ceiling is never above the level the same width is fetched at', () => {
  for (let w = 1; w < 4096; w += 7) {
    assert.ok(levelUnder(w) <= levelAt(w), `${w}: ${levelUnder(w)} > ${levelAt(w)}`);
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
