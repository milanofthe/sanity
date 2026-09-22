// Which colour a language gets at the zoom where its tokens stop being worth
// showing.
//
// Grouped into families rather than one colour per language, for two reasons.
// The palette has six data hues and there are eighteen languages, so one each
// is not on offer. And the useful distinction at that distance is not Rust
// from Go, it is source from configuration from prose: a directory of YAML
// reads as a different kind of thing from a directory of code, and that is
// what the eye should get for free.
//
// The ids come from the registry in crates/sanity-core/src/lang.rs, where the
// order is what assigns them and entries are only ever appended. A language
// added there and not here falls through to `Other`, which is a colour rather
// than a fault.

import { luminance, rgb } from './colour.ts';

/**
 * Index into the palette's six data colours.
 *
 * A const object rather than an enum: node strips types to run the tests and
 * an enum is syntax it cannot strip, being a value as well as a type.
 */
export const Family = {
  Systems: 0,
  Scripting: 1,
  Web: 2,
  Data: 3,
  Prose: 4,
  Hardware: 5,
} as const;

export type Family = (typeof Family)[keyof typeof Family];

/** Family per language id. Ids not listed, including 0 for a file no grammar
 *  claimed, take `Other`. */
const FAMILY: Record<number, Family> = {
  1: Family.Systems, // rust
  2: Family.Scripting, // python
  3: Family.Web, // typescript
  4: Family.Web, // tsx
  5: Family.Web, // javascript
  6: Family.Systems, // c
  7: Family.Systems, // cpp
  8: Family.Systems, // go
  9: Family.Data, // json
  10: Family.Data, // toml
  11: Family.Data, // yaml
  12: Family.Prose, // markdown
  13: Family.Web, // css
  14: Family.Web, // html, which is also svelte and vue
  15: Family.Prose, // latex
  16: Family.Scripting, // bash
  17: Family.Prose, // markdown_inline, reachable only through an injection
  18: Family.Hardware, // veriloga
  19: Family.Hardware, // spice
};

/** The highest family index, so a caller can size a uniform array. */
export const FAMILY_COUNT = 7;

/** Where a language's colour sits in the array `familyColours` returns. */
export function familyOf(langId: number): number {
  const f = FAMILY[langId];
  return f === undefined ? FAMILY_COUNT - 1 : f;
}

/**
 * The colour per family, from the palette's data hues.
 *
 * The last entry is for anything unclaimed, and it is deliberately the
 * dimmest: a file nothing could parse should not be the brightest thing on the
 * canvas.
 */
export function familyColours(data: number[], dim: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < FAMILY_COUNT - 1; i++) out.push(data[i % data.length]);
  out.push(dim);
  return out;
}

/**
 * What a family's colour cannot say, and why this does not try.
 *
 * The tint puts a family's colour at the texture's luminance, which is what
 * keeps the structure of the code visible and the canvas at its exposure. It
 * also throws away everything a palette says with brightness alone, and a
 * palette may say most of it that way: sanity's own theme is red, white and
 * charcoal, so its six data colours are three reds and three greys, and the
 * three greys differ in nothing but luminance. Measured on 423 panels, six of
 * the 21 family pairs came out under 0.05 apart in chroma, three of them under
 * 0.021. On Mariana, whose six colours are six hues, it is one pair of 21.
 *
 * The obvious repair is to give each family back a share of its colour's own
 * brightness. Built it, measured it, took it out: over a band of a seventh the
 * two families that share a hue landed 2 percent apart in panel luminance, and
 * widening the band to nearly a half moved them no further apart at all,
 * because how dense a file's code is varies more between families than any
 * gain does. Systems code is simply darker than prose, and that swamped it.
 * Brightness is not a channel that can carry identity here. Hue is, and a
 * theme with two hues can separate two groups of languages and no more, which
 * is the price of the palette being the palette.
 */

/**
 * The tint vector per family: the family's colour per unit of texture
 * luminance, gain included, flattened three floats at a time.
 *
 * Precomputed rather than left to the fragment shader, which used to divide by
 * the family colour's luminance per texel. It is a constant per family, it
 * changes only with the theme, and doing it here means the shader is one
 * multiply.
 */
export function familyTints(colours: number[]): Float32Array<ArrayBuffer> {
  const out = new Float32Array(colours.length * 3);
  colours.forEach((c, i) => {
    const [r, g, b] = rgb(c);
    const k = 1 / Math.max(1e-4, luminance(c));
    out[i * 3] = r * k;
    out[i * 3 + 1] = g * k;
    out[i * 3 + 2] = b * k;
  });
  return out;
}
