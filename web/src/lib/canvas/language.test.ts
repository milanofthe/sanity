// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAMILY_COUNT, Family, familyColours, familyOf, familyTints } from './language.ts';

test('every language in the registry has a family', () => {
  // Ids 1 to 19, which is what crates/sanity-core/src/lang.rs defines. A gap
  // here would show up as a file drawn in the unclaimed colour, which looks
  // like a missing grammar rather than a missing table entry.
  for (let id = 1; id <= 19; id++) {
    assert.ok(
      familyOf(id) < FAMILY_COUNT - 1,
      `language ${id} falls through to the unclaimed colour`,
    );
  }
});

test('a file no grammar claimed takes the unclaimed colour', () => {
  assert.equal(familyOf(0), FAMILY_COUNT - 1);
  assert.equal(familyOf(999), FAMILY_COUNT - 1);
});

test('related languages share a colour and unrelated ones do not', () => {
  // The distinction that matters at a distance: source from configuration
  // from prose.
  assert.equal(familyOf(3), familyOf(5), 'typescript and javascript');
  assert.equal(familyOf(6), familyOf(7), 'c and cpp');
  assert.equal(familyOf(9), familyOf(11), 'json and yaml');
  assert.notEqual(familyOf(1), familyOf(9), 'rust and json');
  assert.notEqual(familyOf(12), familyOf(1), 'markdown and rust');
});

test('the colour array covers every family and ends with the dim one', () => {
  const data = [0x111111, 0x222222, 0x333333, 0x444444, 0x555555, 0x666666];
  const colours = familyColours(data, 0x0a0a0a);
  assert.equal(colours.length, FAMILY_COUNT);
  assert.equal(colours[colours.length - 1], 0x0a0a0a);
  for (let i = 0; i < FAMILY_COUNT - 1; i++) {
    assert.equal(colours[i], data[i], `family ${i}`);
  }
  // Every family index the table can produce has to land inside the array.
  for (let id = 0; id <= 20; id++) {
    assert.ok(colours[familyOf(id)] !== undefined, `id ${id}`);
  }
});

test('a palette with fewer hues than families still covers them', () => {
  // The sanity theme's data slots are values rather than hues, and a theme
  // could define fewer. Wrapping is better than an undefined colour.
  const colours = familyColours([0xaa0000, 0x00aa00], 0x0a0a0a);
  assert.equal(colours.length, FAMILY_COUNT);
  for (const c of colours) assert.equal(typeof c, 'number');
});

test('the family enum and the count agree', () => {
  const highest = Math.max(
    Family.Systems, Family.Scripting, Family.Web,
    Family.Data, Family.Prose, Family.Hardware,
  );
  assert.equal(highest, FAMILY_COUNT - 2, 'the unclaimed slot is the last one');
});

test('a tint holds its family hue and the texture luminance', () => {
  const tints = familyTints([0x6699cc]);
  // What the shader computes is the tint vector times the texel's luminance.
  // A texel at luminance L has to come back at L, in the family's own hue:
  // that is the whole property, and it is what keeps the canvas at its
  // exposure while the colour changes.
  for (const lum of [0.05, 0.2, 0.5]) {
    const out = [tints[0] * lum, tints[1] * lum, tints[2] * lum];
    const got = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
    assert.ok(Math.abs(got - lum) < 1e-6, `luminance ${lum} came back as ${got}`);
    // And the hue is unchanged: the channels keep their ratios.
    assert.ok(Math.abs(out[2] / out[0] - 0xcc / 0x66) < 1e-6, 'the hue moved');
  }
});
