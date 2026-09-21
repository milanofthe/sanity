// Run with: npm test
//
// The golden byte string is produced by the Rust side:
//   cargo test -p sanity-core -- --nocapture golden_bytes
// Both tests build the same fixture, so a change to the format that only lands
// on one side fails here rather than showing up as garbled code on screen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLAG_TRUNCATED, Kind, LineState, decodeFile, encodeFile, packSpan,
  spanCol, spanKind, spanLen, type FileData,
} from './wire.ts';

const GOLDEN =
  '53544e5901000000030000000300000003000000010000000000000002000000' +
  '020000000300000' + '00c000000070000' + '000000040100020000003040010480c00004304000';

function fixture(): FileData {
  return {
    lineCount: 3,
    langId: 3,
    flags: FLAG_TRUNCATED,
    spanStart: new Uint32Array([0, 2, 2, 3]),
    lineCols: new Uint16Array([12, 0, 7]),
    lineIndent: new Uint8Array([0, 0, 4]),
    lineState: new Uint8Array([LineState.Added, LineState.Unchanged, LineState.Modified]),
    spans: new Uint32Array([
      packSpan(0, 3, Kind.Keyword),
      packSpan(4, 8, Kind.String),
      packSpan(4, 3, Kind.Comment),
    ]),
  };
}

const hex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

test('span packing roundtrips at the limits', () => {
  for (const [col, len, kind] of [
    [0, 1, Kind.Plain],
    [4095, 1023, Kind.Attribute],
    [137, 42, Kind.Type],
  ] as const) {
    const s = packSpan(col, len, kind);
    assert.equal(spanCol(s), col);
    assert.equal(spanLen(s), len);
    assert.equal(spanKind(s), kind);
  }
});

test('encoding matches the bytes the Rust encoder produces', () => {
  const buf = encodeFile(fixture());
  assert.equal(buf.byteLength, 68, 'encoded length');
  assert.equal(hex(buf), GOLDEN.replaceAll(' ', ''));
});

test('decode is the inverse of encode', () => {
  const f = fixture();
  const back = decodeFile(encodeFile(f));
  assert.equal(back.lineCount, f.lineCount);
  assert.equal(back.langId, f.langId);
  assert.equal(back.flags, f.flags);
  assert.deepEqual([...back.spanStart], [...f.spanStart]);
  assert.deepEqual([...back.lineCols], [...f.lineCols]);
  assert.deepEqual([...back.lineIndent], [...f.lineIndent]);
  assert.deepEqual([...back.lineState], [...f.lineState]);
  assert.deepEqual([...back.spans], [...f.spans]);
});

test('decode rejects a foreign buffer', () => {
  const bad = new ArrayBuffer(64);
  assert.throws(() => decodeFile(bad), /bad magic/);
});

test('an empty file encodes and decodes', () => {
  const empty: FileData = {
    lineCount: 0,
    langId: 0,
    flags: 0,
    spanStart: new Uint32Array([0]),
    lineCols: new Uint16Array(0),
    lineIndent: new Uint8Array(0),
    lineState: new Uint8Array(0),
    spans: new Uint32Array(0),
  };
  const back = decodeFile(encodeFile(empty));
  assert.equal(back.lineCount, 0);
  assert.equal(back.spans.length, 0);
});
