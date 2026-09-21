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
export const CELL = metrics.lineHeight;

/** Pixels per line at which each level of detail takes over. Below the first
 *  entry a file is a flat block; above the last it is real text. */
export const lodThresholds = {
  block: 0.5,
  texture: 3.0,
  spans: 10.0,
  glyphs: 10.0,
} as const;

/** Resolution of a file's overview texture layer. Source lines are squeezed
 *  into `texRows` when the file is longer, which is exactly what we want:
 *  at these zoom levels individual lines are not resolvable anyway. */
export const overview = {
  texCols: 64,
  texRows: 256,
} as const;

export const timing = {
  /** Seconds over which a changed line cools back down to neutral. */
  heatDecay: 90,
  /** Seconds for a level-of-detail crossfade. */
  lodFade: 0.18,
  /** Seconds for a layout reflow animation. */
  reflow: 0.45,
} as const;

export const font = {
  /** Must match --font-mono in tokens.css: the atlas rasterises with it. */
  mono: '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace',
  /** Size the glyph atlas is rasterised at. */
  atlasSize: 48,
} as const;
