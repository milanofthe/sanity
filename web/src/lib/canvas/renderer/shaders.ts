// All GLSL lives here. Every pass is an instanced unit quad; the differences
// are in what the instance attributes mean.

const HEAD = `#version 300 es
precision highp float;
`;

/** Filled rectangles with a pixel-width border: directory boxes, panel
 *  backgrounds, change gutters, heat glows. */
export const rectVS = `${HEAD}
in vec2 aCorner;
in vec4 aRect;    // world x, y, w, h
in vec4 aFill;    // rgba
in vec4 aBorder;  // rgb, and border width in device pixels in .a
uniform mat3 uView;
uniform vec2 uViewport;  // framebuffer size in device pixels
out vec2 vLocalPx;
out vec2 vSizePx;
out vec4 vFill;
out vec4 vBorder;

// Clip space to device pixels and back.
vec2 toPx(vec2 clip) { return (clip * 0.5 + 0.5) * uViewport; }
vec2 toClip(vec2 px) { return (px / uViewport) * 2.0 - 1.0; }

void main() {
  // Snap both corners to the pixel grid.
  //
  // Without this a one pixel border lands on fractional coordinates, the
  // fragment shader antialiases it across two pixels, and the split changes
  // with every subpixel of pan: the border pulses. Snapping makes it exactly
  // one pixel wherever it is, so it steps rather than shimmers, and it also
  // keeps the fill's edges from bleeding a half-transparent seam between two
  // rectangles that share an edge.
  vec2 p0 = toPx((uView * vec3(aRect.xy, 1.0)).xy);
  vec2 p1 = toPx((uView * vec3(aRect.xy + aRect.zw, 1.0)).xy);
  vec2 q0 = floor(p0 + 0.5);
  vec2 q1 = floor(p1 + 0.5);
  // A rectangle rounded to nothing would vanish; keep at least one pixel.
  vec2 dir = sign(q1 - q0 + 0.0001);
  q1 = q0 + dir * max(abs(q1 - q0), vec2(1.0));

  vSizePx = abs(q1 - q0);
  vLocalPx = aCorner * vSizePx;
  vFill = aFill;
  vBorder = aBorder;
  gl_Position = vec4(toClip(mix(q0, q1, aCorner)), 0.0, 1.0);
}`;

export const rectFS = `${HEAD}
in vec2 vLocalPx;
in vec2 vSizePx;
in vec4 vFill;
in vec4 vBorder;
out vec4 oColor;
void main() {
  float d = min(min(vLocalPx.x, vSizePx.x - vLocalPx.x),
                min(vLocalPx.y, vSizePx.y - vLocalPx.y));
  // Clamp the width so a rectangle smaller than its own border does not turn
  // into a solid block of border.
  float w = min(vBorder.a, min(vSizePx.x, vSizePx.y) * 0.5);
  // A hard edge, not a smoothstep: the vertex shader has already snapped the
  // rectangle to whole pixels, so the border covers whole pixels and needs no
  // antialiasing. Blending it instead is what made the edges shimmer, since
  // the coverage of each boundary pixel changed with every subpixel of pan.
  float onBorder = w > 0.0 ? 1.0 - step(w, d) : 0.0;
  oColor = vec4(mix(vFill.rgb, vBorder.rgb, onBorder), mix(vFill.a, 1.0, onBorder));
}`;

/**
 * A picture: one quad, one texture, one draw call.
 *
 * Not instanced, unlike everything else here, because every picture has its
 * own texture of its own size. A canvas shows a few dozen at most, and a draw
 * call each is nothing next to a texture array that would have to be sized for
 * the largest of them.
 */
export const imageVS = `${HEAD}
in vec2 aCorner;
uniform mat3 uView;
uniform vec4 uRect;
// Drawing buffer size in device pixels, for the pixel grid.
uniform vec2 uViewport;
// 1 when the texture was made for exactly this many screen pixels: then the
// quad is put on the pixel grid at the texture's own size, so a texel is a
// pixel, the way glyphs are drawn. 0 scales it onto the rect.
uniform float uExact;
uniform vec2 uTexPx;
out vec2 vUv;
void main() {
  vUv = aCorner;
  if (uExact > 0.5) {
    vec2 o = (uView * vec3(uRect.xy, 1.0)).xy;
    vec2 originPx = floor((o * 0.5 + 0.5) * uViewport + 0.5);
    // World y grows downwards and clip y upwards, as for glyphs.
    vec2 px = originPx + vec2(aCorner.x, -aCorner.y) * uTexPx;
    gl_Position = vec4((px / uViewport) * 2.0 - 1.0, 0.0, 1.0);
    return;
  }
  vec2 world = uRect.xy + aCorner * uRect.zw;
  gl_Position = vec4((uView * vec3(world, 1.0)).xy, 0.0, 1.0);
}`;

export const imageFS = `${HEAD}
uniform sampler2D uTex;
uniform float uFade;
in vec2 vUv;
out vec4 oColor;
void main() {
  // Premultiplied in the texture, so filtering between a line and the clear
  // pixels around it does not darken the line; straight for the blend.
  vec4 t = texture(uTex, vUv);
  oColor = t.a > 0.0 ? vec4(t.rgb / t.a, t.a * uFade) : vec4(0.0);
}`;

