// The single source of truth for every colour, size and duration in the app.
// Nothing downstream is allowed to hardcode a literal.

import { KIND_COUNT, Kind, LineState } from './data/wire';

/** sRGB hex, 0xRRGGBB. Kept as numbers because the renderer needs them as
 *  floats in a uniform array anyway. */
export const palette = {
  bg: 0x0d1117,
  panelBg: 0x151b23,
  panelBgAlt: 0x11171f,
  dirBg: 0x0a0e14,
  dirLabel: 0x6b7684,
  panelLabel: 0x9aa4b2,
  border: 0x232b36,
  borderActive: 0x3d4855,

  ink: 0xc9d1d9,
  inkDim: 0x8b949e,

  comment: 0x5c6773,
  docComment: 0x6b8299,
  string: 0x8ab77b,
  number: 0xd6a06a,
  keyword: 0xb07fc7,
  type: 0x6fa8c7,
  fn: 0x7fb3e0,
  variable: 0xc9d1d9,
  punctuation: 0x767f8c,
  constant: 0xd68a8a,
  attribute: 0xc7a76f,

  added: 0x3fb950,
  modified: 0xd29922,
  deleted: 0xf85149,
  heat: 0xffb86c,
} as const;

/** Indexed by Kind, uploaded to the shader as a vec3 array. */
export const kindColors: number[] = (() => {
  const c = new Array<number>(KIND_COUNT).fill(palette.ink);
  c[Kind.Plain] = palette.ink;
  c[Kind.Comment] = palette.comment;
  c[Kind.DocComment] = palette.docComment;
  c[Kind.String] = palette.string;
  c[Kind.Number] = palette.number;
  c[Kind.Keyword] = palette.keyword;
  c[Kind.Type] = palette.type;
  c[Kind.Function] = palette.fn;
  c[Kind.Variable] = palette.variable;
  c[Kind.Punctuation] = palette.punctuation;
  c[Kind.Constant] = palette.constant;
  c[Kind.Attribute] = palette.attribute;
  return c;
})();

/**
 * A second, muted palette for the overview textures.
 *
 * Most of a line of code is identifiers and punctuation, and in the editor
 * palette those carry the foreground colour. Averaged down to a few pixels
 * that turns every file into the same pale grey smear. Damping the filler and
 * keeping comments, strings and keywords at full strength is what gives a
 * zoomed-out file a recognisable signature.
 */
export const overviewColors: number[] = (() => {
  const c = kindColors.slice();
  c[Kind.Plain] = 0x6d7787;
  c[Kind.Variable] = 0x7b8695;
  c[Kind.Punctuation] = 0x4e5764;
  c[Kind.Type] = 0x5b90ad;
  c[Kind.Function] = 0x6796c2;
  return c;
})();

export const stateColors: number[] = (() => {
  const c = new Array<number>(4).fill(0);
  c[LineState.Unchanged] = 0;
  c[LineState.Added] = palette.added;
  c[LineState.Modified] = palette.modified;
  c[LineState.DeletedBelow] = palette.deleted;
  return c;
})();

/** Geometry, in world units. One world unit is one CSS pixel at zoom 1, and
 *  at zoom 1 a line of code is exactly `lineHeight` units tall. */
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
  mono: '"SF Mono", "JetBrains Mono", Menlo, monospace',
  ui: '-apple-system, "Helvetica Neue", sans-serif',
  /** Size the glyph atlas is rasterised at. */
  atlasSize: 48,
  uiSize: 11,
} as const;

export const rgb = (hex: number): [number, number, number] => [
  ((hex >> 16) & 0xff) / 255,
  ((hex >> 8) & 0xff) / 255,
  (hex & 0xff) / 255,
];

export const css = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`;
