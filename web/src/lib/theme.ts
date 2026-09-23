// Themes, and the bridge from CSS custom properties to the WebGL renderer.
//
// tokens.css is the only place colours are written down. The canvas cannot
// read CSS, so it resolves the same variables at runtime and converts them to
// floats. That keeps one source of truth: switching a theme recolours the
// chrome and the canvas from the same override block, and a colour cannot
// drift between the two.

export type ThemeId =
  | 'sanity'
  | 'mariana'
  | 'one'
  | 'nord'
  | 'gruvbox'
  | 'monokai'
  | 'breakers'
  | 'solar';

export interface ThemeInfo {
  id: ThemeId;
  label: string;
}

/**
 * The schemes, in order from dark to light.
 *
 * Mariana, Monokai and Breakers come from the Sublime Text distribution,
 * values verbatim from Packages/Color Scheme - Default. One, Nord, Gruvbox and
 * Solarized come from their own published palettes, also verbatim; each block
 * in tokens.css names its source. sanity's own is the only invented one.
 *
 * The list carries the id and the label and nothing else: the Theme menu draws
 * each one as a miniature of the canvas using that theme's own custom
 * properties, so a picker colour kept here would be a second copy of three of
 * them, free to drift.
 *
 * Celeste, Sublime's light default, is deliberately absent: it paints keywords
 * and types in the same black as ordinary text, and an app whose whole point
 * is telling code apart at a distance cannot use a scheme that does not. Its
 * light slot is filled by Breakers, which is Mariana's palette on a light
 * ground.
 */
export const THEMES: ThemeInfo[] = [
  { id: 'sanity', label: 'Sanity' },
  { id: 'mariana', label: 'Mariana' },
  { id: 'one', label: 'One' },
  { id: 'nord', label: 'Nord' },
  { id: 'gruvbox', label: 'Gruvbox' },
  { id: 'monokai', label: 'Monokai' },
  { id: 'breakers', label: 'Breakers' },
  { id: 'solar', label: 'Solar' },
];

/** Token colours, in the order of `Kind` in the wire format. */
const TOKEN_VARS = [
  '--tok-plain', '--tok-comment', '--tok-doc-comment', '--tok-string',
  '--tok-number', '--tok-keyword', '--tok-type', '--tok-function',
  '--tok-variable', '--tok-punctuation', '--tok-constant', '--tok-attribute',
] as const;

/**
 * Colour slots past the twelve token kinds, for text the renderer draws that
 * is not code: panel headers, directory labels, type badges.
 *
 * `Kind` is four bits, so there are sixteen slots and the wire format only
 * ever uses twelve. Reusing the spare four means header text goes through the
 * same glyph pass as code, with one palette uniform, instead of needing a
 * second shader.
 */
export const UiInk = {
  Name: 12,
  Path: 13,
  Badge: 14,
  DirLabel: 15,
} as const;

const UI_VARS: Record<number, string> = {
  [UiInk.Name]: '--text',
  [UiInk.Path]: '--text-faint',
  [UiInk.Badge]: '--text-dim',
  [UiInk.DirLabel]: '--dir-label',
};

/** Overview overrides, applied on top of the token colours. */
const OVERVIEW_OVERRIDES: Partial<Record<number, string>> = {
  0: '--ov-plain',
  6: '--ov-type',
  7: '--ov-function',
  8: '--ov-variable',
  9: '--ov-punctuation',
};

/** The theme's six data hues, which everything coloured derives from. */
const DATA_VARS = ['--data-1', '--data-2', '--data-3', '--data-4', '--data-5', '--data-6'];

const SURFACE_VARS = {
  bg: '--canvas-bg',
  panelBg: '--panel-bg',
  panelBgAlt: '--panel-bg-alt',
  dirBg: '--dir-bg',
  dirLabel: '--dir-label',
  panelLabel: '--panel-label',
  border: '--border',
  borderStrong: '--border-strong',
  ink: '--text',
  inkDim: '--text-dim',
  added: '--added',
  modified: '--modified',
  deleted: '--deleted',
  accent: '--accent',
  reducedBg: '--reduced-bg',
  reducedInk: '--reduced-ink',
  paper: '--paper',
} as const;

