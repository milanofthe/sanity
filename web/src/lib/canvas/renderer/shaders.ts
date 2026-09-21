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
uniform float uScale;  // world units to device pixels
out vec2 vLocalPx;
out vec2 vSizePx;
out vec4 vFill;
out vec4 vBorder;
void main() {
  vec2 world = aRect.xy + aCorner * aRect.zw;
  vSizePx = aRect.zw * uScale;
  vLocalPx = aCorner * vSizePx;
  vFill = aFill;
  vBorder = aBorder;
  gl_Position = vec4((uView * vec3(world, 1.0)).xy, 0.0, 1.0);
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
  // Antialias the border over one pixel, and clamp its width so a rectangle
  // smaller than its own border does not turn into a solid block of border.
  float w = min(vBorder.a, min(vSizePx.x, vSizePx.y) * 0.5);
  float onBorder = w > 0.0 ? 1.0 - smoothstep(w - 0.5, w + 0.5, d) : 0.0;
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
in vec2 vUv;
flat in float vLayer;
flat in float vFade;
out vec4 oColor;
void main() {
  vec4 t = texture(uTex, vec3(vUv, vLayer));
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
