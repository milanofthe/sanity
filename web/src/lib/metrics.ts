// Geometry and timing. Colour lives in tokens.css and reaches the renderer
// through theme.ts; nothing here is themeable, because a theme that changed
// the line height would change the layout.

/** Geometry, in world units. One world unit is one CSS pixel at zoom 1, so at
 *  zoom 1 a line of code is exactly `lineHeight` units tall. */
export const metrics = {
  lineHeight: 14,
  charWidth: 7,
  /** Padding inside a file panel. */
  panelPadX: 6,
  panelPadY: 4,
  /** Height of the panel title bar. */
  titleHeight: 16,
  /** Gap between sibling panels. */
  gap: 8,
  /** Padding inside a directory box, and the height reserved for its label. */
  dirPad: 10,
  dirLabelHeight: 18,
  borderWidth: 1,
} as const;

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
