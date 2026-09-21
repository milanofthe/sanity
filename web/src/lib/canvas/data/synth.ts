// Synthetic repository generator, used to prove out the renderer before the
// Rust backend exists and to stress it far past any real repo. It emits the
// exact same wire format the backend will, so nothing here is throwaway.

import { Kind, LineState, encodeFile, packSpan, type FileData } from './wire';
import type { FileEntry } from '$lib/canvas/layout/tree';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIR_WORDS = [
  'src', 'core', 'web', 'api', 'lib', 'util', 'model', 'view', 'render',
  'parse', 'net', 'store', 'test', 'bench', 'crates', 'internal', 'cmd',
  'config', 'proto', 'schema', 'ui', 'hooks', 'solver', 'mesh', 'io',
];
const FILE_WORDS = [
  'index', 'main', 'mod', 'engine', 'buffer', 'stream', 'context', 'session',
  'handler', 'router', 'client', 'server', 'cache', 'queue', 'worker', 'pool',
  'matrix', 'vector', 'graph', 'node', 'edge', 'token', 'lexer', 'ast',
  'layout', 'atlas', 'shader', 'camera', 'panel', 'watcher', 'diff',
];
const EXTS = ['ts', 'rs', 'py', 'go', 'c', 'h', 'tsx', 'json', 'toml', 'md'];

/** Rough weighting of token kinds inside a line of code. */
const BODY_KINDS: Kind[] = [
  Kind.Variable, Kind.Variable, Kind.Variable, Kind.Punctuation, Kind.Punctuation,
  Kind.Function, Kind.Type, Kind.Keyword, Kind.String, Kind.Number, Kind.Constant,
];

export interface SynthOptions {
  fileCount: number;
  seed?: number;
  /** Median line count; the distribution is log-normal around it. */
  medianLines?: number;
  /** Fraction of lines marked as changed, to exercise the change overlay. */
  changedFraction?: number;
}

/**
 * Width a panel should be built for: the 90th percentile of line lengths, not
 * the maximum.
 *
 * The maximum is set by a single outlier, and a panel sized to it is mostly
 * empty: measured on generated repos, the widest line ran three times the
 * median, so two thirds of every panel was blank and the canvas read as full
 * of holes. Clipping the longest tenth of lines costs far less than that.
 */
export function widthPercentile(lineCols: ArrayLike<number>, p = 0.9): number {
  const n = lineCols.length;
  if (n === 0) return 1;
  const sorted = Array.from(lineCols as ArrayLike<number>).sort((a, b) => a - b);
  // Ignore blank lines: they would drag the percentile down without making any
  // panel narrower in a useful way.
  let first = 0;
  while (first < n && sorted[first] === 0) first++;
  if (first >= n) return 1;
  const idx = first + Math.floor((n - first - 1) * p);
  return Math.max(1, sorted[idx]);
}

export interface SynthRepo {
  entries: FileEntry[];
  payloads: Map<string, ArrayBuffer>;
  totalLines: number;
}

function generatePaths(rand: () => number, count: number): string[] {
  const paths = new Set<string>();
  // A handful of directory prefixes of varying depth, reused across files, so
  // the tree looks like a real project rather than a uniform fan-out.
  const prefixes: string[] = [''];
  while (prefixes.length < Math.max(6, Math.ceil(count / 9))) {
    const base = prefixes[Math.floor(rand() * prefixes.length)];
    const word = DIR_WORDS[Math.floor(rand() * DIR_WORDS.length)];
    const next = base ? `${base}/${word}` : word;
    if (next.split('/').length <= 5) prefixes.push(next);
  }

  let guard = 0;
  while (paths.size < count && guard++ < count * 40) {
    const dir = prefixes[Math.floor(rand() * prefixes.length)];
    const name = FILE_WORDS[Math.floor(rand() * FILE_WORDS.length)];
    const ext = EXTS[Math.floor(rand() * EXTS.length)];
    const suffix = rand() < 0.35 ? `_${Math.floor(rand() * 40)}` : '';
    paths.add(dir ? `${dir}/${name}${suffix}.${ext}` : `${name}${suffix}.${ext}`);
  }
  return [...paths];
}

