// Squarified treemap (Bruls, Huizing, van Wijk 2000).
//
// Why a treemap and not a rectangle packer: the layout nests, and with nesting
// the packing loss compounds. A shelf packer that wastes half of every
// directory box leaves three percent of the canvas covered after five levels,
// which is what the first version of this file measured. A treemap subdivides
// its rectangle exactly, so there is no loss to compound; the only slack is
// what an individual panel fails to fill inside its own slot.
//
// That works here because a code panel's area is fixed by its line count but
// its shape is not: wrapping the lines into more or fewer columns spans
// aspect ratios from roughly 1:70 to 8:1, so a panel can be fitted into
// whatever slot it is given.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Sized {
  /** Relative weight; only ratios matter, the absolute scale is set by the
   *  enclosing rectangle. */
  area: number;
}

const aspect = (w: number, h: number): number => (w > h ? w / h : h / w);

/**
 * Lay out one row of a squarified treemap and return the worst aspect ratio in
 * it. `sum` is the total weight of the row, `side` the length of the edge the
 * row runs along and `depth` how far it extends.
 */
function worstAspect(areas: number[], sum: number, side: number): number {
  const depth = sum / side;
  let worst = 1;
  for (const a of areas) {
    const len = a / depth;
    const r = aspect(len, depth);
    if (r > worst) worst = r;
  }
  return worst;
}

/**
 * Subdivide `rect` among `items` in proportion to their area. Returns one
 * rectangle per item, in the order given. Items should be sorted by descending
 * area for the classic squarified result; `layoutTreemap` does that for you.
 */
export function squarify<T extends Sized>(items: T[], rect: Rect): Rect[] {
  const out: Rect[] = new Array(items.length);
  if (items.length === 0) return out;

  const total = items.reduce((s, it) => s + it.area, 0);
  if (total <= 0) {
    // Degenerate input: split evenly rather than divide by zero.
    const w = rect.w / items.length;
    items.forEach((_, i) => {
      out[i] = { x: rect.x + i * w, y: rect.y, w, h: rect.h };
    });
    return out;
  }

  // Work in units of the rectangle's own area so the scale cancels out.
  const scale = (rect.w * rect.h) / total;
  let free: Rect = { ...rect };
  let i = 0;

  while (i < items.length) {
    // The row runs along the shorter side, which is what keeps the resulting
    // rectangles close to square.
    const side = Math.min(free.w, free.h);
    const horizontal = free.w <= free.h;

    const row: number[] = [items[i].area * scale];
    let sum = row[0];
    let j = i + 1;
    // Grow the row while doing so improves its worst aspect ratio.
    while (j < items.length) {
      const next = items[j].area * scale;
      const before = worstAspect(row, sum, side);
      const after = worstAspect([...row, next], sum + next, side);
      if (after > before) break;
      row.push(next);
      sum += next;
      j++;
    }

    const depth = sum / side;
    let offset = 0;
    for (let k = 0; k < row.length; k++) {
      const len = row[k] / depth;
      out[i + k] = horizontal
        ? { x: free.x + offset, y: free.y, w: len, h: depth }
        : { x: free.x, y: free.y + offset, w: depth, h: len };
      offset += len;
    }

    if (horizontal) {
      free = { x: free.x, y: free.y + depth, w: free.w, h: Math.max(0, free.h - depth) };
    } else {
      free = { x: free.x + depth, y: free.y, w: Math.max(0, free.w - depth), h: free.h };
    }
    i = j;
  }

  // Floating point can leave slivers; snap the last row flush to the edge.
  for (const r of out) {
    if (Math.abs(r.x + r.w - (rect.x + rect.w)) < 0.51) r.w = rect.x + rect.w - r.x;
    if (Math.abs(r.y + r.h - (rect.y + rect.h)) < 0.51) r.h = rect.y + rect.h - r.y;
  }
  return out;
}

/**
 * Sorts by descending area, subdivides, and hands each item its rectangle.
 * Sorting is what makes a squarified treemap squarified, and it is stable
 * against small edits only because panel areas are quantized upstream: a file
 * has to grow past a whole size step before it can change places.
 */
export function layoutTreemap<T extends Sized>(
  items: T[],
  rect: Rect,
  assign: (item: T, r: Rect) => void,
): void {
  const order = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => b.it.area - a.it.area || a.i - b.i);
  const rects = squarify(order.map((o) => o.it), rect);
  order.forEach((o, k) => assign(o.it, rects[k]));
}
