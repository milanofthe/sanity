// Run with: npm test
//
// The golden blob comes from the Rust side:
//   cargo test -p sanity -- --nocapture payload_golden
// If the two ever disagree on the header layout, every file in the repo would
// decode as another file's bytes, which is the kind of bug that looks like a
// renderer problem for a day.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unpack } from './payload.ts';

const GOLDEN =
  '2a000000030000005b5b227372632f612e7273222c345d2c5b22622e7473222c315d2c' +
  '5b22632f642f652e7079222c335d5d0102030409070707';

const fromHex = (hex: string): ArrayBuffer => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes.buffer;
};

test('unpacks the blob the Rust packer produces', () => {
  const map = unpack(fromHex(GOLDEN));
  assert.deepEqual([...map.keys()], ['src/a.rs', 'b.ts', 'c/d/e.py']);
  assert.deepEqual([...new Uint8Array(map.get('src/a.rs')!)], [1, 2, 3, 4]);
  assert.deepEqual([...new Uint8Array(map.get('b.ts')!)], [9]);
  assert.deepEqual([...new Uint8Array(map.get('c/d/e.py')!)], [7, 7, 7]);
});

test('an empty repo unpacks to nothing', () => {
  // Header is the two-byte JSON array `[]`.
  const empty = fromHex('020000000000000' + '05b5d');
  assert.equal(unpack(empty).size, 0);
});

test('a truncated blob is rejected rather than silently short', () => {
  const full = new Uint8Array(fromHex(GOLDEN));
  assert.throws(() => unpack(full.slice(0, 40).buffer), /overruns|trailing|index/);
  assert.throws(() => unpack(new ArrayBuffer(4)), /too short/);
});

test('a count that disagrees with the index is rejected', () => {
  const bytes = new Uint8Array(fromHex(GOLDEN));
  // Claim four entries where the index lists three.
  new DataView(bytes.buffer).setUint32(4, 4, true);
  assert.throws(() => unpack(bytes.buffer), /header says 4/);
});
