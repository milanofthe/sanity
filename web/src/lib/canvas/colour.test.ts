// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atLuminance, bandColour, luminance, mixToward, pack, rgb } from './colour.ts';

const CHARCOAL = 0x1e2124;
const NEAR_WHITE = 0xf4f5f6;
const RED = 0xff0000;
const PAPER = 0xfafafa;

test('packing and unpacking round trip', () => {
  for (const hex of [0x000000, 0xffffff, CHARCOAL, RED, 0x123456]) {
    const [r, g, b] = rgb(hex);
    assert.equal(pack(r, g, b), hex);
  }
});

test('luminance orders colours the way eyes do', () => {
  assert.ok(luminance(0x000000) === 0);
  assert.ok(Math.abs(luminance(0xffffff) - 1) < 1e-9);
  assert.ok(luminance(CHARCOAL) < luminance(RED));
  assert.ok(luminance(RED) < luminance(NEAR_WHITE));
});

test('a colour can be set to a luminance in either direction', () => {
  for (const want of [0.05, 0.2, 0.5, 0.8]) {
    for (const hex of [RED, NEAR_WHITE, CHARCOAL, 0x3aa0ff]) {
      const got = luminance(atLuminance(hex, want));
      assert.ok(Math.abs(got - want) < 0.02, `${hex.toString(16)} to ${want}: got ${got}`);
    }
  }
});

test('setting a luminance keeps a hue recognisable', () => {
  // Red darkened stays red. Without the two directions it would either clip to
  // white or wash out.
  const dark = rgb(atLuminance(RED, 0.1));
  assert.ok(dark[0] > dark[1] && dark[0] > dark[2], 'still red');
  const light = rgb(atLuminance(RED, 0.8));
  assert.ok(light[0] >= light[1] && light[0] >= light[2], 'still reddest in red');
});

test('mixToward does not change how light something is', () => {
  // The property it exists for: a directory tint takes a hue without the frame
  // getting brighter than the background.
  const base = CHARCOAL;
  for (const target of [NEAR_WHITE, RED, 0x3aa0ff]) {
    for (const amount of [0.2, 0.55, 1]) {
      const got = luminance(mixToward(base, target, amount));
      assert.ok(
        Math.abs(got - luminance(base)) < 0.02,
        `${target.toString(16)} at ${amount}: luminance moved to ${got}`,
      );
    }
  }
});

test('mixToward at zero is the base itself', () => {
  assert.equal(mixToward(CHARCOAL, RED, 0), CHARCOAL);
});

test('a band is visible whatever the change colour is', () => {
  // The failure this replaces: a near white added colour on a charcoal panel
  // gave a band with no contrast at all, because the luminance was matched to
  // the panel before mixing. Every colour has to produce a visible band.
  for (const change of [NEAR_WHITE, RED, 0x33cc55, CHARCOAL]) {
    const band = bandColour(CHARCOAL, change, 0.4);
    const step = luminance(band) - luminance(CHARCOAL);
    assert.ok(step > 0.02, `${change.toString(16)} produced a step of only ${step.toFixed(4)}`);
  }
});

test('a band never blows out, so the code on it stays readable', () => {
  // The other failure: pure red at a raised luminance is still fully
  // saturated red, and a band of it swallows the text. Saturation and
  // brightness are different things and both have to be held down.
  for (const change of [RED, 0x00ff00, 0xffff00, NEAR_WHITE]) {
    const band = bandColour(CHARCOAL, change, 0.4);
    const step = luminance(band) - luminance(CHARCOAL);
    assert.ok(step < 0.2, `${change.toString(16)} produced a step of ${step.toFixed(3)}`);
    // And it has to stay nearer the panel than the code drawn on it, which in
    // every theme here is well above half.
    assert.ok(luminance(band) < 0.45, `${change.toString(16)} reached ${luminance(band)}`);
  }
});

test('a band on a light panel goes darker, with no second rule', () => {
  for (const change of [NEAR_WHITE, RED]) {
    const band = bandColour(PAPER, change, 0.4);
    assert.ok(
      luminance(band) < luminance(PAPER) - 0.02,
      `${change.toString(16)}: ${luminance(band)} against panel ${luminance(PAPER)}`,
    );
  }
});

test('a band keeps the change colour apart from another', () => {
  // Removal and addition have to be told apart at a glance, on any panel.
  for (const panel of [CHARCOAL, PAPER]) {
    const del = rgb(bandColour(panel, RED, 0.35));
    const add = rgb(bandColour(panel, 0x33cc55, 0.35));
    assert.ok(del[0] > del[1], `removal reads red on ${panel.toString(16)}`);
    assert.ok(add[1] > add[0], `addition reads green on ${panel.toString(16)}`);
  }
});

test('band strength is monotonic and bounded', () => {
  let last = luminance(CHARCOAL);
  for (const s of [0, 0.05, 0.12, 0.4, 0.6, 1]) {
    const l = luminance(bandColour(CHARCOAL, NEAR_WHITE, s));
    assert.ok(l >= last - 1e-9, `strength ${s} went backwards`);
    assert.ok(l <= 1.000001, `strength ${s} exceeded white`);
    last = l;
  }
  assert.equal(bandColour(CHARCOAL, RED, 0), CHARCOAL);
});

test('a stronger band is further from the panel than a weaker one', () => {
  // What the animation relies on: the change starts strong and settles to the
  // standing mark, and that has to be a visible difference.
  const standing = luminance(bandColour(CHARCOAL, RED, 0.12));
  const changing = luminance(bandColour(CHARCOAL, RED, 0.4));
  assert.ok(changing > standing + 0.01, `${changing} should be well above ${standing}`);
});
