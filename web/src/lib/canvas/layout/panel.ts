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
import { visualRowsCached } from './wrap';

/** Width divided by height a panel aims for when nothing constrains it.
 *  Treemap slots come out close to square, so that is what to aim at. */
export const TARGET_ASPECT = 1.0;
export const MAX_COLUMNS = colBounds.maxPerPanel;
/** Fewest lines a code column is quantized to. Setting this low matters more
 *  than it looks: it is the floor on a panel's height, and a slot flatter
 *  than that floor is one no column count can fit. */
export const MIN_COLUMN_LINES = colBounds.minLines;
/** Fewest lines worth splitting a column into; see `columns.minPerColumn`. */
export const MIN_LINES_PER_COLUMN = colBounds.minPerColumn;
/** Up to this many lines a file counts as short in the layout statistics. It
 *  changes no layout, it only says which panels `smallBloatP95` is about. */
export const SMALL_FILE_LINES = 150;
/**
 * How many columns a file of this many rows is worth cutting into.
 *
 * A panel wraps into newspaper columns to reach a shape the treemap can place,
 * and shape alone is happy to cut a short file into four columns of twenty
 * five. Reading that means three jumps back to the top for something that
 * would have fitted on one screen, so a column has to be worth its break:
 * every one of them holds `MIN_LINES_PER_COLUMN` rows or it does not exist.
 *
 * The rule is the same for every file, with no threshold where short turns
 * into long. It simply stops binding once a file is long enough that the
 * column cap is reached first, at around 1280 rows.
 */
export function columnsWorth(rows: number): number {
  return Math.max(1, Math.min(MAX_COLUMNS, Math.floor(rows / MIN_LINES_PER_COLUMN)));
}

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
  /** Characters of text drawn per code column, line-number margin excluded. */
  cols: number;
  /**
   * Characters reserved at the left of each code column for line numbers,
   * including the space between number and code. Zero when the column is too
   * narrow to spare them.
   *
   * Part of the layout rather than something the text pass adds, because every
   * pass has to agree on where a line starts: putting the numbers in the
   * gutter between columns instead made a three digit number of one column
   * overlap the last word of the previous one, and reserving the space only
   * while text is drawn would shift the code sideways mid-crossfade.
   */
  numberCols: number;
  /** Number of code columns the lines are wrapped into. */
  columns: number;
  /** Lines per code column. */
  linesPerColumn: number;
  /** Distance from one code column to the next, in world units. Stored rather
   *  than derived from `cols`, because surplus slot width becomes gutter. */
  pitch: number;
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
/**
 * How wide a picture may be: one code column, the same width a panel of text
 * gets before it wraps into a second one.
 *
 * That is the measure that means something on this canvas. A picture beside
 * the code it belongs to should read like another column of it, not like a
 * poster: sized by area instead, a 4000 by 2000 render came out 2992 wide,
 * which is six columns and larger than most source files in the project.
 *
 * The pixel share still applies below that, so an icon stays an icon: the
 * width a picture asks for is the square root of a third of its pixels times
 * its proportion, and the ceiling only bites for anything from about a
 * megapixel up, which is every plot and screenshot.
 *
 * There is a second ceiling, on height, because a width limit alone does
 * nothing for a portrait: a screenshot of a phone is one part wide to two
 * parts tall, so 75 columns of it came out 78 lines tall, taller than most
 * source files in the project. Whichever ceiling binds, the other side comes
 * down with it, so the panel keeps the picture's proportion either way.
 */
const MEDIA_PIXEL_SHARE = 1 / 3;
const MEDIA_MAX_COLS = 75;
const MEDIA_MIN_LINES = 3;
const MEDIA_MAX_LINES = 45;

/** Inner width of a single code column at `MEDIA_MAX_COLS` characters. */
function mediaMaxWidth(): number {
  return MEDIA_MAX_COLS * metrics.charWidth;
}

/**
 * Size of a panel that holds a picture rather than text.
 *
 * The shape follows the layout, not the image: the panel is laid out like any
 * other and the picture is fitted inside it, centred, which is why the aspect
 * only sets the *preferred* proportion here. Binding the panel's shape to the
 * image would be a fixed box in the treemap, and fixed boxes are what stubs
 * had to be taken out of the treemap for.
 */
export function mediaGeometry(aspect: number, pixels: number): PanelGeometry {
  // Width first, height from the proportion. Width, because that is what the
  // ceiling is expressed in and what makes a picture sit beside code as a
  // column rather than as a block.
  const a = Math.max(0.1, Math.min(10, aspect));
  const wanted = Math.sqrt(Math.max(1, pixels) * MEDIA_PIXEL_SHARE * a);
  // Both ceilings in one width, so a tall picture is narrowed rather than
  // squashed: the tallest a panel may be, read back through the proportion, is
  // a width like any other.
  const fromHeight = MEDIA_MAX_LINES * metrics.lineHeight * a;
  const innerW = Math.max(
    MIN_PANEL_COLS * metrics.charWidth,
    Math.min(mediaMaxWidth(), fromHeight, wanted),
  );
  const lines = Math.max(MEDIA_MIN_LINES, innerW / a / metrics.lineHeight);
  const innerH = lines * metrics.lineHeight;
  return {
    cols: MIN_PANEL_COLS,
    numberCols: 0,
    columns: 1,
    linesPerColumn: 0,
    pitch: innerW + COLUMN_GUTTER,
    w: innerW + 2 * metrics.panelPadX,
    h: innerH + metrics.titleHeight + 2 * metrics.panelPadY,
  };
}

