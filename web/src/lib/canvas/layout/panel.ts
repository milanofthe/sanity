// Geometry of a single file panel.
//
// A long file laid out as one column becomes a useless ribbon: 2000 lines are
// 28000 world units tall next to maybe 600 units of width. So a panel wraps its
// lines into newspaper style columns. At full zoom the columns read like facing
// pages, and zoomed out the panel is a compact block whose area is proportional
// to the size of the file.
//
// Two functions produce geometry, for two different questions.
// `panelGeometry` is the shape a file would choose if nothing constrained it,
// and it exists only to give the treemap a weight. `fillSlot` is the real
// layout: it takes the rectangle the treemap assigned and derives the text
// layout from it, so the panel ends up exactly the size of its slot.

import { columns as colBounds, metrics } from '$lib/metrics';

/** Width divided by height a panel aims for when nothing constrains it.
 *  Treemap slots come out close to square, so that is what to aim at. */
export const TARGET_ASPECT = 1.0;
export const MAX_COLUMNS = colBounds.maxPerPanel;
/** Fewest lines a code column is quantized to. Setting this low matters more
 *  than it looks: it is the floor on a panel's height, and a slot flatter
 *  than that floor is one no column count can fit. */
export const MIN_COLUMN_LINES = colBounds.minLines;
/** Re-exported from metrics, where the bounds live so they can be checked
 *  without the module graph. */
export const PREFERRED_MIN_COLS = colBounds.preferredMin;
export const HARD_MIN_COLS = colBounds.hardMin;
export const MIN_PANEL_COLS = colBounds.preferredMin;
export const MAX_PANEL_COLS = colBounds.max;
/** Gutter between two text columns. Lives in metrics.ts so it stays on the
 *  character lattice with everything else. */
export const COLUMN_GUTTER = metrics.columnGutter;

/**
 * Round up to a stable step of roughly 12 percent of the magnitude. Panel
 * sizes must not follow the line count exactly: otherwise every save nudges
 * the size, the packing reflows and the whole canvas jumps, which destroys the
 * spatial memory that makes the overview useful in the first place.
 */
export function quantize(n: number, min = 8): number {
  if (n <= min) return min;
  const mag = 2 ** Math.floor(Math.log2(n));
  const step = Math.max(min, mag / 8);
  return Math.ceil(n / step) * step;
}

export interface PanelGeometry {
  /** Text columns per code column, quantized. */
  cols: number;
  /** Number of code columns the lines are wrapped into. */
  columns: number;
  /** Lines per code column, quantized. */
  linesPerColumn: number;
  /** Outer size in world units, title bar and padding included. */
  w: number;
  h: number;
}

/**
 * Size of a stub panel: a title bar and nothing else.
 *
 * Deliberately constant. A stub says "this file exists" and refuses to say
 * anything about how large it is, because the whole reason a file gets stubbed
 * is that its size would otherwise dominate the layout. Scaling stubs by line
 * count would reintroduce exactly that problem.
 */
export function stubGeometry(): PanelGeometry {
  return {
    cols: MIN_PANEL_COLS,
    columns: 1,
    linesPerColumn: 0,
    w: MIN_PANEL_COLS * metrics.charWidth + 2 * metrics.panelPadX,
    h: metrics.titleHeight,
  };
}

/** Treemap weight of a stub. */
export function stubArea(): number {
  const g = stubGeometry();
  return g.w * g.h;
}

/** Text columns a file wants, quantized so small edits cannot change it. */
export function panelCols(maxCols: number): number {
  return Math.min(MAX_PANEL_COLS, Math.max(MIN_PANEL_COLS, quantize(Math.max(1, maxCols), 8)));
}

/** Treemap weight for a file: the exact outer area of the panel in its
 *  preferred shape, padding, title bar and line quantization included. A
 *  fudge factor here shows up directly as panels overflowing their slots. */
export function panelArea(lineCount: number, maxCols: number): number {
  const g = panelGeometry(lineCount, maxCols);
  return g.w * g.h;
}

/**
 * Fill the slot.
 *
 * The first version of this picked whichever column count fit inside the slot
 * and left the panel centred in the leftover space. That is what produced the
 * gaps: every panel had a different natural size, so every panel had a
 * different margin, and no two edges lined up anywhere on the canvas. A
 * treemap tiles its rectangle exactly, so the only way to inherit that
 * alignment is for the panel to be the rectangle.
 *
 * So the slot is the input and the text layout is the output:
 *
 *   rows    = how many lines fit in the slot's height
 *   columns = how many such columns the file needs
 *   cols    = how many characters fit in the resulting column width
 *
 * Line height stays global, because the level-of-detail system is defined in
 * pixels per line and would fall apart if it varied per panel. What varies is
 * the character width available, which is why `cols` is an output here.
 *
 * `ok` says the result reached the preferred column width, and a false value
 * asks the layout for another pass with more area. `usable` says the panel is
 * wide enough to draw at all, and that is the invariant the layout check
 * asserts; the gap between the two is what stops the fitting loop from
 * chasing a few pathological files forever.
 */
