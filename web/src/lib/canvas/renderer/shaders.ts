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

/** A file's overview texture, one quad per code column. */
export const overviewVS = `${HEAD}
in vec2 aCorner;
in vec4 aRect;
in vec4 aUv;        // u0, v0, u1, v1
in vec2 aLayerFade; // array layer, alpha
uniform mat3 uView;
out vec2 vUv;
flat out float vLayer;
flat out float vFade;
void main() {
  vec2 world = aRect.xy + aCorner * aRect.zw;
  vUv = mix(aUv.xy, aUv.zw, aCorner);
  vLayer = aLayerFade.x;
  vFade = aLayerFade.y;
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
in vec2 vUv;
flat in float vLayer;
flat in float vFade;
out vec4 oColor;

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
  oColor = vec4(t.rgb, t.a * vFade);
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
uniform vec2 uGlyphScale; // glyph box size relative to em (w, h)
uniform float uGridCols;
out vec2 vUv;
out vec4 vColor;
void main() {
  float idx = aPosGlyph.z;
  vec2 cell = vec2(mod(idx, uGridCols), floor(idx / uGridCols));
  vUv = (cell + aCorner) * uCell;
  vColor = vec4(uKind[int(aPosGlyph.w)], aSizeFade.y);
  vec2 box = aSizeFade.x * uGlyphScale;
  vec2 world = aPosGlyph.xy + aCorner * box;
  gl_Position = vec4((uView * vec3(world, 1.0)).xy, 0.0, 1.0);
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
