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
//
// Why not measure sizes bottom up and place once, which would avoid the
// correction passes in tree.ts entirely: it was built and measured, and it
// fills 3 to 30 percent of the canvas against this one's 85 to 99. The
// difference is structural rather than a matter of tuning. A treemap
// *subdivides*, so the only waste is what a panel fails to fill inside its own
// slot. Row packing *stacks*, so every row adds the gap under each item whose
// height does not exactly match the row's, and with nesting that compounds the
// same way the shelf packer's loss did. Measured, on the seven repository
// shapes in scripts/layout-check.mjs:
//
//   400 files:  94.5% subdivided, 15.2% stacked
//   2500 files: 97.7% subdivided,  6.2% stacked
//
// The correction passes are the price, and they are cheap: two to six for a
// realistic repository, under ten milliseconds in total.

// Through a relative path with its extension, not the `$lib` alias: the tests
// run on node's own type stripping, which resolves neither. Same reason as in
// anim.ts.
import { CELL } from '../../metrics.ts';

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
  /**
   * Smallest extent the item can be drawn at, in cells. Omitted means none.
   *
   * A treemap on its own has no notion of this: it divides area, and an item
   * with a thousandth of the total gets a thousandth whatever shape that is.
   * A panel is not like that. Below about two dozen characters of width there
   * is no point drawing it at all, and that floor does not scale with the
   * file's size, so the smallest files are exactly the ones a plain
   * subdivision cannot serve.
   *
   * Borrowed from how flexbox resolves flexible lengths: distribute
   * proportionally, then freeze whatever hit its minimum and share the rest
   * out again among the others. Bounded, and it never overshoots, where
   * feeding the shortfall back into the weights and re-running the whole
   * subdivision compounds and does.
   */
  minW?: number;
  minH?: number;
  /**
   * Widest shape the item can take, as width over height. Omitted means any.
   *
   * Also not something a treemap would ask about, and the reason the fitting
   * loop used to buy enormous slots. A panel may wrap its lines into at most
   * a fixed number of code columns, so a tall file simply cannot fill a wide
   * slot: measured on 200 files of 4000 lines, 94 of them missed their shape
   * on the first pass and the correction bought the whole canvas 4.4 times the
   * area it needed.
   *
   * The bound belongs where the rectangles are cut, not in a loop that reacts
   * afterwards.
   *
   * There is a matching bound at the other end, the tallest shape an item can
   * take, and it is deliberately not here. It was built and measured: it takes
   * the worst panel in the layout from 7.4 times the area it needs down to
   * 3.5, and it costs one panel in 800 that comes out too narrow to read,
   * because which column count a panel takes is a discrete choice and the two
   * bounds together leave no shape it can use. Tracked as an issue rather than
   * shipped half working.
   */
  maxAspect?: number;
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
 * Split `side` cells among `areas`, proportionally, but no member below its
 * minimum. Returns whole cells that add up to `side` exactly.
 *
 * This is flexbox's "resolving flexible lengths" with the flex factors being
 * the areas: hand out the space in proportion, freeze everything that came out
 * under its minimum at exactly that minimum, and share what is left among the
 * rest. Each round freezes at least one member, so it ends in at most n
 * rounds, and nothing ever gets more than its proportional share of what
 * remains, which is what keeps it from overshooting the way a feedback loop on
 * the weights does.
 *
 * Whole cells, and computed here rather than by rounding afterwards. Rounding
 * a cumulative fraction is what the rest of this file does to keep a tiling
 * exact, and it shaves a cell off whatever it likes: measured, it took a panel
 * frozen at its 14 cell minimum down to 13, which is below the width at which
 * there is any point drawing it. So the minimums are integers, the surplus is
 * handed out by largest remainder, and a repair pass moves cells from the
 * items that have spare ones to any item still under its floor.
 *
 * When the minimums alone exceed `side` there is no arrangement that works,
 * and the honest answer is to hand out the minimums scaled down to fit: the
 * items are then too small to draw, which the layout reports and corrects by
 * asking for a bigger rectangle, and in the meantime nothing overlaps.
 */
