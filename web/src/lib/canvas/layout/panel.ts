// Geometry of a single file panel.
//
// A long file laid out as one column becomes a useless ribbon: 2000 lines are
// 28000 world units tall next to maybe 600 units of width. So a panel wraps its
// lines into newspaper style columns until it hits a sane aspect ratio. At full
// zoom the columns read like facing pages, and when zoomed out the panel is a
// compact block whose area is proportional to the size of the file.

import { metrics } from '$lib/metrics';

/** Width divided by height a panel aims for when nothing constrains it.
 *  Treemap slots come out close to square, so that is what to aim at. */
export const TARGET_ASPECT = 1.0;
export const MAX_COLUMNS = 12;
/** Fewest lines a code column is quantized to. Setting this low matters more
 *  than it looks: it is the floor on a panel's height, and a slot flatter
 *  than that floor is one no column count can fit. */
export const MIN_COLUMN_LINES = 4;
/** Columns are never narrower than this, so short-line files stay readable. */
export const MIN_PANEL_COLS = 24;
/** Nor wider, so one runaway line does not blow up the panel. */
export const MAX_PANEL_COLS = 120;
/** Gutter between two text columns, in world units. */
export const COLUMN_GUTTER = 12;

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
    h: metrics.titleHeight + 2 * metrics.panelPadY,
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

/** Outer size of a panel with its lines wrapped into `columns` columns. */
function sizeFor(lineCount: number, cols: number, columns: number): { w: number; h: number; linesPerColumn: number } {
  const linesPerColumn = quantize(Math.ceil(Math.max(1, lineCount) / columns), MIN_COLUMN_LINES);
  return {
    w: columns * cols * metrics.charWidth + (columns - 1) * COLUMN_GUTTER + 2 * metrics.panelPadX,
    h: linesPerColumn * metrics.lineHeight + 2 * metrics.panelPadY + metrics.titleHeight,
    linesPerColumn,
  };
}

/** Treemap weight for a file: the exact outer area of the panel in its
 *  preferred shape, padding, title bar and line quantization included. A
 *  fudge factor here shows up directly as panels overflowing their slots. */
export function panelArea(lineCount: number, maxCols: number): number {
  const g = panelGeometry(lineCount, maxCols);
  return g.w * g.h;
}

/**
 * Pick the column count that fits the given slot best.
 *
 * This is the step that makes the treemap work: the slot's aspect ratio is
 * whatever the subdivision produced, and the panel adapts to it instead of the
 * other way round. Preference goes to the candidate that fits and leaves the
 * least slack; if nothing fits, the one that overflows least wins.
 */
export function fitPanel(lineCount: number, maxCols: number, slotW: number, slotH: number): PanelGeometry {
  const cols = panelCols(maxCols);
  let best: PanelGeometry | null = null;
  let bestScore = Infinity;
  let bestOverflow: PanelGeometry | null = null;
  let bestOverflowScore = Infinity;

  for (let columns = 1; columns <= MAX_COLUMNS; columns++) {
    const { w, h, linesPerColumn } = sizeFor(lineCount, cols, columns);
    const g: PanelGeometry = { cols, columns, linesPerColumn, w, h };
    const over = Math.max(0, w - slotW) + Math.max(0, h - slotH);
    if (over === 0) {
      const slack = slotW * slotH - w * h;
      if (slack < bestScore) {
        bestScore = slack;
        best = g;
      }
    } else if (over < bestOverflowScore) {
      bestOverflowScore = over;
      bestOverflow = g;
    }
  }
  return best ?? bestOverflow!;
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

/** Where line `i` sits inside the panel's text area, in world units. */
export function linePosition(g: PanelGeometry, i: number): [number, number] {
  const col = Math.min(g.columns - 1, Math.floor(i / g.linesPerColumn));
  const row = i - col * g.linesPerColumn;
  return [
    textOriginX + col * (g.cols * metrics.charWidth + COLUMN_GUTTER),
    textOriginY + row * metrics.lineHeight,
  ];
}