/** A file's overview texture, one quad per code column. */
export const overviewVS = `${HEAD}
in vec2 aCorner;
in vec4 aRect;
in vec4 aUv;        // u0, v0, u1, v1
in vec3 aMeta;      // array layer, alpha, language family
uniform mat3 uView;
out vec2 vUv;
flat out float vLayer;
flat out float vFade;
flat out vec3 vLang;
// The family's colour per unit of texture luminance; see familyTints.
uniform vec3 uFamily[7];
void main() {
  vec2 world = aRect.xy + aCorner * aRect.zw;
  vUv = mix(aUv.xy, aUv.zw, aCorner);
  vLayer = aMeta.x;
  vFade = aMeta.y;
  vLang = uFamily[int(aMeta.z)];
  gl_Position = vec4((uView * vec3(world, 1.0)).xy, 0.0, 1.0);
}`;

export const overviewFS = `${HEAD}
// GLSL ES 3.0 has no default precision for array samplers, unlike sampler2D.
precision highp sampler2DArray;
uniform sampler2DArray uTex;
// Vertical texel count of the layer, which is the height class this draw call
// is bound to. One value per call, since a call is one chunk and a chunk is
// one class.
uniform float uTexRows;
// 1 applies the sharpening, 0 falls back to plain bilinear. Only so the two
// can be compared: scripts/sharp-check.mjs measures the vertical contrast
// with it on and off, which is the difference this is for.
uniform float uSharp;
// How far the colour comes from the language rather than from the tokens.
// Zero unless the tint is switched on and the zoom is far enough out that the
// tokens have stopped saying anything; see languageTint in lod.ts. No
// backticks in here: this GLSL is a template literal, so one ends the string
// and the error arrives as a parse failure in the TypeScript.
uniform float uLangTint;
in vec2 vUv;
flat in float vLayer;
flat in float vFade;
flat in vec3 vLang;
out vec4 oColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

/**
 * Sample with the vertical interpolation sharpened where the texture is
 * magnified.
 *
 * The texture holds one texel per screen row of the panel, so vertically it is
 * exactly 1:1 at one pixel per line and magnified by the pixels-per-line
 * factor above that. Measured across the hand-over band: 1.8x at 1.8 px/line,
 * 3.2x at 3.2. Plain bilinear over that smears each line of code into its
 * neighbours, which is the softness you see just before the token bars take
 * over. Horizontally there is no such problem: 128 texels cover at most 120
 * characters, so it is never magnified and stays linear.
 *
 * The fix keeps a one-pixel ramp at each texel boundary and flattens the rest,
 * so it is linear at 1:1 and approaches nearest under heavy magnification.
 * That is sharp without aliasing, and it costs six instructions rather than
 * the extra taps a bicubic would need.
 */
void main() {
  // Texels per screen pixel, vertically. Below one, the texture is magnified.
  float perPx = fwidth(vUv.y) * uTexRows;
  float k = clamp(perPx, 0.0, 1.0);
  float ty = vUv.y * uTexRows - 0.5;
  float fy = fract(ty);
  float sharp = clamp((fy - 0.5) / max(k, 1e-3) + 0.5, 0.0, 1.0);
  float v = mix(vUv.y, (floor(ty) + 0.5 + sharp) / uTexRows, uSharp);
  vec4 t = texture(uTex, vec3(vUv.x, v, vLayer));

  // The language's colour at the texture's own luminance, so the shape of the
  // code survives and only what it is made of changes. Measured on a real
  // project: at a fifth of a pixel per line the luminance varies three times
  // as much within a panel as it does between panels, so the structure is the
  // part worth keeping and the identity is the part worth adding.
  //
  // vLang is the family's colour per unit of luminance, gain included, worked
  // out once per theme in familyTints. So this is one multiply, where it used
  // to divide by the family colour's luminance per texel.
  float lum = dot(t.rgb, LUMA);
  vec3 tinted = clamp(vLang * lum, 0.0, 1.0);
  vec3 rgb = mix(t.rgb, tinted, uLangTint);

  oColor = vec4(rgb, t.a * vFade);
}`;

/** One quad per token span. */
export const spanVS = `${HEAD}
in vec2 aCorner;
in vec4 aRect;
in vec2 aKindFade; // token kind index, alpha
uniform mat3 uView;
uniform vec3 uKind[16];
out vec4 vColor;
void main() {
  vec2 world = aRect.xy + aCorner * aRect.zw;
  vColor = vec4(uKind[int(aKindFade.x)], aKindFade.y);
  gl_Position = vec4((uView * vec3(world, 1.0)).xy, 0.0, 1.0);
}`;

export const spanFS = `${HEAD}
in vec4 vColor;
out vec4 oColor;
void main() { oColor = vColor; }`;

