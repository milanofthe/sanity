// Geometry and timing. Colour lives in tokens.css and reaches the renderer
// through theme.ts; nothing here is themeable, because a theme that changed
// the line height would change the layout.

/**
 * Geometry, in world units. One world unit is one CSS pixel at zoom 1, so at
 * zoom 1 a line of code is exactly `lineHeight` units tall.
 *
 * Every measurement here is a whole multiple of `charWidth` horizontally and
 * of `lineHeight` vertically, and that is load bearing rather than tidy.
 * The text is monospace, so the content already lives on a lattice; if the
 * chrome around it does not, the lattice is broken at every panel boundary.
 * The previous values had a 16 unit title bar over 4 units of padding, and
 * 20 mod 14 is 6, so the text lines of any two panels were six units out of
 * step and no two lines on the canvas ever shared a baseline. Horizontally a
 * 6 unit pad against a 7 unit character did the same thing.
 *
 * With everything on the lattice, a panel's inner width is a whole number of
 * characters and its inner height a whole number of lines, by construction.
 */
export const metrics = {
  lineHeight: 14,
  charWidth: 7,
  /** One character of padding on each side. */
  panelPadX: 7,
  /** None: the title bar is the vertical padding. */
  panelPadY: 0,
  /** One line, which is all a file name needs. */
  titleHeight: 14,
  /** Two characters between the text columns of one panel. */
  columnGutter: 14,
  /** One cell of frame around a directory, and one line for its label. */
  dirPad: 14,
  dirLabelHeight: 14,
  borderWidth: 1,
} as const;

/**
 * Layout grid cell, in world units: one line height square.
 *
 * The treemap subdivides in whole cells, so every panel and directory edge in
 * the layout lands on this lattice. One line tall and two characters wide, so
 * it is the coarsest cell that the content's own lattice divides evenly.
 */
/**
 * Resolution of a file's overview texture layer.
 *
 * `texCols` has to be at least `MAX_PANEL_COLS`, or the texture is sampling a
 * panel at less than one texel per character and the result is visibly soft.
 * At 64 it was: panels narrower than 64 characters came out sharp and wider
 * ones blurred, in the same view, which read as a rendering fault rather than
 * as a level of detail.
 *
 * Source lines are squeezed into `texRows` when the file is longer, which is
 * intended: at these zoom levels individual lines are not resolvable anyway.
 */
export const overview = {
  texCols: 128,
  texRows: 256,
} as const;

export const CELL = metrics.lineHeight;

/**
 * Column width bounds for a panel, in characters.
 *
 * `PREFERRED_MIN` is what the layout aims for and what the fitting passes grow
 * a file's area to reach. `HARD_MIN` is where a panel stops being worth
 * drawing, and it is far lower on purpose: treating the preference as a floor
 * made the fitting loop chase a handful of tiny files forever, when a 12
 * character column is cramped rather than broken.
 *
 * `MAX` is bounded by the overview texture's width, because a panel wider than
 * `texCols` is sampled at less than one texel per character and looks soft
 * next to its neighbours.
 */
export const columns = {
  preferredMin: 24,
  hardMin: 12,
  max: Math.min(120, overview.texCols),
  /** How many code columns a panel may wrap its lines into. */
  maxPerPanel: 12,
  /** Fewest lines a code column is quantized to. */
  minLines: 4,
} as const;



export const timing = {
  /** Seconds over which a changed line cools back down to neutral. */
  heatDecay: 90,
  /** Seconds for a level-of-detail crossfade. */
  lodFade: 0.18,
  /** Seconds for a layout reflow animation: a panel sliding and scaling from
   *  where it was to where it now belongs. */
  reflow: 0.45,
  /** Seconds a panel takes to settle in when it first appears. */
  appear: 0.32,
  /** Seconds between the first panel appearing and the last, spread by
   *  distance from the centre so a project blooms outward rather than
   *  arriving as one block. Long enough to read as an arrival, short enough
   *  that nobody waits for it. */
  appearStagger: 0.45,
  /** Scale a panel starts at when it appears. Close to one: a panel is a
   *  rectangle in a grid of rectangles, and anything more than a nudge reads
   *  as a bounce rather than as settling. */
  appearScale: 0.93,
} as const;

export const font = {
  /** Must match --font-mono in tokens.css: the atlas rasterises with it. */
  mono: '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace',
  /** Size the glyph atlas is rasterised at. */
  atlasSize: 48,
} as const;
