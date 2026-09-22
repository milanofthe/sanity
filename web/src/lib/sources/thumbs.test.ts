// Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { unpackThumbs } from './thumbs.ts';

/** The backend's format, written here so the two ends are pinned together. */
function pack(entries: [string, number[]][]): ArrayBuffer {
  const parts: number[] = [];
  const u32 = (n: number) => parts.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255);
  u32(entries.length);
  for (const [path, data] of entries) {
    const bytes = [...new TextEncoder().encode(path)];
    u32(bytes.length);
    u32(data.length);
    parts.push(...bytes, ...data);
  }
  return new Uint8Array(parts).buffer;
}

test('thumbnails come back keyed by path', () => {
  const got = unpackThumbs(pack([['a/b.png', [1, 2, 3]], ['c.png', [9]]]));
  assert.deepEqual([...got.keys()], ['a/b.png', 'c.png']);
  assert.deepEqual([...new Uint8Array(got.get('a/b.png')!)], [1, 2, 3]);
});

// A file that could not be decoded is sent with no bytes rather than left out,
// so the count and the order stay the same on both ends.
test('a picture with no thumbnail is absent rather than empty', () => {
  const got = unpackThumbs(pack([['broken.png', []], ['fine.png', [7]]]));
  assert.equal(got.has('broken.png'), false);
  assert.deepEqual([...got.keys()], ['fine.png']);
});

test('a truncated buffer gives back what was complete', () => {
  const full = pack([['a.png', [1, 2]], ['b.png', [3, 4]]]);
  const cut = full.slice(0, full.byteLength - 3);
  const got = unpackThumbs(cut);
  assert.deepEqual([...got.keys()], ['a.png']);
});

test('an empty buffer is not an error', () => {
  assert.equal(unpackThumbs(new ArrayBuffer(0)).size, 0);
});