export function distribute(areas: number[], side: number, mins: number[]): number[] {
  const n = areas.length;
  const out = new Array<number>(n).fill(0);
  if (n === 0) return out;
  const floors = mins.map((m) => Math.max(1, Math.ceil(m)));

  const minTotal = floors.reduce((s, m) => s + m, 0);
  if (minTotal > side) {
    // Infeasible: proportional to the minimums, at least one cell each while
    // there are cells left.
    return wholeCells(floors, side, new Array<number>(n).fill(1));
  }

  // Flexbox's freeze-and-redistribute, in real numbers.
  const want = new Array<number>(n).fill(0);
  const frozen = new Array<boolean>(n).fill(false);
  let free = side;
  for (;;) {
    let pool = 0;
    for (let i = 0; i < n; i++) if (!frozen[i]) pool += Math.max(0, areas[i]);

    let hit = false;
    for (let i = 0; i < n; i++) {
      if (frozen[i]) continue;
      const share = pool > 0 ? (Math.max(0, areas[i]) / pool) * free : free / n;
      if (share < floors[i]) {
        frozen[i] = true;
        want[i] = floors[i];
        free -= floors[i];
        hit = true;
      }
    }
    if (hit) continue;

    for (let i = 0; i < n; i++) {
      if (frozen[i]) continue;
      want[i] = pool > 0 ? (Math.max(0, areas[i]) / pool) * free : free / n;
    }
    break;
  }

  return wholeCells(want, side, floors);
}

/**
 * Round real lengths to whole cells that sum to `side`, respecting `floors`.
 *
 * Largest remainder first, then repair: while something is below its floor,
 * take a cell from the item furthest above its own floor. Each repair moves
 * one cell and strictly reduces the shortfall, so it ends.
 */
function wholeCells(want: number[], side: number, floors: number[]): number[] {
  const n = want.length;
  const out = new Array<number>(n);
  const total = want.reduce((s, v) => s + Math.max(0, v), 0);
  const scaled = want.map((v) => (total > 0 ? (Math.max(0, v) / total) * side : side / n));

  let used = 0;
  for (let i = 0; i < n; i++) {
    out[i] = Math.floor(scaled[i]);
    used += out[i];
  }
  // Hand the remaining cells to the largest fractional parts.
  const order = scaled
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; used < side && k < order.length * 2; k++) {
    out[order[k % order.length].i]++;
    used++;
  }
  // And take back any it could not afford, from the largest first.
  while (used > side) {
    let pick = -1;
    for (let i = 0; i < n; i++) if (out[i] > 1 && (pick < 0 || out[i] > out[pick])) pick = i;
    if (pick < 0) break;
    out[pick]--;
    used--;
  }

  for (;;) {
    let short = -1;
    for (let i = 0; i < n; i++) if (out[i] < floors[i]) { short = i; break; }
    if (short < 0) return out;
    let donor = -1;
    let best = 0;
    for (let i = 0; i < n; i++) {
      const spare = out[i] - floors[i];
      if (spare > best) {
        best = spare;
        donor = i;
      }
    }
    // Nobody has a spare cell: the floors cannot all be met, which `distribute`
    // has already reported by falling through to the infeasible branch. Leave
    // the rest as they are rather than looping forever.
    if (donor < 0) return out;
    out[donor]--;
    out[short]++;
  }
}

/**
 * Depth a row must have, and may have at most, for its members to be drawable.
 *
 * A row's members all share its depth. In a horizontal row that depth is their
 * height and their length is their width, so a member that must not come out
 * wider than `maxAspect` needs the row to be *deeper*: its length is
 * area / depth, and length / depth <= maxAspect rearranges to
 * depth >= sqrt(area / maxAspect). A vertical row is the mirror image, and the
 * same bound turns into a ceiling on the depth instead.
 *
 * So the row-growing loop has a reason to keep going beyond the aspect
 * heuristic, or to stop before it: a row too shallow for one of its members is
 * not a matter of taste, it is a panel that cannot be drawn.
 */