export interface SlotFit extends PanelGeometry {
  /** Reached the preferred column width; false asks for another fitting pass. */
  ok: boolean;
  /** Wide enough to be worth drawing at all. This is the invariant. */
  usable: boolean;
}

export function fillSlot(lineCount: number, slotW: number, slotH: number): SlotFit {
  const innerW = slotW - 2 * metrics.panelPadX;
  const innerH = slotH - metrics.titleHeight - 2 * metrics.panelPadY;
  const lines = Math.max(1, lineCount);

  if (innerW < metrics.charWidth * HARD_MIN_COLS || innerH < metrics.lineHeight) {
    return {
      cols: HARD_MIN_COLS,
      columns: 1,
      linesPerColumn: Math.max(1, Math.floor(innerH / metrics.lineHeight)),
      w: slotW,
      h: slotH,
      ok: false,
      usable: false,
    };
  }

  // Exact, not rounded: the slot is a whole number of cells and a cell is one
  // line tall, so the division comes out even.
  const linesPerColumn = Math.max(1, Math.floor(innerH / metrics.lineHeight));
  const columns = Math.max(1, Math.ceil(lines / linesPerColumn));
  if (columns > MAX_COLUMNS) {
    return {
      cols: PREFERRED_MIN_COLS,
      columns: MAX_COLUMNS,
      linesPerColumn,
      w: slotW,
      h: slotH,
      ok: false,
      usable: false,
    };
  }

  // Snap the column pitch to whole characters, so every code column of every
  // panel starts on the same lattice. Whatever does not divide evenly is left
  // at the right edge rather than spread into fractional offsets.
  const pitch = Math.floor((innerW + COLUMN_GUTTER) / columns / metrics.charWidth)
    * metrics.charWidth;
  const cols = Math.floor((pitch - COLUMN_GUTTER) / metrics.charWidth);

  return {
    cols: Math.min(MAX_PANEL_COLS, cols),
    columns,
    linesPerColumn,
    w: slotW,
    h: slotH,
    ok: cols >= PREFERRED_MIN_COLS,
    usable: cols >= HARD_MIN_COLS,
  };
}

export function panelGeometry(lineCount: number, maxCols: number): PanelGeometry {
  const cols = Math.min(
    MAX_PANEL_COLS,
    Math.max(MIN_PANEL_COLS, quantize(Math.max(1, maxCols), 8)),
  );
  const lines = Math.max(1, lineCount);

  // n^2 = aspect * lines * lineHeight / (cols * charWidth), from solving
  // (n * colWidth) / (lines / n * lineHeight) = aspect for n.
  const colWidth = cols * metrics.charWidth;
  const ideal = Math.sqrt((TARGET_ASPECT * lines * metrics.lineHeight) / colWidth);
  const columns = Math.min(MAX_COLUMNS, Math.max(1, Math.round(ideal)));

  const linesPerColumn = quantize(Math.ceil(lines / columns), MIN_COLUMN_LINES);
  const inner = {
    w: columns * colWidth + (columns - 1) * COLUMN_GUTTER,
    h: linesPerColumn * metrics.lineHeight,
  };

  return {
    cols,
    columns,
    linesPerColumn,
    w: inner.w + 2 * metrics.panelPadX,
    h: inner.h + 2 * metrics.panelPadY + metrics.titleHeight,
  };
}

/** Top-left corner of a panel's text area, relative to the panel origin. */
export const textOriginX = metrics.panelPadX;
export const textOriginY = metrics.titleHeight + metrics.panelPadY;

/**
 * Advance from one code column to the next, in world units.
 *
 * A whole number of characters, matching what `fillSlot` computed: the columns
 * have to land on the character lattice, so any width that does not divide
 * evenly is left over at the right edge instead of being spread across the
 * columns as a fractional offset.
 */
export function columnPitch(g: PanelGeometry): number {
  return g.cols * metrics.charWidth + COLUMN_GUTTER;
}

/** Usable text width of one code column, in world units. */
export function columnWidth(g: PanelGeometry): number {
  return g.cols * metrics.charWidth;
}

/** Where line `i` sits inside the panel's text area, in world units. */
export function linePosition(g: PanelGeometry, i: number): [number, number] {
  const col = Math.min(g.columns - 1, Math.floor(i / g.linesPerColumn));
  const row = i - col * g.linesPerColumn;
  return [textOriginX + col * columnPitch(g), textOriginY + row * metrics.lineHeight];
}