export type SurfaceKey = keyof typeof SURFACE_VARS;

export interface Palette {
  /**
   * How far a directory's frame and wash rotate towards its own hue, 0 to 1.
   *
   * A theme token rather than a constant because a monochrome palette has to
   * be able to turn it off: rotating hues is exactly what a scheme built from
   * one accent does not want, and without this the sanity theme would grow
   * rainbow directory borders it never asked for.
   */
  dirTint: number;
  dirWash: number;
  /** 0xRRGGBB per token kind, for readable text. Sixteen entries: the twelve
   *  wire-format kinds followed by the UI slots in `UiInk`. */
  token: number[];
  /** Same, damped, for the overview textures. */
  overview: number[];
  surface: Record<SurfaceKey, number>;
  /**
   * The theme's data hues, for anything that needs a colour per category:
   * directory frames pick one by path hash.
   *
   * Picking from the palette rather than rotating a hue by hash is what keeps
   * those frames inside the theme. Rotation produced colours the palette never
   * contained, so a scheme built from six chosen hues grew frames in six
   * arbitrary others, and a monochrome scheme grew a rainbow.
   */
  data: number[];
}

/**
 * Resolve CSS colour strings to 0xRRGGBB.
 *
 * Uses a canvas as the parser rather than picking apart the computed value:
 * `color-mix()` resolves to `oklab(...)` or `color(srgb ...)` depending on the
 * browser and the mixing space, and hand-written parsers for those go stale.
 * A 2D context accepts every CSS colour there is and hands back bytes.
 */
function makeResolver(): (cssVar: string) => number {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.documentElement.appendChild(probe);

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const cache = new Map<string, number>();

  return (cssVar: string): number => {
    const hit = cache.get(cssVar);
    if (hit !== undefined) return hit;

    probe.style.color = `var(${cssVar})`;
    const str = getComputedStyle(probe).color;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = str || '#ff00ff';
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    const packed = (r << 16) | (g << 8) | b;
    cache.set(cssVar, packed);
    return packed;
  };
}

/** A numeric custom property, with a fallback if the theme omits it. */
function readNumber(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const v = Number.parseFloat(raw);
  return Number.isFinite(v) ? v : fallback;
}

/** Read the palette of whatever theme is currently on `<html>`. */
export function readPalette(): Palette {
  const resolve = makeResolver();
  const token = TOKEN_VARS.map(resolve);
  for (const [slot, v] of Object.entries(UI_VARS)) token[Number(slot)] = resolve(v);
  const overview = token.slice();
  for (const [i, v] of Object.entries(OVERVIEW_OVERRIDES)) {
    overview[Number(i)] = resolve(v!);
  }
  const surface = {} as Record<SurfaceKey, number>;
  for (const [key, v] of Object.entries(SURFACE_VARS)) {
    surface[key as SurfaceKey] = resolve(v);
  }
  return {
    token,
    overview,
    surface,
    data: DATA_VARS.map(resolve),
    dirTint: readNumber('--dir-tint', 0.55),
    dirWash: readNumber('--dir-wash', 0.1),
  };
}

export const rgb = (hex: number): [number, number, number] => [
  ((hex >> 16) & 0xff) / 255,
  ((hex >> 8) & 0xff) / 255,
  (hex & 0xff) / 255,
];

export const css = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`;

const STORAGE_KEY = 'sanity.theme';

export function applyTheme(id: ThemeId): void {
  document.documentElement.dataset.theme = id;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Private browsing or a locked-down webview: the theme just does not stick.
  }
}

export function storedTheme(): ThemeId {
  try {
    const v = localStorage.getItem(STORAGE_KEY) as ThemeId | null;
    if (v && THEMES.some((t) => t.id === v)) return v;
  } catch {
    // Fall through to the default.
  }
  return 'sanity';
}
