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
  /**
   * How many code columns a panel may wrap its lines into.
   *
   * Raised from twelve, which turned out to be the binding constraint on the
   * whole layout rather than a detail of one panel. Twelve columns is the
   * widest a panel can be, so it is also the flattest slot it can fill, and
   * for a very tall file that is barely wider than square: an 8045 line file
   * tops out at 1.04. The treemap hands out slots a little wider than square
   * as a matter of course, so those files could not fill their slots, the
   * fitting loop bought area to compensate, and 200 files of 4000 lines ended
   * up with a canvas 4.4 times larger than they needed. At 32 the bound stops
   * binding: the same case fills 99 percent with panels 1.00 times the area
   * they need, in two passes instead of forty.
   *
   * Nothing else moved. The column count a panel actually picks comes from
   * aiming at a square, so ordinary files never come near the cap, and the
   * other six repository shapes in the layout check are unchanged to the
   * decimal.
   */
  maxPerPanel: 32,
  /** Fewest lines a code column is quantized to. */
  minLines: 4,
  /**
   * Fewest lines a column is worth splitting into.
   *
   * A panel wraps into newspaper columns to reach a shape the treemap can
   * place, and shape alone is happy to cut a short file into four columns of
   * twenty five: measured on pathsim, ten panels held fewer than forty lines
   * a column, among them a 36 line workflow file in two columns of 23.
   * Reading those means jumping back to the top for something that would have
   * fitted on one screen.
   *
   * It is a trade, and this is where to turn it. A crowded panel is offered
   * exactly the area that would keep it whole, so the higher this is, the
   * more of the canvas short files take and the fewer times a reader jumps.
   * Swept on pathsim, counting column breaks and wrapped rows per hundred
   * lines against the canvas area:
   *
   *   off   18.7 breaks,  570 canvas,  26 of 186 short files in one column
   *   40    17.9 breaks,  580 canvas,  45
   *   50    16.1 breaks,  610 canvas,  61
   *   60    14.0 breaks,  672 canvas,  98
   *   70    12.4 breaks,  753 canvas, 111
   *   100    6.8 breaks, 1128 canvas, 168
   *
   * Every value lays out cleanly in all nine shapes layout-check covers, no
   * misfits and no unusable panels, so the choice is only about how much
   * canvas fewer jumps are worth.
   *
   * Sixty: fewer jumps than the first version of this rule managed at fifty,
   * 14.0 against 15.0, for four percent more canvas than it took.
   */
  minPerColumn: 60,
  /**
   * Share of a file's lines a column should be wide enough for, so that only
   * the rest wrap; see `fullCols` in tree.ts. Zero turns the preference off.
   *
   * Wrapped rows were most of what a reader jumps over, and nearly all of
   * them came from columns a fifth narrower than the file's usual line, not
   * from lines too long for any column: the treemap hands a file its area in
   * a shape that does not divide into whole columns of its width. A panel
   * whose columns come out narrower than this is offered the area for wider
   * ones, exactly that much, the way a crowded one is. Swept on pathsim,
   * column breaks and wrapped rows per hundred lines against the canvas:
   *
   *   off    11.9 breaks, 696 canvas
   *   0.9     4.6 breaks, 836 canvas
   *   0.95    3.6 breaks, 879 canvas
   *
   * Against the layout before any of this, 14.0 breaks at 679: at 0.95, 226
   * of pathsim's 328 text files have fewer breaks and 11 have more, by five
   * at most; at 0.9, 17 have more, and without the preference 71, by up to
   * 26, since the files that do not get width lose some of theirs to the ones
   * that do. The first version of this left the line-number margin out of the
   * width it asked for and gave half the gain.
   */
  fullWidthShare: 0.95,
} as const;



export const timing = {
  /**
   * Seconds the panel flash lasts, and seconds the line marks are held and
   * then faded.
   *
   * Short, all three of them, because what they report is an event. This was
   * one number, a ninety second decay, and it was wrong in both directions at
   * once: too long to read as something happening, and long enough that the
   * canvas never stopped redrawing while an agent worked. See recency.ts.
   *
   * The marks were held for four seconds, with the border lit alongside them
   * for a while, and that read as a glow rather than as a change: what a
   * change should look like is the file flashing and its lines flashing, red
   * for what went and green for what came, and then nothing. So a second and
   * a half, of which the last second is the fade.
   */
  flash: 0.5,
  markHold: 1.5,
  markFade: 1,
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
  /** Seconds the lines that are going away take to fade out, before the new
   *  content is put in. Short: it is the first half of one gesture. */
  changeOut: 0.28,
  /** Seconds the lines that arrived take to settle from the change colour down
   *  to the standing band. Longer than the removal, so the thing that is now
   *  there is what you end up looking at. */
  changeIn: 0.5,
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