/** One quad per glyph. */
export const glyphVS = `${HEAD}
in vec2 aCorner;
in vec4 aPosGlyph;  // world x, y, glyph index, token kind
in vec2 aSizeFade;  // em size in world units, alpha
uniform mat3 uView;
uniform vec3 uKind[16];
uniform vec2 uCell;      // cell size in atlas uv
uniform vec2 uBoxPx;      // the atlas cell, in device pixels
uniform float uEmWorld;   // the em that is drawn as exactly the cell, in world units
uniform float uGridCols;
uniform float uGridRows;
// Subpixel variants the atlas holds each glyph at, one grid of glyphs each.
uniform float uPhases;
// Drawing buffer size in device pixels, for putting a glyph on the pixel grid.
uniform vec2 uViewport;
out vec2 vUv;
out vec4 vColor;
void main() {
  vColor = vec4(uKind[int(aPosGlyph.w)], aSizeFade.y);

  // Size and position both on the pixel grid. The quad is the atlas cell,
  // scaled by the em this instance asks for against the em that stands for
  // the cell. A panel at rest asks for exactly that, so the quad is the cell
  // and a texel lands on a pixel; a panel animating in asks for less and
  // scales with it. A glyph landing on a half pixel is read through bilinear
  // filtering at every edge: measured at 14 pixels per line, half the ink sat
  // at an intermediate tone where DOM text puts 14 percent of it.
  //
  // The whole quad is shifted by one offset rather than each corner being
  // rounded on its own: rounding corners changes a glyph's width by up to a
  // pixel, which is a wobble rather than a sharpening.
  //
  // Horizontally the glyph starts on the pixel at or left of where it falls,
  // and the variant rasterised nearest the remaining fraction is drawn, so
  // the spacing between letters stays even. Vertically every line of a
  // column shares its fraction, so plain rounding keeps them even already.
  vec2 boxPx = max(vec2(1.0), floor(uBoxPx * (aSizeFade.x / uEmWorld) + 0.5));
  vec2 originClip = (uView * vec3(aPosGlyph.xy, 1.0)).xy;
  vec2 exactPx = (originClip * 0.5 + 0.5) * uViewport;
  float baseX = floor(exactPx.x);
  float phase = floor((exactPx.x - baseX) * uPhases + 0.5);
  if (phase >= uPhases) {
    baseX += 1.0;
    phase = 0.0;
  }
  vec2 originPx = vec2(baseX, floor(exactPx.y + 0.5));
  float idx = aPosGlyph.z + phase * uGridCols * uGridRows;
  vec2 cell = vec2(mod(idx, uGridCols), floor(idx / uGridCols));
  vUv = (cell + aCorner) * uCell;
  // Y flips between the two: world y grows downwards and uView turns that
  // into clip space, where it grows upwards. Adding the box in pixels without
  // that flip draws every glyph upside down.
  vec2 px = originPx + vec2(aCorner.x, -aCorner.y) * boxPx;
  gl_Position = vec4((px / uViewport) * 2.0 - 1.0, 0.0, 1.0);
}`;

export const glyphFS = `${HEAD}
uniform sampler2D uAtlas;
in vec2 vUv;
in vec4 vColor;
out vec4 oColor;
void main() {
  float a = texture(uAtlas, vUv).a;
  if (a < 0.01) discard;
  oColor = vec4(vColor.rgb, a * vColor.a);
}`;

/**
 * A picture resampled to an exact size: one triangle over the target, and per
 * target pixel the average of the source texels it covers.
 *
 * An area average rather than bilinear or the browser's own resize. Bilinear
 * reads four texels per pixel however many the pixel covers, so a thin line in
 * a diagram either lands on a sample or vanishes, and that is the grain. The
 * browser's resize depends on the engine: measured against a Lanczos
 * reference, the one in WebKit, which the desktop app draws with, came out
 * twice as far off as Chromium's and with more edge energy than the reference
 * itself, which is aliasing.
 *
 * Source and result are premultiplied, so a clear pixel adds nothing to the
 * average whatever colour the exporter left in it; see mediatex.ts.
 */
export const resampleVS = `${HEAD}
void main() {
  // Three vertices covering the target, from the vertex index alone.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const resampleFS = `${HEAD}
uniform sampler2D uSrc;
uniform vec2 uSrcSize;
uniform vec2 uDstSize;
// Source mip level to read, zero unless a target pixel covers more texels
// than the taps can reach.
uniform float uLod;
// Taps per axis, one per source texel of the footprint at that level.
uniform int uTaps;
out vec4 oColor;
void main() {
  // Target pixel index. Row 0 of the target is row 0 of the source, the top
  // of the picture, so no flip anywhere.
  vec2 dst = gl_FragCoord.xy - 0.5;
  vec2 scale = uSrcSize / uDstSize;
  vec2 origin = dst * scale;
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 16; j++) {
    if (j >= uTaps) break;
    for (int i = 0; i < 16; i++) {
      if (i >= uTaps) break;
      vec2 s = origin + (vec2(float(i), float(j)) + 0.5) / float(uTaps) * scale;
      acc += textureLod(uSrc, s / uSrcSize, uLod);
    }
  }
  oColor = acc / float(uTaps * uTaps);
}`;
