// Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { widthCovering } from './wrap.ts';

// Counting has to give what sorting gave, which is what the layout was
// measured with.
test('the width covering a share of the lines is the sorted percentile', () => {
  let s = 7;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let t = 0; t < 200; t++) {
    const n = 1 + Math.floor(rand() * 400);
    const cols = new Uint16Array(n);
    for (let i = 0; i < n; i++) cols[i] = rand() < 0.15 ? 0 : Math.floor(rand() * 180);
    for (const share of [0.5, 0.75, 0.9, 1]) {
      const widths = Array.from(cols).filter((w) => w > 0).sort((a, b) => a - b);
      const want = widths.length ? widths[Math.min(widths.length - 1, Math.floor((widths.length - 1) * share))] : 1;
      assert.equal(widthCovering(Array.from(cols), share), Math.max(1, want));
    }
  }
});
