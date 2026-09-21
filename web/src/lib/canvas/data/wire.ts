// Binary wire format shared between the Rust backend and this renderer.
// The Rust side in src-tauri/src/wire.rs must stay in sync with these
// constants and offsets; there is one test on each side asserting the layout.

export const MAGIC = 0x594e5453; // "SNTY" little endian
export const VERSION = 1;

/** Token kinds. 4 bits, so 16 slots. Language agnostic on purpose: the
 *  overview only needs a coarse visual classification, not a parse tree.
 *
 *  A const object rather than an enum: it erases completely, which keeps it
 *  compatible with isolated modules and with running these files directly
 *  under node's type stripping, and the resulting union type is stricter than
 *  an enum would be. */
export const Kind = {
  Plain: 0,
  Comment: 1,
  DocComment: 2,
  String: 3,
  Number: 4,
  Keyword: 5,
  Type: 6,
  Function: 7,
  Variable: 8,
  Punctuation: 9,
  Constant: 10,
  Attribute: 11,
} as const;
export type Kind = (typeof Kind)[keyof typeof Kind];
export const KIND_COUNT = 12;

/** A line may be up to MAX_COLS columns wide; the rest is clipped. Long lines
 *  are an outlier in real code and clipping keeps the span encoding at 32 bit. */
export const MAX_COLS = 4095;
export const MAX_SPAN_LEN = 1023;

// Span packing: col in bits 0..11, len in bits 12..21, kind in bits 22..25.
export const packSpan = (col: number, len: number, kind: Kind): number =>
  (col & 0xfff) | ((len & 0x3ff) << 12) | ((kind & 0xf) << 22);

export const spanCol = (s: number): number => s & 0xfff;
export const spanLen = (s: number): number => (s >>> 12) & 0x3ff;
export const spanKind = (s: number): Kind => ((s >>> 22) & 0xf) as Kind;

/** Change state of a line, derived from git diff plus the live watcher. */
export const LineState = {
  Unchanged: 0,
  Added: 1,
  Modified: 2,
  /** Lines were removed directly above this one. */
  GapAbove: 3,
  /** Lines were removed directly below this one, which only happens at the end
   *  of a file, where a removal has nothing under it. */
  GapBelow: 4,
} as const;
export type LineState = (typeof LineState)[keyof typeof LineState];

/**
 * Per-file payload. All arrays are tightly packed little endian, in this order:
 *
 *   header      6 x u32   magic, version, lineCount, spanCount, langId, flags
 *   spanStart   (lineCount + 1) x u32   prefix offsets into spans
 *   lineCols    lineCount x u16         visual width of the line in columns
 *   lineIndent  lineCount x u8          leading indent in columns
 *   lineState   lineCount x u8          LineState
 *   spans       spanCount x u32         packSpan
 *
 * The padding between sections keeps every array aligned to its own width so
 * the typed array views can be created without copying.
 */
export interface FileData {
  lineCount: number;
  langId: number;
  flags: number;
  spanStart: Uint32Array;
  lineCols: Uint16Array;
  lineIndent: Uint8Array;
  lineState: Uint8Array;
  spans: Uint32Array;
}

export const FLAG_TRUNCATED = 1 << 0;
export const FLAG_BINARY = 1 << 1;
export const FLAG_NO_GRAMMAR = 1 << 2;

const align = (n: number, to: number): number => (n + to - 1) & ~(to - 1);

export function decodeFile(buf: ArrayBuffer, byteOffset = 0): FileData {
  const head = new Uint32Array(buf, byteOffset, 6);
  if (head[0] !== MAGIC) throw new Error(`bad magic ${head[0].toString(16)}`);
  if (head[1] !== VERSION) throw new Error(`unsupported version ${head[1]}`);
  const lineCount = head[2];
  const spanCount = head[3];

  let o = byteOffset + 24;
  const spanStart = new Uint32Array(buf, o, lineCount + 1);
  o += (lineCount + 1) * 4;
  const lineCols = new Uint16Array(buf, o, lineCount);
  o += align(lineCount * 2, 4);
  const lineIndent = new Uint8Array(buf, o, lineCount);
  o += lineCount;
  const lineState = new Uint8Array(buf, o, lineCount);
  o = align(o + lineCount, 4);
  const spans = new Uint32Array(buf, o, spanCount);

  return {
    lineCount,
    langId: head[4],
    flags: head[5],
    spanStart,
    lineCols,
    lineIndent,
    lineState,
    spans,
  };
}

export function encodeFile(f: FileData): ArrayBuffer {
  const { lineCount } = f;
  const spanCount = f.spans.length;
  let size = 24 + (lineCount + 1) * 4;
  size += align(lineCount * 2, 4) + lineCount * 2;
  size = align(size, 4) + spanCount * 4;

  const buf = new ArrayBuffer(size);
  new Uint32Array(buf, 0, 6).set([MAGIC, VERSION, lineCount, spanCount, f.langId, f.flags]);
  let o = 24;
  new Uint32Array(buf, o, lineCount + 1).set(f.spanStart);
  o += (lineCount + 1) * 4;
  new Uint16Array(buf, o, lineCount).set(f.lineCols);
  o += align(lineCount * 2, 4);
  new Uint8Array(buf, o, lineCount).set(f.lineIndent);
  o += lineCount;
  new Uint8Array(buf, o, lineCount).set(f.lineState);
  o = align(o + lineCount, 4);
  new Uint32Array(buf, o, spanCount).set(f.spans);
  return buf;
}
