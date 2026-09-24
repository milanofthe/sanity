// Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaKey, mediaPath, parseMediaKey } from './mediakey.ts';

test('a key says the file, the version and the page, and gives them back', () => {
  for (const ref of [
    { path: 'docs/plot.png' },
    { path: 'docs/plot.png', version: '1712345678123-40960' },
    { path: 'docs/plot.png', version: 'blob:0123456789abcdef0123456789abcdef01234567' },
    { path: 'paper.pdf', page: 0 },
    { path: 'paper.pdf', version: 'blob:abc', page: 12 },
    // Paths that the old `path#page=n` form could not tell apart.
    { path: 'node_modules/@scope/logo#page=3.png', version: '1-2' },
  ]) {
    const key = mediaKey(ref.path, ref.version, ref.page);
    assert.deepEqual(parseMediaKey(key), ref);
    assert.equal(mediaPath(key), ref.path);
  }
});

test('a picture with neither a version nor a page is keyed by its path', () => {
  assert.equal(mediaKey('a.svg'), 'a.svg');
});

test('another version of the same picture is another key', () => {
  assert.notEqual(mediaKey('a.png', '1-2'), mediaKey('a.png', '3-2'));
  assert.notEqual(mediaKey('a.png', '1-2'), mediaKey('a.png', 'blob:ff'));
});
