// Squarified treemap (Bruls, Huizing, van Wijk 2000), on an integer grid.
//
// Why a treemap and not a rectangle packer: the layout nests, and with nesting
// the packing loss compounds. A shelf packer that wastes half of every
// directory box leaves three percent of the canvas covered after five levels,
// which is what the first version of this file measured. A treemap subdivides
// its rectangle exactly, so there is no loss to compound.
//
// Why an integer grid: a subdivision in floating point tiles exactly in
// arithmetic and not at all visually. Edges land on arbitrary fractions, so
// nothing lines up with anything, and the eye reads the result as scattered
// even at high fill. Snapping every rectangle to a grid whose cell is one line
// height square puts every edge in the layout on the same lattice, and because
// the split remainders are distributed cumulatively rather than rounded
// independently, the tiling stays exact: no gaps, no overlaps.
//
// That works here because a code panel's area is fixed by its line count but
// its shape is not: wrapping the lines into more or fewer columns spans aspect
// ratios from roughly 1:70 to 8:1, so a panel can be fitted into whatever slot
// it is given. See fillSlot in panel.ts.

import { CELL } from '$lib/metrics';

export { CELL };

/** Rectangle in grid cells, all integers. */
export interface IntRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Sized {
  /** Relative weight; only ratios matter, the enclosing rectangle sets scale. */
  area: number;
}

export const toWorld = (r: IntRect): Rect => ({
  x: r.x * CELL,
  y: r.y * CELL,
  w: r.w * CELL,
  h: r.h * CELL,
});

/** Cells needed to cover `units` world units. */
export const cells = (units: number): number => Math.max(1, Math.ceil(units / CELL));

const aspect = (w: number, h: number): number => (w > h ? w / h : h / w);

/** Worst aspect ratio in a row of the given total weight along `side`. */
function worstAspect(areas: number[], sum: number, side: number): number {
  const depth = sum / side;
  let worst = 1;
  for (const a of areas) {
    const r = aspect(a / depth, depth);
    if (r > worst) worst = r;
  }
  return worst;
}

/**
 * Subdivide `rect` among `items` in proportion to their area, in whole cells.
 * Returns one rectangle per item, in the order given.
 */
export function squarify<T extends Sized>(items: T[], rect: IntRect): IntRect[] {
  const out: IntRect[] = new Array(items.length);
  if (items.length === 0) return out;
  if (items.length === 1) {
    out[0] = { ...rect };
    return out;
  }

  const total = items.reduce((s, it) => s + Math.max(0, it.area), 0);
  if (total <= 0) {
    // Degenerate input: split evenly rather than divide by zero.
    let x = rect.x;
    items.forEach((_, i) => {
      const next = rect.x + Math.round(((i + 1) / items.length) * rect.w);
      out[i] = { x, y: rect.y, w: next - x, h: rect.h };
      x = next;
    });
    return out;
  }

  // Work in cell-area units so the scale cancels out.
  const scale = (rect.w * rect.h) / total;
  let free: IntRect = { ...rect };
  let i = 0;

  while (i < items.length) {
    // The row runs along the shorter side, which keeps rectangles near square.
    const side = Math.min(free.w, free.h);
    const horizontal = free.w <= free.h;

    const row: number[] = [Math.max(0, items[i].area) * scale];
    let sum = row[0];
    let j = i + 1;
    // Grow the row while doing so improves its worst aspect ratio.
    while (j < items.length) {
      const next = Math.max(0, items[j].area) * scale;
      if (worstAspect([...row, next], sum + next, side) > worstAspect(row, sum, side)) break;
      row.push(next);
      sum += next;
      j++;
    }

    const across = horizontal ? free.h : free.w;
    const isLast = j >= items.length;
    const after = items.length - j;
    // Depth of at least one cell, and never so deep that the items still to
    // come cannot each get a row of their own. Reserving a single cell for all
    // of them, which is what this did first, let the free region run out with
    // items left over; the final row takes whatever remains so the tiling
    // closes exactly.
    const depth = isLast
      ? across
      : Math.min(Math.max(1, across - after), Math.max(1, Math.round(sum / side)));

    // Positions, not lengths, are rounded: the cumulative fraction is snapped
    // to a cell boundary, so the pieces always add up to `side` exactly.
    let pos = 0;
    let acc = 0;
    for (let k = 0; k < row.length; k++) {
      acc += row[k];
      const isLastInRow = k === row.length - 1;
      const next = isLastInRow ? side : Math.max(pos + 1, Math.round((acc / sum) * side));
      const len = Math.max(1, Math.min(next, side) - pos);
      out[i + k] = horizontal
        ? { x: free.x + pos, y: free.y, w: len, h: depth }
        : { x: free.x, y: free.y + pos, w: depth, h: len };
      pos += len;
    }

    if (horizontal) {
      free = { x: free.x, y: free.y + depth, w: free.w, h: free.h - depth };
    } else {
      free = { x: free.x + depth, y: free.y, w: free.w - depth, h: free.h };
    }
    i = j;
    if (free.w <= 0 || free.h <= 0) {
      // Out of room with items left. The depth reserve above makes this
      // unreachable unless the rectangle has fewer cells than it has items, so
      // it is a genuine shortage rather than an arithmetic slip. Tile the
      // leftovers over the original rectangle's last strip as a plain grid:
      // whatever happens, no two of them may occupy the same cell, because an
      // overlap is a drawing bug that would be far harder to see than a
      // cramped panel.
      gridFallback(items.length - i, rect, out, i);
      break;
    }
  }
  return out;
}

/**
 * Last resort when a rectangle has fewer cells than items: an even grid.
 *
 * Items beyond the cell count get an empty rectangle rather than a shared one.
 * That loses them visually, which is the honest outcome of a slot too small to
 * hold them, and it keeps the no-overlap invariant that the rest of the layout
 * is checked against.
 */
function gridFallback(count: number, rect: IntRect, out: IntRect[], offset: number): void {
  const cellsAvailable = Math.max(0, rect.w * rect.h);
  const cols = Math.max(1, Math.min(rect.w, Math.ceil(Math.sqrt(count))));
  const rows = Math.max(1, Math.ceil(count / cols));
  const cw = Math.max(1, Math.floor(rect.w / cols));
  const ch = Math.max(1, Math.floor(rect.h / rows));
  for (let k = 0; k < count; k++) {
    if (k >= cellsAvailable) {
      out[offset + k] = { x: rect.x, y: rect.y, w: 0, h: 0 };
      continue;
    }
    const cx = k % cols;
    const cy = Math.floor(k / cols);
    out[offset + k] = {
      x: rect.x + cx * cw,
      y: rect.y + Math.min(cy * ch, Math.max(0, rect.h - ch)),
      w: cw,
      h: ch,
    };
  }
}

/**
 * Sorts by descending area, subdivides, and hands each item its rectangle.
 * Sorting is what makes a squarified treemap squarified, and it is stable
 * against small edits only because panel areas are quantized upstream: a file
 * has to grow past a whole size step before it can change places.
 */
export function layoutTreemap<T extends Sized>(
  items: T[],
  rect: IntRect,
  assign: (item: T, r: IntRect) => void,
): void {
  const order = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => b.it.area - a.it.area || a.i - b.i);
  const rects = squarify(order.map((o) => o.it), rect);
  order.forEach((o, k) => assign(o.it, rects[k]));
}