export function stubGeometry(): PanelGeometry {
  return {
    cols: MIN_PANEL_COLS,
    numberCols: 0,
    columns: 1,
    linesPerColumn: 0,
    pitch: MIN_PANEL_COLS * metrics.charWidth + COLUMN_GUTTER,
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
export function panelArea(lineCols: ArrayLike<number>, maxCols: number): number {
  const g = panelGeometry(lineCols, maxCols);
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
  /** Reached the preferred column width *and* has room for every wrapped row;
   *  false asks the layout for another fitting pass with more area. */
  ok: boolean;
  /** Wide enough to be worth drawing at all. This is the invariant. */
  usable: boolean;
  /**
   * Every wrapped row fits in `columns * linesPerColumn`.
   *
   * Separate from `usable` because they fail for opposite reasons: a panel can
   * be perfectly readable and still too short for its own content, which is
   * what happened when wrapping first landed. A fifth of the lines wrapped,
   * the panels did not grow to match, and 3557 lines fell off the bottom.
   */
  holdsAll: boolean;
}

/** Characters of code a column keeps before a line-number margin is worth
 *  its share of the width. */
const LINE_NUMBER_MIN_COLS = 28;

/** Width of the line-number margin for a file, in characters. */
export function numberColsFor(lineCount: number, availableCols: number): number {
  const digits = String(Math.max(1, lineCount)).length;
  return availableCols >= digits + 1 + LINE_NUMBER_MIN_COLS ? digits + 1 : 0;
}

export function fillSlot(
  lineCols: ArrayLike<number>, clipCols: number, slotW: number, slotH: number,
): SlotFit {
  const innerW = slotW - 2 * metrics.panelPadX;
  const innerH = slotH - metrics.titleHeight - 2 * metrics.panelPadY;
  const lineCount = Math.max(1, lineCols.length);

  if (innerW < metrics.charWidth * HARD_MIN_COLS || innerH < metrics.lineHeight) {
    return {
      cols: HARD_MIN_COLS,
      numberCols: 0,
      columns: 1,
      linesPerColumn: Math.max(1, Math.floor(innerH / metrics.lineHeight)),
      pitch: HARD_MIN_COLS * metrics.charWidth + COLUMN_GUTTER,
      w: slotW,
      h: slotH,
      ok: false,
      usable: false,
      holdsAll: false,
    };
  }

  // Exact, not rounded: the slot is a whole number of cells and a cell is one
  // line tall, so the division comes out even.
  const linesPerColumn = Math.max(1, Math.floor(innerH / metrics.lineHeight));

  // How many columns the file needs depends on how many rows it takes, which
  // depends on how wide a column is, which depends on how many columns there
  // are. Iterate to a fixed point, starting from the unwrapped count.
  //
  // `textWidthAt` has to apply exactly the caps the final width does, or the
  // loop reasons about a column that will not exist. It did not at first: it
  // used the raw available width while the result was capped at the file's
  // longest line, so a file of 120 character lines was counted as if its
  // columns were wider than they are, came out at two columns where it needed
  // four, and lost a third of itself off the bottom.
  const widthFor = (n: number) =>
    Math.floor((innerW + COLUMN_GUTTER) / n / metrics.charWidth) * metrics.charWidth;
  const capWidth = Math.max(PREFERRED_MIN_COLS, Math.min(MAX_PANEL_COLS, clipCols));
  const textWidthAt = (n: number) => {
    const avail = Math.floor((widthFor(n) - COLUMN_GUTTER) / metrics.charWidth);
    const margin = numberColsFor(lineCount, avail);
    return Math.max(colBounds.hardMin, Math.min(avail - margin, capWidth));
  };

  // Start at the fewest columns the file is worth cutting into, and let the
  // loop below add the ones the slot's height forces.
  let columns = Math.max(
    1,
    Math.min(columnsWorth(lineCount), Math.ceil(lineCount / linesPerColumn)),
  );
  for (let attempt = 0; attempt < 6; attempt++) {
    const rows = visualRowsCached(lineCols, textWidthAt(columns));
    // Capacity decides here, not taste: the loop exists to make sure the
    // wrapped rows fit, and a floor on how much a column is worth splitting
    // would hold a panel below the rows it has to hold. That floor belongs to
    // the starting point above, which is a preference, and this is the
    // correction, which is an obligation.
    const next = Math.min(MAX_COLUMNS, Math.max(1, Math.ceil(rows / linesPerColumn)));
    if (next === columns) break;
    // Only ever widen: alternating between two counts would never settle, and
    // the row count only grows as columns get narrower.
    if (next < columns) break;
    columns = next;
  }

  if (columns > MAX_COLUMNS) {
    return {
      cols: PREFERRED_MIN_COLS,
      numberCols: 0,
      columns: MAX_COLUMNS,
      linesPerColumn,
      pitch: PREFERRED_MIN_COLS * metrics.charWidth + COLUMN_GUTTER,
      w: slotW,
      h: slotH,
      ok: false,
      usable: false,
      holdsAll: false,
    };
  }

  // Snap the column pitch to whole characters, so every code column of every
  // panel starts on the same lattice. Whatever does not divide evenly is left
  // at the right edge rather than spread into fractional offsets.
  const pitch = widthFor(columns);
  const available = Math.floor((pitch - COLUMN_GUTTER) / metrics.charWidth);

  // Cap the text width at the file's longest line, so surplus slot width
  // becomes gutter rather than columns with room for two hundred characters
  // holding lines of sixty, which made panels read as mostly empty.
  //
  // The cap is the true maximum, not the percentile the panel is sized by:
  // capping at the percentile clipped the longest tenth of every file's lines
  // even where the panel had room for them, which is the wrong trade to make
  // silently. Where the slot genuinely is too narrow, clipping still happens,
  // because the alternative is a column too narrow to read.
  const numberCols = numberColsFor(lineCount, available);
  const forText = available - numberCols;
  // No clipping cap any more: a line longer than the column wraps into the
  // next row rather than losing its tail. The width is still bounded by the
  // file's own longest line, so surplus slot width becomes gutter instead of
  // columns with room for two hundred characters holding lines of sixty.
  const wanted = Math.max(PREFERRED_MIN_COLS, Math.min(MAX_PANEL_COLS, clipCols));
  const cols = Math.max(colBounds.hardMin, Math.min(forText, wanted));

  // Rows the file actually needs at the width it ended up with, against the
  // rows the panel has room for.
  const neededRows = visualRowsCached(lineCols, cols);
  const holdsAll = columns * linesPerColumn >= neededRows;

  return {
    cols,
    numberCols,
    columns,
    linesPerColumn,
    pitch,
    w: slotW,
    h: slotH,
    // A panel cut into more columns than its length is worth counts as a
    // misfit, the same as one too narrow to read. Both are answered the same
    // way: the fitting pass asks for a slot that does not force it, and the
    // shape it asks for is worked out with the same rule, so what it gets back
    // is a slot where the preference holds.
    ok: available >= PREFERRED_MIN_COLS && holdsAll && columns <= columnsWorth(neededRows),
    usable: available >= HARD_MIN_COLS,
    holdsAll,
  };
}

export function panelGeometry(
  lineCols: ArrayLike<number>, maxCols: number,
): PanelGeometry {
  const cols = Math.min(
    MAX_PANEL_COLS,
    Math.max(MIN_PANEL_COLS, quantize(Math.max(1, maxCols), 8)),
  );
  // Rows once wrapped at that width, not the raw line count: a file of long
  // lines is taller than its line count suggests, and sizing it by the count
  // is what made the treemap hand out slots its panel could not fill.
  const lines = Math.max(1, visualRowsCached(lineCols, cols));

  // n^2 = aspect * lines * lineHeight / (cols * charWidth), from solving
  // (n * colWidth) / (lines / n * lineHeight) = aspect for n.
  const colWidth = cols * metrics.charWidth;
  const ideal = Math.sqrt((TARGET_ASPECT * lines * metrics.lineHeight) / colWidth);
  // Never more columns than the file has lines to fill them with: a short file
  // cut into four columns is four jumps back to the top for something that
  // would have fitted on one screen.
  const worthSplitting = Math.max(1, Math.floor(lines / MIN_LINES_PER_COLUMN));
  const columns = Math.min(MAX_COLUMNS, worthSplitting, Math.max(1, Math.round(ideal)));

  const linesPerColumn = quantize(Math.ceil(lines / columns), MIN_COLUMN_LINES);
  const inner = {
    w: columns * colWidth + (columns - 1) * COLUMN_GUTTER,
    h: linesPerColumn * metrics.lineHeight,
  };

  return {
    cols,
    numberCols: 0,
    columns,
    linesPerColumn,
    pitch: cols * metrics.charWidth + COLUMN_GUTTER,
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
  return g.pitch;
}

/** Usable text width of one code column, in world units, margin excluded. */
export function columnWidth(g: PanelGeometry): number {
  return g.cols * metrics.charWidth;
}

/** Offset from a code column's left edge to where its text starts. */
export function textIndent(g: PanelGeometry): number {
  return g.numberCols * metrics.charWidth;
}

/** Where line `i` sits inside the panel's text area, in world units. */
export function linePosition(g: PanelGeometry, i: number): [number, number] {
  const col = Math.min(g.columns - 1, Math.floor(i / g.linesPerColumn));
  const row = i - col * g.linesPerColumn;
  return [textOriginX + col * columnPitch(g), textOriginY + row * metrics.lineHeight];
}
