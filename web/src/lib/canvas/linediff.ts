// Which lines went away and which arrived, between two versions of a file.
//
// The git line state says where a file differs from a baseline. That is a
// different question from what just changed on screen: after a commit the
// state goes empty while nothing moved, and while editing, a line can be
// Added against HEAD for an hour. To show a change happening, the two versions
// have to be compared against each other.
//
// Myers' diff, the plain O(ND) form. D is the number of differing lines, which
// for a save is a handful, so the middle-snake refinement would be machinery
// for a case that cannot get hot. Past `MAX_EDITS` it gives up and reports the
// whole file, which is the right answer for a checkout anyway.

/** A line reduced to something comparable, cheaply. */
export type Signature = Uint32Array;

export interface LineDiff {
  /** Line indices in the old version that are not in the new one. */
  removed: number[];
  /** Line indices in the new version that were not in the old one. */
  added: number[];
  /** True when the diff gave up and is reporting everything. */
  wholesale: boolean;
}

/**
 * Beyond this many differing lines the answer stops being useful: a change
 * that large is a checkout, and animating four thousand lines individually
 * would say less than replacing the panel.
 */
const MAX_EDITS = 400;

/**
 * A signature per line, from the data the payload already carries.
 *
 * Width plus a rolling hash of the line's spans: two lines with the same
 * length, the same token kinds in the same columns, are the same line as far
 * as an overview is concerned. It cannot see a renamed variable of equal
 * length, and that is the right amount of blindness for something drawn at two
 * pixels a line.
 */
export function signatures(
  lineCount: number,
  lineCols: ArrayLike<number>,
  spanStart: ArrayLike<number>,
  spans: ArrayLike<number>,
): Signature {
  const out = new Uint32Array(lineCount);
  for (let i = 0; i < lineCount; i++) {
    // FNV-1a over the line's width and its spans.
    let h = 0x811c9dc5;
    h = ((h ^ (lineCols[i] & 0xffff)) * 0x01000193) >>> 0;
    const from = spanStart[i];
    const to = spanStart[i + 1];
    for (let s = from; s < to; s++) {
      const v = spans[s];
      h = ((h ^ (v & 0xffff)) * 0x01000193) >>> 0;
      h = ((h ^ (v >>> 16)) * 0x01000193) >>> 0;
    }
    out[i] = h;
  }
  return out;
}

/** Lines shared at the start and end, which a save leaves untouched. */
function trim(a: Signature, b: Signature): [number, number] {
  const n = Math.min(a.length, b.length);
  let head = 0;
  while (head < n && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < n - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return [head, tail];
}

export function diffLines(before: Signature, after: Signature): LineDiff {
  if (before.length === 0 && after.length === 0) {
    return { removed: [], added: [], wholesale: false };
  }

  // The common head and tail are almost the whole file for a normal edit, and
  // stripping them is what keeps D small enough for the simple algorithm.
  const [head, tail] = trim(before, after);
  const aLen = before.length - head - tail;
  const bLen = after.length - head - tail;

  if (aLen === 0 && bLen === 0) {
    return { removed: [], added: [], wholesale: false };
  }
  if (aLen === 0) {
    return {
      removed: [],
      added: Array.from({ length: bLen }, (_, i) => head + i),
      wholesale: false,
    };
  }
  if (bLen === 0) {
    return {
      removed: Array.from({ length: aLen }, (_, i) => head + i),
      added: [],
      wholesale: false,
    };
  }

  const max = aLen + bLen;
  if (max > MAX_EDITS * 4) {
    return whole(before.length, after.length);
  }

  // v[k] is the furthest x reached on diagonal k. Offset because k runs
  // negative. A trace per step, so the path can be walked back.
  const offset = max;
  const v = new Int32Array(2 * max + 1).fill(-1);
  v[offset + 1] = 0;
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const goDown = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]);
      let x = goDown ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < aLen && y < bLen && before[head + x] === after[head + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= aLen && y >= bLen) {
        return walkBack(trace, d, k, offset, head, aLen, bLen);
      }
    }
    if (d > MAX_EDITS) return whole(before.length, after.length);
  }
  return whole(before.length, after.length);
}

function whole(aLen: number, bLen: number): LineDiff {
  return {
    removed: Array.from({ length: aLen }, (_, i) => i),
    added: Array.from({ length: bLen }, (_, i) => i),
    wholesale: true,
  };
}

/** Walk the trace back to the edits themselves. */
function walkBack(
  trace: Int32Array[],
  d: number,
  kEnd: number,
  offset: number,
  head: number,
  aLen: number,
  bLen: number,
): LineDiff {
  const removed: number[] = [];
  const added: number[] = [];
  let x = aLen;
  let y = bLen;
  let k = kEnd;

  for (let step = d; step > 0; step--) {
    const v = trace[step];
    const goDown = k === -step || (k !== step && v[offset + k - 1] < v[offset + k + 1]);
    const kPrev = goDown ? k + 1 : k - 1;
    const xStart = v[offset + kPrev];
    const yStart = xStart - kPrev;
    // The diagonal run at the end of this step is unchanged lines.
    const xMid = goDown ? xStart : xStart + 1;
    const yMid = xMid - k;
    while (x > xMid && y > yMid) {
      x--;
      y--;
    }
    if (goDown) added.push(head + yStart);
    else removed.push(head + xStart);
    x = xStart;
    y = yStart;
    k = kPrev;
  }

  removed.reverse();
  added.reverse();
  return { removed, added, wholesale: false };
}

/**
 * Where each removal leaves a seam in the new version.
 *
 * A removed line is not in the file any more, so after the change there is
 * nothing of it left to mark. What can be marked is the line that now sits
 * where it was, which is what makes a deletion leave a trace instead of simply
 * vanishing. Lines that are themselves additions are left out: a replacement
 * is already marked as an arrival and saying both would say less.
 */
export function seams(diff: LineDiff, oldLen: number, newLen: number): number[] {
  if (diff.removed.length === 0) return [];
  const removed = new Set(diff.removed);
  const added = new Set(diff.added);
  const out: number[] = [];

  let oi = 0;
  let ni = 0;
  while (oi < oldLen || ni < newLen) {
    // Removals before additions, so a replacement is seen at the point where
    // both happen. The other order walks past the arrival first and then
    // blames the line after it, which reported a seam for every replaced line.
    if (oi < oldLen && removed.has(oi)) {
      // The line now standing at this point, clamped for a removal at the end
      // of the file, which has nothing below it.
      const at = Math.min(ni, newLen - 1);
      if (at >= 0 && !added.has(at) && out[out.length - 1] !== at) out.push(at);
      oi++;
      continue;
    }
    if (ni < newLen && added.has(ni)) {
      ni++;
      continue;
    }
    oi++;
    ni++;
  }
  return out;
}