function generateFile(rand: () => number, lineCount: number, changedFraction: number): {
  data: FileData;
  maxCols: number;
} {
  const spanStart = new Uint32Array(lineCount + 1);
  const lineCols = new Uint16Array(lineCount);
  const lineIndent = new Uint8Array(lineCount);
  const lineState = new Uint8Array(lineCount);
  const spans: number[] = [];

  let indent = 0;
  // Changes come in runs, the way a real edit does.
  let changeRun = 0;

  for (let i = 0; i < lineCount; i++) {
    spanStart[i] = spans.length;

    // Indentation as a bounded random walk, which is what gives the overview
    // its recognisable texture.
    const r = rand();
    if (r < 0.18) indent = Math.min(8, indent + 1);
    else if (r < 0.34) indent = Math.max(0, indent - 1);
    else if (r < 0.37) indent = 0;
    const ind = indent * 2;
    lineIndent[i] = ind;

    if (changeRun > 0) {
      changeRun--;
      lineState[i] = rand() < 0.6 ? LineState.Modified : LineState.Added;
    } else if (rand() < changedFraction / 6) {
      changeRun = 2 + Math.floor(rand() * 8);
    }

    if (rand() < 0.12) {
      // Blank line.
      lineCols[i] = 0;
      continue;
    }

    if (rand() < 0.11) {
      // Whole-line comment.
      const len = 10 + Math.floor(rand() * 50);
      spans.push(packSpan(ind, len, rand() < 0.3 ? Kind.DocComment : Kind.Comment));
      lineCols[i] = ind + len;
    } else {
      // A line of code: a few tokens separated by single spaces.
      let col = ind;
      const tokens = 2 + Math.floor(rand() * 7);
      for (let t = 0; t < tokens; t++) {
        const kind =
          t === 0 && rand() < 0.4
            ? Kind.Keyword
            : BODY_KINDS[Math.floor(rand() * BODY_KINDS.length)];
        const len =
          kind === Kind.String
            ? 4 + Math.floor(rand() * 28)
            : kind === Kind.Punctuation
              ? 1 + Math.floor(rand() * 2)
              : 2 + Math.floor(rand() * 12);
        spans.push(packSpan(col, len, kind));
        col += len + 1;
        if (col > 200) break;
      }
      lineCols[i] = col > ind ? col - 1 : ind;
    }
  }
  spanStart[lineCount] = spans.length;

  return {
    data: {
      lineCount,
      langId: 0,
      flags: 0,
      spanStart,
      lineCols,
      lineIndent,
      lineState,
      spans: new Uint32Array(spans),
    },
    maxCols: widthPercentile(lineCols),
  };
}

export function synthRepo(opts: SynthOptions): SynthRepo {
  const rand = mulberry32(opts.seed ?? 1);
  const median = opts.medianLines ?? 180;
  const changed = opts.changedFraction ?? 0.02;
  const paths = generatePaths(rand, opts.fileCount);

  const entries: FileEntry[] = [];
  const payloads = new Map<string, ArrayBuffer>();
  let totalLines = 0;

  for (const path of paths) {
    // Log-normal line counts: lots of small files, a few very large ones.
    const u = Math.max(1e-6, rand());
    const v = Math.max(1e-6, rand());
    const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const lineCount = Math.max(4, Math.min(24000, Math.round(median * Math.exp(normal * 1.05))));

    const { data, maxCols } = generateFile(rand, lineCount, changed);
    payloads.set(path, encodeFile(data));
    entries.push({ path, lineCount, maxCols });
    totalLines += lineCount;
  }

  return { entries, payloads, totalLines };
}
