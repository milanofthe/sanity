// Stand-in for real file contents while the backend does not exist yet.
// Deterministic, so a line looks the same every time it is drawn, and shaped
// like code so the readable zoom level is a fair test of the glyph pass.

import { Kind, spanCol, spanKind, spanLen, type FileData } from './wire';
import type { TextSource } from '$lib/canvas/renderer/scene';

const WORDS: Record<number, string[]> = {
  [Kind.Keyword]: ['let', 'const', 'fn', 'pub', 'if', 'else', 'for', 'return', 'match', 'impl', 'async', 'await'],
  [Kind.Type]: ['Vec', 'String', 'HashMap', 'Buffer', 'Result', 'Option', 'Layout', 'Camera', 'u32', 'f64'],
  [Kind.Function]: ['render', 'update', 'parse', 'encode', 'insert', 'collect', 'resolve', 'commit', 'flush'],
  [Kind.Variable]: ['index', 'count', 'offset', 'node', 'value', 'state', 'buf', 'ctx', 'slot', 'span', 'line'],
  [Kind.Constant]: ['MAX_COLS', 'NONE', 'DEFAULT', 'TRUE', 'EPSILON'],
  [Kind.Punctuation]: ['(', ')', '{', '}', '=>', '::', ';', ',', '=', '->', '&&', '.'],
  [Kind.Attribute]: ['#[derive]', '@override', '#[inline]'],
  [Kind.Comment]: ['keeps the hot path allocation free', 'see the note in the header', 'fall through on purpose', 'bounds are checked by the caller'],
  [Kind.DocComment]: ['Returns the packed span for this column.', 'Invariants hold across a reflow.'],
};

function hash(s: string, a: number, b: number): number {
  let h = 2166136261 ^ a ^ (b << 16);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

function fill(target: number, pool: string[], r: number): string {
  if (target <= 0) return '';
  let out = pool[Math.floor(r * pool.length) % pool.length];
  let n = 1;
  while (out.length < target) {
    out += ` ${pool[Math.floor(r * 977 * n) % pool.length]}`;
    n++;
  }
  return out.slice(0, target).padEnd(target, ' ');
}

export class PseudoText implements TextSource {
  constructor(private files: Map<string, FileData>) {}

  lineText(path: string, line: number): string | null {
    const f = this.files.get(path);
    if (!f || line >= f.lineCount) return null;
    const s0 = f.spanStart[line];
    const s1 = f.spanStart[line + 1];
    if (s1 === s0) return '';

    let out = '';
    for (let s = s0; s < s1; s++) {
      const p = f.spans[s];
      const col = spanCol(p);
      const len = spanLen(p);
      const kind = spanKind(p);
      if (out.length < col) out = out.padEnd(col, ' ');
      const r = hash(path, line, s);
      if (kind === Kind.Number) {
        out += String(Math.floor(r * 10 ** Math.min(9, len))).padStart(len, '0').slice(0, len);
      } else if (kind === Kind.String) {
        out += `"${fill(Math.max(0, len - 2), WORDS[Kind.Variable], r)}"`.slice(0, len);
      } else {
        out += fill(len, WORDS[kind] ?? WORDS[Kind.Variable], r);
      }
    }
    return out;
  }
}
