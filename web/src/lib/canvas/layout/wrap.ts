// Soft wrapping: how many screen rows a file's lines occupy at a given width.
//
// Clipping was the wrong trade. Measured on a real repository, a panel's
// column width cut 18 percent of its lines and lost 19 percent of its
// characters, and what got cut was the ends of the longest lines, which is
// where the arguments, the conditions and the types are. A panel that silently
// drops a fifth of the code is not an overview of it.
//
// Wrapping costs height instead, and that turns out to suit the layout: at
// widths below the mean line length the area is roughly the total character
// count and stops depending on the shape at all, so the treemap's job gets
// easier rather than harder.
//
// Everything here is a pure function of the line widths and a column count,
// so it can be tested without a renderer, and both the layout and the drawing
// passes derive from the same numbers instead of each guessing.

/** Screen rows one source line of `len` characters occupies at `cols` wide. */
export function rowsFor(len: number, cols: number): number {
  if (cols <= 0) return 1;
  // A blank line is still a row.
  return Math.max(1, Math.ceil(len / cols));
}

/** Total screen rows a file occupies at `cols` wide. */
export function visualRows(lineCols: ArrayLike<number>, cols: number): number {
  let total = 0;
  for (let i = 0; i < lineCols.length; i++) total += rowsFor(lineCols[i], cols);
  return total;
}

/**
 * Screen row each source line starts on, plus a terminator.
 *
 * Length is `lineCols.length + 1`, so `offsets[i + 1] - offsets[i]` is the
 * number of rows line `i` takes and `offsets[n]` is the total. Same shape as
 * the span prefix in the wire format, for the same reason: a single array
 * answers both "where does this line start" and "how tall is it".
 */
export function wrapOffsets(lineCols: ArrayLike<number>, cols: number): Uint32Array {
  const n = lineCols.length;
  const out = new Uint32Array(n + 1);
  let row = 0;
  for (let i = 0; i < n; i++) {
    out[i] = row;
    row += rowsFor(lineCols[i], cols);
  }
  out[n] = row;
  return out;
}

/**
 * The source line displayed at a screen row, by binary search over offsets.
 *
 * Needed because the drawing passes walk screen rows: they know which rows are
 * on screen and have to find where in the file that is.
 */
export function lineAtRow(offsets: Uint32Array, row: number): number {
  let lo = 0;
  let hi = offsets.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= row) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * `visualRows` with a one-entry cache per line-width array.
 *
 * The fitting loop asks the same file for its row count at a handful of widths,
 * several passes in a row, and each call walks every line. On a 2500 file
 * repository that showed up as the layout going from 9 to 49 milliseconds.
 * Caching the last answer per file cuts almost all of it, because consecutive
 * passes usually ask about the same width.
 */
const rowCache = new WeakMap<object, Map<number, number>>();

export function visualRowsCached(lineCols: ArrayLike<number>, cols: number): number {
  // Only array-likes that are objects can be keyed; a plain array is one.
  if (typeof lineCols !== 'object') return visualRows(lineCols, cols);
  let per = rowCache.get(lineCols as object);
  if (!per) {
    per = new Map();
    rowCache.set(lineCols as object, per);
  }
  const hit = per.get(cols);
  if (hit !== undefined) return hit;
  const rows = visualRows(lineCols, cols);
  // A file is asked about a few widths at most; a cap keeps a pathological
  // layout from growing an unbounded map.
  if (per.size > 16) per.clear();
  per.set(cols, rows);
  return rows;
}