function depthRange<T extends Sized>(
  items: T[], from: number, to: number, scale: number, horizontal: boolean,
): { min: number; max: number } {
  let min = 1;
  let max = Infinity;
  for (let i = from; i < to; i++) {
    const it = items[i];
    const area = Math.max(0, it.area) * scale;
    const thick = horizontal ? it.minH : it.minW;
    if (thick && thick > min) min = thick;
    const wide = it.maxAspect;
    if (wide && wide > 0 && Number.isFinite(wide)) {
      // Widest shape: a floor on a horizontal row's depth, a ceiling on a
      // vertical one's.
      if (horizontal) {
        const need = Math.sqrt(area / wide);
        if (need > min) min = need;
      } else {
        const cap = Math.sqrt(area * wide);
        if (cap < max) max = cap;
      }
    }
  }
  // Where the two disagree the floor wins: a rectangle too narrow to draw is
  // worse than one shaped differently than its content would like. Resolving
  // it the other way round, which is what this did first, took a panel's depth
  // below its minimum width to satisfy another member's aspect, and the
  // correction loop then could not rescue it with any amount of area, because
  // the shape was what bound it. One panel out of 800 came out undrawable that
  // way, through forty passes.
  return { min, max: Math.max(min, max) };
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

  // Work in cell-area units so the scale cancels out. Recomputed after every
  // row from the region and the weights that are left, which is what keeps the
  // proportions honest when a row takes more or less than its share: the depth
  // bounds mean a row does not always get exactly the depth its weight asks
  // for, and without this the difference accumulated and landed on whichever
  // item happened to be last. Measured, a 147 line file came out with a slot
  // 165 times the area it needed that way.
  let scale = (rect.w * rect.h) / total;
  let left = total;
  let free: IntRect = { ...rect };
  let i = 0;

  while (i < items.length) {
    // The row runs along the shorter side, which keeps rectangles near square.
    const side = Math.min(free.w, free.h);
    const horizontal = free.w <= free.h;

    const row: number[] = [Math.max(0, items[i].area) * scale];
    let sum = row[0];
    let j = i + 1;
    // Grow the row while doing so improves its worst aspect ratio, or while it
    // is still too shallow for one of its members to be drawn. The second
    // reason overrides the first: the aspect heuristic is about how the canvas
    // looks, the depth bounds are about whether a panel exists.
    // How much of `side` the row's members need at their minimum, which is the
    // hard limit on how many can share a row. Without this the row grew on the
    // aspect heuristic alone, the minimums no longer fitted, and `distribute`
    // had to scale them all down: measured on 800 files of twelve lines, two
    // panels came out too narrow to draw.
    let minRun = Math.max(1, (horizontal ? items[i].minW : items[i].minH) ?? 1);
    while (j < items.length) {
      const next = Math.max(0, items[j].area) * scale;
      const nextMin = Math.max(1, (horizontal ? items[j].minW : items[j].minH) ?? 1);
      if (minRun + nextMin > side) break;
      const bounds = depthRange(items, i, j, scale, horizontal);
      const shallow = sum / side < bounds.min;
      if (!shallow) {
        if (worstAspect([...row, next], sum + next, side) > worstAspect(row, sum, side)) break;
        // A deeper vertical row makes every member wider, so growing it can
        // push one past the widest shape it is able to take.
        const grown = depthRange(items, i, j + 1, scale, horizontal);
        if (!horizontal && (sum + next) / side > grown.max) break;
      }
      row.push(next);
      sum += next;
      minRun += nextMin;
      j++;
    }

    const across = horizontal ? free.h : free.w;
    const isLast = j >= items.length;
    const after = items.length - j;
    const bounds = depthRange(items, i, j, scale, horizontal);
    // Depth of at least one cell, and never so deep that the items still to
    // come cannot each get a row of their own. Reserving a single cell for all
    // of them, which is what this did first, let the free region run out with
    // items left over; the final row takes whatever remains so the tiling
    // closes exactly.
    //
    // The proportional depth is raised to what the members need and capped at
    // what they can use. Where the two disagree the floor wins: a panel too
    // narrow to draw is a worse outcome than one wider than it wanted.
    const roomy = Math.max(1, across - after);
    const wanted = Math.max(1, Math.round(sum / side));
    const depth = isLast
      ? across
      : Math.min(roomy, Math.max(Math.min(wanted, Math.round(bounds.max)), Math.round(bounds.min), 1));

    // Lengths along the row in whole cells, proportional but no member below
    // the minimum it needs to be drawable, adding up to `side` exactly. See
    // `distribute`.
    const mins = new Array<number>(row.length);
    for (let k = 0; k < row.length; k++) {
      const it = items[i + k];
      mins[k] = Math.max(1, Math.min(side, (horizontal ? it.minW : it.minH) ?? 1));
    }
    const lens = distribute(row, side, mins);

    let pos = 0;
    for (let k = 0; k < row.length; k++) {
      const len = k === row.length - 1 ? Math.max(1, side - pos) : lens[k];
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
    for (let k = i; k < j; k++) left -= Math.max(0, items[k].area);
    if (left > 0 && free.w > 0 && free.h > 0) scale = (free.w * free.h) / left;
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
