// The scene: owns the GPU resources, decides the level of detail per file and
// builds this frame's instance data.
//
// The load-bearing property is that detail and count trade off against each
// other. Zoomed out, every file is a handful of textured quads, so the frame
// cost is proportional to the file count and nothing else. Zoomed in, token
// and glyph geometry appears, but by then only a few files intersect the
// viewport and only a few hundred of their lines do, so the instance count
// stays in the tens of thousands no matter how large the repository is.

import { Camera } from '$lib/canvas/camera';
import { metrics, timing } from '$lib/metrics';
import { lodWeights, spanBarHeight } from '$lib/canvas/lod';
import { rgb, UiInk, type Palette } from '$lib/theme';
import { LineState, spanCol, spanKind, spanLen, type FileData } from '$lib/canvas/data/wire';
import {
  columnPitch, columnWidth, COLUMN_GUTTER, textIndent, textOriginX, textOriginY,
} from '$lib/canvas/layout/panel';
import { lineAtRow, wrapOffsets } from '$lib/canvas/layout/wrap';
import type { DirNode, FileNode, Layout } from '$lib/canvas/layout/tree';
import { GlyphAtlas } from './glyphatlas';
import { OverviewTextures, type Slot } from './codetex';
import {
  createProgram, instanceAttribs, quadAttrib, uniforms, unitQuad,
  InstanceBuffer, type GL,
} from './gl';
import {
  glyphFS, glyphVS, overviewFS, overviewVS, rectFS, rectVS, spanFS, spanVS,
} from './shaders';

/** Supplies the actual characters of a line, only ever asked for lines that
 *  are about to be drawn as readable text. The synthetic repo and the Rust
 *  backend both sit behind this. */
export interface TextSource {
  lineText(path: string, line: number): string | null;
}

export interface SceneFile {
  node: FileNode;
  data: FileData;
  slot: Slot;
  /**
   * Screen row each source line starts on, at this panel's column width.
   *
   * Cached per file because every drawing pass walks screen rows and has to
   * map back to source lines, and recomputing a prefix sum over a 20,000 line
   * file per frame would undo the point of the level-of-detail system. Rebuilt
   * whenever the layout changes the width.
   */
  rows: Uint32Array;
  /** Recency of the last change, 1 right after an edit, decaying to 0. */
  heat: number;
  /** Aggregate git state of the file, drives the panel border. */
  state: LineState;
}

export interface FrameStats {
  visibleFiles: number;
  overviewQuads: number;
  spanQuads: number;
  glyphQuads: number;
  rectQuads: number;
  pxPerLine: number;
  cpuMs: number;
}

const RECT_STRIDE = 12;
const OVERVIEW_STRIDE = 10;
const SPAN_STRIDE = 6;
const GLYPH_STRIDE = 6;

/**
 * The single hairline used for every separation inside a panel: its border,
 * the rule under its header, and the rules between its code columns.
 *
 * One device pixel at full strength, whatever the zoom. Defined once because
 * these three were drawn from three places with three different weights, and a
 * border at full opacity next to a separator at 0.85 reads as two kinds of
 * line for no reason: a panel's edge and the divisions inside it are the same
 * kind of statement and should look it.
 */
const HAIRLINE_PX = 1;

/** On-screen floor for a stub panel, in CSS pixels. */
const STUB_MIN_PX = 1.5;

/**
 * Border width of a top-level directory, in device pixels. Each level in loses
 * one, down to `DIR_BORDER_MIN_PX`.
 *
 * Heavier than the hairline that panels use, and deliberately so: a region
 * boundary encloses many panels and has to be readable as the stronger
 * statement of the two. At four dropping to one, the inner levels were the
 * same weight as the panels inside them and the nesting disappeared.
 */
const DIR_BORDER_PX = 6;
const DIR_BORDER_MIN_PX = 2;

/**
 * Line count for a header, short enough to fit one.
 *
 * Thousands are abbreviated because the exact figure is not what the header is
 * for: a glance should say whether a file is small, large or enormous, and four
 * characters of panel width is a fair price for that. The status bar carries
 * the exact totals.
 */
function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

/**
 * A stable palette index per directory path.
 *
 * Hashed rather than assigned in tree order so a directory keeps its colour
 * when siblings are added or removed. The golden-ratio step spreads adjacent
 * hash values apart, which matters because sibling directories often share a
 * long prefix.
 */
function dirColourIndex(path: string, count: number): number {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const t = (((h >>> 0) / 4294967296) * 0.6180339887) % 1;
  return Math.min(count - 1, Math.floor(t * count));
}

/**
 * Blend `base` towards `target` by `amount`, keeping base's luminance.
 *
 * Both colours come from the theme, so the result cannot leave the theme's
 * range. Matching the luminance by scaling the target's channels only works
 * when the target is brighter; where it is darker the blend is lifted towards
 * white instead, because scaling up clips and a clipped channel is how the
 * light themes grew a band of fluorescent magenta.
 */
function mixToward(base: number, target: number, amount: number): number {
  if (amount <= 0) return base;
  const [br, bg, bb] = rgb(base);
  const [tr0, tg0, tb0] = rgb(target);
  const lum = 0.2126 * br + 0.7152 * bg + 0.0722 * bb;
  const tlum = 0.2126 * tr0 + 0.7152 * tg0 + 0.0722 * tb0;

  let tr = tr0;
  let tg = tg0;
  let tb = tb0;
  if (tlum <= 0) {
    return base;
  }
  if (tlum < lum) {
    const k = Math.min(1, (lum - tlum) / (1 - tlum));
    tr += (1 - tr) * k;
    tg += (1 - tg) * k;
    tb += (1 - tb) * k;
  } else {
    const scale = lum / tlum;
    tr *= scale;
    tg *= scale;
    tb *= scale;
  }

  const mix = (b: number, t: number) =>
    Math.max(0, Math.min(255, Math.round(255 * (b * (1 - amount) + t * amount))));
  return (mix(br, tr) << 16) | (mix(bg, tg) << 8) | mix(bb, tb);
}


export class Scene {
  private gl: GL;
  private quad: WebGLBuffer;

  private progRect: WebGLProgram;
  private progOverview: WebGLProgram;
  private progSpan: WebGLProgram;
  private progGlyph: WebGLProgram;
  private uRect: Record<string, WebGLUniformLocation | null>;
  private uOverview: Record<string, WebGLUniformLocation | null>;
  private uSpan: Record<string, WebGLUniformLocation | null>;
  private uGlyph: Record<string, WebGLUniformLocation | null>;

  private bgRects: InstanceBuffer;
  private fgRects: InstanceBuffer;
  private overviewByChunk = new Map<string, InstanceBuffer>();
  private spans: InstanceBuffer;
  private glyphs: InstanceBuffer;

  textures: OverviewTextures;
  atlas: GlyphAtlas;

  private view = new Float32Array(9);
  private kindFlat: Float32Array;

  files = new Map<string, SceneFile>();
  /** Path whose header the pointer is over, for the hover highlight. */
  hoveredPath: string | null = null;
  stats: FrameStats = {
    visibleFiles: 0, overviewQuads: 0, spanQuads: 0, glyphQuads: 0,
    rectQuads: 0, pxPerLine: 0, cpuMs: 0,
  };

  constructor(gl: GL, public layout: Layout, private text: TextSource, private pal: Palette) {
    this.gl = gl;
    this.quad = unitQuad(gl);
    this.textures = new OverviewTextures(gl, pal.overview);
    this.atlas = new GlyphAtlas(gl);
    this.kindFlat = new Float32Array(pal.token.length * 3);

    this.progRect = createProgram(gl, rectVS, rectFS, 'rect');
    this.progOverview = createProgram(gl, overviewVS, overviewFS, 'overview');
    this.progSpan = createProgram(gl, spanVS, spanFS, 'span');
    this.progGlyph = createProgram(gl, glyphVS, glyphFS, 'glyph');
    this.uRect = uniforms(gl, this.progRect, ['uView', 'uViewport']);
    this.uOverview = uniforms(gl, this.progOverview, ['uView', 'uTex']);
    this.uSpan = uniforms(gl, this.progSpan, ['uView', 'uKind[0]']);
    this.uGlyph = uniforms(gl, this.progGlyph, [
      'uView', 'uKind[0]', 'uAtlas', 'uCell', 'uGlyphScale', 'uGridCols',
    ]);

    this.bgRects = new InstanceBuffer(gl, RECT_STRIDE, 2048);
    this.fgRects = new InstanceBuffer(gl, RECT_STRIDE, 2048);
    this.spans = new InstanceBuffer(gl, SPAN_STRIDE, 65536);
    this.glyphs = new InstanceBuffer(gl, GLYPH_STRIDE, 65536);

    this.writeKindFlat();

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private writeKindFlat(): void {
    this.pal.token.forEach((hex, i) => {
      const [r, g, b] = rgb(hex);
      this.kindFlat[i * 3] = r;
      this.kindFlat[i * 3 + 1] = g;
      this.kindFlat[i * 3 + 2] = b;
    });
  }

  /**
   * Adopt a new theme. Token and surface colours are uniforms and change for
   * free, but the overview colours are baked into the texture layers, so every
   * file has to be re-rasterised. At a few hundred files that is a visible
   * blink, which is why it happens on an explicit theme switch and nowhere
   * else.
   */
  setPalette(pal: Palette): void {
    this.pal = pal;
    this.kindFlat = new Float32Array(pal.token.length * 3);
    this.writeKindFlat();
    this.textures.setColors(pal.overview);
    for (const f of this.files.values()) {
      if (f.node.stub) continue;
      this.textures.write(f.slot, f.data, f.node.geom.cols, f.rows);
    }
    this.textures.finalize();
  }

  addFile(node: FileNode, data: FileData): void {
    // Stubs draw from geometry alone, so they get no texture layer. On a repo
    // whose artefacts outweigh its source this is most of the memory saved.
    if (node.stub) {
      this.files.set(node.path, {
        node, data,
        slot: { classIdx: 0, chunkIdx: 0, layer: 0, texRows: 0 },
        rows: new Uint32Array(1),
        heat: 0, state: LineState.Unchanged,
      });
      return;
    }
    const rows = wrapOffsets(data.lineCols, node.geom.cols);
    // The texture is as tall as the file is on screen, wrapped rows included,
    // so a row of the texture is a row of the panel either way.
    const slot = this.textures.allocate(rows[data.lineCount]);
    node.layer = slot.layer;
    let state: LineState = LineState.Unchanged;
    for (let i = 0; i < data.lineState.length; i++) {
      if (data.lineState[i] !== LineState.Unchanged) {
        state = data.lineState[i] as LineState;
        break;
      }
    }
    this.textures.write(slot, data, node.geom.cols, rows);
    this.files.set(node.path, { node, data, slot, rows, heat: 0, state });
  }

  /** Called when the watcher reports a file changed on disk. */
  touch(path: string, data?: FileData): void {
    const f = this.files.get(path);
    if (!f) return;
    if (data) {
      f.data = data;
      if (!f.node.stub) {
        f.rows = wrapOffsets(data.lineCols, f.node.geom.cols);
        this.textures.write(f.slot, data, f.node.geom.cols, f.rows);
      }
    }
    f.heat = 1;
  }

  finalizeTextures(): void {
    this.textures.finalize();
  }

  private pushRect(
    b: InstanceBuffer, x: number, y: number, w: number, h: number,
    fill: number, fillA: number, border: number, borderPx: number,
  ): void {
    const o = b.alloc();
    const d = b.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = w; d[o + 3] = h;
    const [fr, fg, fb] = rgb(fill);
    d[o + 4] = fr; d[o + 5] = fg; d[o + 6] = fb; d[o + 7] = fillA;
    const [br, bg, bb] = rgb(border);
    d[o + 8] = br; d[o + 9] = bg; d[o + 10] = bb; d[o + 11] = borderPx;
  }

  private drawRects(b: InstanceBuffer): void {
    if (b.count === 0) return;
    const { gl } = this;
    gl.useProgram(this.progRect);
    gl.uniformMatrix3fv(this.uRect.uView, false, this.view);
    gl.uniform2f(this.uRect.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    b.upload();
    quadAttrib(gl, this.progRect, this.quad);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
    instanceAttribs(gl, this.progRect, RECT_STRIDE, [
      ['aRect', 4, 0], ['aFill', 4, 4], ['aBorder', 4, 8],
    ]);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.count);
  }

  render(cam: Camera, dt: number): void {
    const t0 = performance.now();
    const { gl } = this;
    const pxPerLine = metrics.lineHeight * cam.zoom;

    // A partition of one across the three representations; see lod.ts for why
    // that property is worth having a module and a test for.
    const w = lodWeights(pxPerLine);
    const overviewFade = w.overview;
    const spanFade = w.spans;
    const glyphFade = w.glyphs;

    cam.writeMatrix(this.view);
    const [vx0, vy0, vx1, vy1] = cam.visibleRect(64);

    this.bgRects.reset();
    this.fgRects.reset();
    this.spans.reset();
    this.glyphs.reset();
    for (const b of this.overviewByChunk.values()) b.reset();

    // Directory boxes, outermost first so nesting reads correctly.
    const dirs = [...this.layout.dirs].sort((a, b) => a.depth - b.depth);
    for (const d of dirs) {
      if (d.x > vx1 || d.y > vy1 || d.x + d.w < vx0 || d.y + d.h < vy0) continue;
      this.pushDir(d, cam.zoom);
    }

    let visibleFiles = 0;
    for (const f of this.files.values()) {
      const n = f.node;
      if (n.x > vx1 || n.y > vy1 || n.x + n.w < vx0 || n.y + n.h < vy0) continue;
      visibleFiles++;

      if (f.heat > 0) f.heat = Math.max(0, f.heat - dt / timing.heatDecay);

      // A stub is a frame and a hatch, at every zoom level. It says the file
      // is there and stops: no overview texture, no tokens, no glyphs, and no
      // area proportional to its size. That is the whole point of the mode.
      if (f.node.stub) {
        this.pushStub(f, cam.zoom);
        continue;
      }

      this.pushPanel(f);
      this.pushColumnRules(f, cam.zoom);
      this.pushHeader(f, cam.zoom, f.node.path === this.hoveredPath);
      this.pushPanelBorder(f);
      if (overviewFade > 0.004) this.pushOverview(f, overviewFade);
      if (spanFade > 0.004) this.pushSpans(f, spanFade, pxPerLine, vx0, vy0, vx1, vy1);
      if (glyphFade > 0.004) {
        this.pushGlyphs(f, glyphFade, vx0, vy0, vx1, vy1);
        this.pushLineNumbers(f, glyphFade, vx0, vy0, vx1, vy1);
      }
      if (spanFade > 0.004 || glyphFade > 0.004) this.pushGutter(f, vy0, vy1);
    }

    // Draw.
    const [br, bg, bb] = rgb(this.pal.surface.bg);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(br, bg, bb, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.drawRects(this.bgRects);
    this.drawOverview();
    this.drawSpans();
    this.drawGlyphs(pxPerLine, cam.dpr);
    this.drawRects(this.fgRects);

    let overviewQuads = 0;
    for (const b of this.overviewByChunk.values()) overviewQuads += b.count;
    this.stats = {
      visibleFiles,
      overviewQuads,
      spanQuads: this.spans.count,
      glyphQuads: this.glyphs.count,
      rectQuads: this.bgRects.count + this.fgRects.count,
      pxPerLine,
      cpuMs: performance.now() - t0,
    };
  }

  /**
   * A directory box: a tinted frame and a label, both in world space.
   *
   * Alternating two shades by depth, which is what this did first, says
   * nothing about which directory you are looking at, and at four levels deep
   * the boxes were indistinguishable. A hue derived from the path gives each
   * directory a stable identity you can navigate by, and keeping it to the
   * frame and a wash rather than a fill leaves the code itself as the only
   * saturated thing on screen.
   */
  private pushDir(d: DirNode, zoom: number): void {
    // One of the theme's own hues, chosen by path hash, so a directory's
    // frame is a colour the scheme actually contains.
    const hue = this.pal.data[dirColourIndex(d.path, this.pal.data.length)];
    // Tint strength is a theme token: a monochrome palette sets it to zero and
    // gets depth from the wash alone, which is what it wants.
    const wash = this.pal.dirWash + 0.04 * (d.depth % 3);
    const tint = mixToward(this.pal.surface.dirBg, hue, wash);
    const edge = mixToward(this.pal.surface.borderStrong, hue, this.pal.dirTint);

    // Thicker the further out, so the nesting is readable at a glance. A
    // uniform hairline made a four-level tree look flat, and a border in world
    // units would vanish when zoomed out, so this is in device pixels and
    // clamped to at least one.
    const weight = Math.max(DIR_BORDER_MIN_PX, DIR_BORDER_PX - d.depth);
    // Fill behind everything, frame in front, for the same reason panels split
    // theirs: the children are drawn in between.
    this.pushRect(this.bgRects, d.x, d.y, d.w, d.h, tint, 1, 0, 0);
    this.pushRect(this.fgRects, d.x, d.y, d.w, d.h, tint, 0, edge, weight);

    // The label sits in the frame's own strip, so it never overlaps a panel.
    const px = metrics.dirLabelHeight * zoom;
    const fade = Math.min(1, Math.max(0, (px - 6) / 5));
    if (fade <= 0.004 || !d.name) return;
    const room = Math.floor((d.w - 2 * metrics.dirPad) / metrics.charWidth);
    if (room < 3) return;
    const shown = d.name.length <= room ? d.name : `${d.name.slice(0, Math.max(1, room - 2))}..`;
    this.pushText(
      shown, d.x + metrics.dirPad, d.y + metrics.dirPad - metrics.dirLabelHeight + 1,
      UiInk.DirLabel, fade, room,
    );
  }

  /**
   * Draw a string at a world position, one glyph per instance.
   *
   * Goes through the same pass as code, which is the point: header text lives
   * in world space and scales with its panel, instead of being a DOM label
   * blended over the canvas at its own independent size. The overlay it
   * replaces looked pasted on precisely because it did not share the panel's
   * transform.
   *
   * Returns the width drawn, so runs can be laid out one after another.
   */
  private pushText(
    str: string, x: number, y: number, ink: number, fade: number, maxChars: number,
  ): number {
    if (fade <= 0.004 || maxChars <= 0) return 0;
    const b = this.glyphs;
    const em = metrics.charWidth / this.atlas.advanceRatio;
    const n = Math.min(str.length, maxChars);
    for (let i = 0; i < n; i++) {
      const idx = GlyphAtlas.index(str.charCodeAt(i));
      if (idx < 0) continue;
      const o = b.alloc();
      const d = b.data;
      d[o] = x + i * metrics.charWidth;
      d[o + 1] = y;
      d[o + 2] = idx;
      d[o + 3] = ink;
      d[o + 4] = em;
      d[o + 5] = fade;
    }
    return n * metrics.charWidth;
  }

  /**
   * The panel header: name, the directory it sits in, and its type.
   *
   * One line tall, laid out by what fits. The name always wins; the type badge
   * and then the path appear as the panel gets wider. Truncation is two dots
   * rather than an ellipsis because the glyph atlas is ASCII.
   */
  private pushHeader(f: SceneFile, zoom: number, hovered: boolean): void {
    const n = f.node;
    const px = metrics.titleHeight * zoom;
    // Below this the glyphs are noise and the bar alone reads as a header.
    const fade = Math.min(1, Math.max(0, (px - 5) / 4));

    this.pushRect(
      this.bgRects, n.x, n.y, n.w, metrics.titleHeight,
      hovered ? this.pal.surface.accent : this.pal.surface.panelBgAlt,
      hovered ? 0.3 : 1, 0, 0,
    );
    // Rule along the header's bottom edge, in the foreground pass so the code
    // below cannot paint over it. Same hairline as the border and the column
    // rules, so the header reads as part of the same frame.
    const rule = HAIRLINE_PX / Math.max(zoom, 1e-6);
    this.pushRect(
      this.fgRects, n.x, n.y + metrics.titleHeight - rule, n.w, rule,
      this.pal.surface.border, 1, 0, 0,
    );
    if (fade <= 0.004) return;

    const room = Math.floor((n.w - 2 * metrics.panelPadX) / metrics.charWidth);
    if (room <= 0) return;

    const x = n.x + metrics.panelPadX;
    const y = n.y;
    const dot = n.name.lastIndexOf('.');
    const ext = dot > 0 ? n.name.slice(dot + 1) : '';
    const dir = n.path.slice(0, Math.max(0, n.path.length - n.name.length - 1));
    const lines = f.node.stub ? '' : compactCount(n.lineCount);

    // Right-aligned, in order: the type badge, then the line count. Both are
    // dropped before the name when space runs short, the badge first because
    // the extension is also visible in the name itself.
    let right = room;
    const badge = ext && room > n.name.length + ext.length + 3 ? ext : '';
    if (badge) {
      right -= badge.length;
      this.pushText(badge, x + right * metrics.charWidth, y, UiInk.Badge, fade, badge.length);
      right -= 1;
    }
    if (lines && right > n.name.length + lines.length + 3) {
      right -= lines.length;
      this.pushText(lines, x + right * metrics.charWidth, y, UiInk.Path, fade, lines.length);
    } else {
      right = room - (badge ? badge.length + 1 : 0);
    }

    const budget = Math.max(1, right - 2);
    const shown =
      n.name.length <= budget ? n.name : `${n.name.slice(0, Math.max(1, budget - 2))}..`;
    const used = this.pushText(shown, x, y, UiInk.Name, fade, budget);

    // The path takes what is left, truncated from the front so the part
    // nearest the file stays readable.
    const pathBudget = budget - shown.length - 2;
    if (dir && pathBudget > 4) {
      const tail = dir.length <= pathBudget ? dir : `..${dir.slice(dir.length - pathBudget + 2)}`;
      this.pushText(
        tail, x + used + 2 * metrics.charWidth, y, UiInk.Path, fade * 0.8, pathBudget,
      );
    }
  }

  /**
   * A stub panel: framed, filled flat, with a rule across it so it does not
   * read as an empty file.
   *
   * Grown to a floor of a pixel and a half on screen. A stub exists to say the
   * file is there, and a stub that vanishes when you zoom out has failed at
   * exactly the moment the overview matters. The floor is deliberately small:
   * any larger and stubs would out-shout the real files around them.
   */
  private pushStub(f: SceneFile, zoom: number): void {
    const n = f.node;
    const floor = STUB_MIN_PX / Math.max(zoom, 1e-6);
    const w = Math.max(n.w, floor * 4);
    const h = Math.max(n.h, floor);
    const hot = f.heat > 0.02;
    // Below a couple of pixels a border would be the whole panel.
    const borderPx = h * zoom > 4 ? 1 : 0;
    this.pushRect(this.bgRects, n.x, n.y, w, h, this.pal.surface.reducedBg, 1, 0, 0);
    if (borderPx > 0) {
      this.pushRect(
        this.fgRects, n.x, n.y, w, h,
        this.pal.surface.reducedBg, 0,
        hot ? this.pal.surface.heat : this.pal.surface.border, borderPx,
      );
    }
    if (h * zoom < 5) return;
    const inset = metrics.panelPadX;
    this.pushRect(
      this.fgRects, n.x + inset, n.y + h / 2 - 0.5, Math.max(0, w - 2 * inset), 1,
      this.pal.surface.reducedInk, 0.65, 0, 0,
    );
  }

  /**
   * A hairline down the middle of each gutter between code columns.
   *
   * A panel that wraps its lines into columns reads as one block of text
   * without them: the eye has no way to tell whether the next column continues
   * the file or starts something new, and at the zoom where the wrapping
   * matters the gutter alone is only a couple of pixels wide. The rule stops
   * short of the header so it does not cut through the file name.
   */
  private pushColumnRules(f: SceneFile, zoom: number): void {
    const g = f.node.geom;
    if (g.columns < 2) return;
    // Below this the rules would be denser than the content they separate.
    if (g.pitch * zoom < 24) return;

    const n = f.node;
    const top = n.y + textOriginY;
    // A world unit short of the bottom, so the rule reads as a separator
    // between columns rather than as part of the frame.
    const height = n.h - textOriginY - metrics.panelPadY - 1;
    if (height <= 0) return;
    // One device pixel whatever the zoom: a rule in world units would vanish
    // zoomed out and turn heavy zoomed in.
    const w = HAIRLINE_PX / Math.max(zoom, 1e-6);

    for (let c = 1; c < g.columns; c++) {
      // Centre of the gutter between column c-1 and column c.
      const x = n.x + textOriginX + c * g.pitch - COLUMN_GUTTER / 2 - w / 2;
      this.pushRect(this.bgRects, x, top, w, height, this.pal.surface.border, 1, 0, 0);
    }
  }

  /** Panel background. The border is a separate pass; see `pushPanelBorder`. */
  private pushPanel(f: SceneFile): void {
    const n = f.node;
    this.pushRect(this.bgRects, n.x, n.y, n.w, n.h, this.pal.surface.panelBg, 1, 0, 0);
  }

  /**
   * The panel's border, drawn after its contents.
   *
   * Separate from the background because everything inside a panel is drawn
   * over that background: the header bar spans the full panel width and the
   * column rules run its full height, so both painted over the border and left
   * panels looking broken along their edges. A border that encloses its
   * contents has to be painted after them.
   */
  private pushPanelBorder(f: SceneFile): void {
    const n = f.node;
    // Recency, not aggregate git state: at any realistic change rate nearly
    // every file has one changed line somewhere, so colouring borders by state
    // lights up the whole canvas and carries no information. Where a change is
    // belongs in the gutter; how recent it is belongs on the border.
    const hot = f.heat > 0.02;
    const border = hot ? this.pal.surface.heat : this.pal.surface.border;
    // A recently changed file thickens and warms its border; otherwise this is
    // the same hairline as everything else in the panel.
    const borderPx = hot ? HAIRLINE_PX + 2 * f.heat : HAIRLINE_PX;
    // Transparent fill, so this draws only the outline over what is there.
    this.pushRect(this.fgRects, n.x, n.y, n.w, n.h, this.pal.surface.panelBg, 0, border, borderPx);
  }

  private overviewBuffer(classIdx: number, chunkIdx: number): InstanceBuffer {
    const key = `${classIdx}:${chunkIdx}`;
    let b = this.overviewByChunk.get(key);
    if (!b) {
      b = new InstanceBuffer(this.gl, OVERVIEW_STRIDE, 1024);
      this.overviewByChunk.set(key, b);
    }
    return b;
  }

  private pushOverview(f: SceneFile, fade: number): void {
    const { node: n, slot } = f;
    const g = n.geom;
    const b = this.overviewBuffer(slot.classIdx, slot.chunkIdx);
    const vTotal = this.textures.vExtent(slot);
    const pitch = columnPitch(g);
    const colW = columnWidth(g);
    const colHeight = g.linesPerColumn * metrics.lineHeight;
    // Screen rows, wrapped lines included, which is what the texture holds
    // and what the columns are filled with.
    const totalRows = f.rows[n.lineCount];

    for (let c = 0; c < g.columns; c++) {
      const first = c * g.linesPerColumn;
      if (first >= totalRows) break;
      const last = Math.min(totalRows, first + g.linesPerColumn);
      // The texture holds the file as a single column, so each code column
      // samples its own slice of the v range.
      const v0 = (first / totalRows) * vTotal;
      const v1 = (last / totalRows) * vTotal;
      const h = ((last - first) / g.linesPerColumn) * colHeight;

      const o = b.alloc();
      const d = b.data;
      d[o] = n.x + textOriginX + c * pitch + textIndent(g);
      d[o + 1] = n.y + textOriginY;
      d[o + 2] = colW;
      d[o + 3] = h;
      d[o + 4] = 0; d[o + 5] = v0; d[o + 6] = 1; d[o + 7] = v1;
      d[o + 8] = slot.layer;
      d[o + 9] = fade;
    }
  }

  private drawOverview(): void {
    const { gl } = this;
    let any = false;
    for (const b of this.overviewByChunk.values()) if (b.count > 0) any = true;
    if (!any) return;

    gl.useProgram(this.progOverview);
    gl.uniformMatrix3fv(this.uOverview.uView, false, this.view);
    gl.uniform1i(this.uOverview.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);

    for (const [key, b] of this.overviewByChunk) {
      if (b.count === 0) continue;
      const [ci, chi] = key.split(':').map(Number);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textures.texture(ci, chi));
      b.upload();
      quadAttrib(gl, this.progOverview, this.quad);
      gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
      instanceAttribs(gl, this.progOverview, OVERVIEW_STRIDE, [
        ['aRect', 4, 0], ['aUv', 4, 4], ['aLayerFade', 2, 8],
      ]);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.count);
    }
  }

  /** Which lines of which code columns of this file are on screen. */
  /**
   * Which lines of which code columns of this file are on screen.
   *
   * `colX` is where the column's text begins, past the line-number margin.
   * The margin is part of the layout, so every pass that draws into a column
   * has to skip it, and having `visibleRuns` return the text origin rather
   * than the column origin means none of them can forget.
   */
  /**
   * Which screen rows of which code columns of this file are on screen.
   *
   * Rows rather than source lines, because a wrapped line occupies several
   * rows and the passes lay out by row. `colX` is where the column's text
   * begins, past the line-number margin, so no pass can forget the margin.
   */
  private *visibleRuns(
    f: SceneFile, vx0: number, vy0: number, vx1: number, vy1: number,
  ): Generator<[column: number, colX: number, firstRow: number, lastRow: number]> {
    const g = f.node.geom;
    const pitch = columnPitch(g);
    const colW = columnWidth(g);
    const yBase = f.node.y + textOriginY;
    const indent = textIndent(g);
    const totalRows = f.rows[f.data.lineCount];

    for (let c = 0; c < g.columns; c++) {
      const colX = f.node.x + textOriginX + c * pitch + indent;
      if (colX > vx1 || colX + colW < vx0) continue;
      const rowFrom = Math.max(0, Math.floor((vy0 - yBase) / metrics.lineHeight));
      const rowTo = Math.min(
        g.linesPerColumn - 1,
        Math.ceil((vy1 - yBase) / metrics.lineHeight),
      );
      if (rowTo < rowFrom) continue;
      const first = c * g.linesPerColumn + rowFrom;
      const last = Math.min(totalRows - 1, c * g.linesPerColumn + rowTo);
      if (last < first) continue;
      yield [c, colX, first, last];
    }
  }

  /**
   * The source line and wrap index at a screen row, and the row's y offset
   * within its column.
   */
  private rowInfo(f: SceneFile, row: number, column: number) {
    const line = lineAtRow(f.rows, row);
    return {
      line,
      /** Which wrapped row of that line this is, 0 for the first. */
      wrap: row - f.rows[line],
      y:
        f.node.y +
        textOriginY +
        (row - column * f.node.geom.linesPerColumn) * metrics.lineHeight,
    };
  }

  private pushSpans(
    f: SceneFile, fade: number, pxPerLine: number,
    vx0: number, vy0: number, vx1: number, vy1: number,
  ): void {
    const b = this.spans;
    const d0 = f.data;
    const g = f.node.geom;
    const h = metrics.lineHeight * spanBarHeight(pxPerLine);
    const yOff = (metrics.lineHeight - h) * 0.5;

    for (const [c, colX, firstRow, lastRow] of this.visibleRuns(f, vx0, vy0, vx1, vy1)) {
      for (let row = firstRow; row <= lastRow; row++) {
        const { line, wrap, y } = this.rowInfo(f, row, c);
        // The character range of the source line that lands on this row.
        const from = wrap * g.cols;
        const to = from + g.cols;
        const s0 = d0.spanStart[line];
        const s1 = d0.spanStart[line + 1];
        for (let s = s0; s < s1; s++) {
          const p = d0.spans[s];
          const col = spanCol(p);
          const end = col + spanLen(p);
          // Clip the span to this row's slice rather than to the column: a
          // span that starts before the slice continues into it.
          if (end <= from || col >= to) continue;
          const lo = Math.max(col, from);
          const hi = Math.min(end, to);
          const o = b.alloc();
          const dd = b.data;
          dd[o] = colX + (lo - from) * metrics.charWidth;
          dd[o + 1] = y + yOff;
          dd[o + 2] = (hi - lo) * metrics.charWidth;
          dd[o + 3] = h;
          dd[o + 4] = spanKind(p);
          dd[o + 5] = fade;
        }
      }
    }
  }

  private drawSpans(): void {
    if (this.spans.count === 0) return;
    const { gl } = this;
    gl.useProgram(this.progSpan);
    gl.uniformMatrix3fv(this.uSpan.uView, false, this.view);
    gl.uniform3fv(this.uSpan['uKind[0]'], this.kindFlat);
    this.spans.upload();
    quadAttrib(gl, this.progSpan, this.quad);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spans.buf);
    instanceAttribs(gl, this.progSpan, SPAN_STRIDE, [['aRect', 4, 0], ['aKindFade', 2, 4]]);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.spans.count);
  }

  /**
   * Line numbers down the left of each code column.
   *
   * Only once text is readable, and only where the column is wide enough that
   * the gutter is not eating the code: a number costs four to six characters
   * of a column that may only have thirty, so below a threshold the code is
   * worth more than knowing which line it is.
   *
   * Right-aligned in the gutter, in the faint ink, so they read as a margin
   * rather than as content. They sit in the column's own gutter space, which
   * is why they do not shift the text: the gutter exists between columns
   * anyway and the first column's is the panel padding.
   */
  private pushLineNumbers(
    f: SceneFile, fade: number, vx0: number, vy0: number, vx1: number, vy1: number,
  ): void {
    const g = f.node.geom;
    // The layout decides whether there is a margin at all; see numberColsFor.
    if (g.numberCols === 0) return;

    for (const [c, colX, firstRow, lastRow] of this.visibleRuns(f, vx0, vy0, vx1, vy1)) {
      for (let row = firstRow; row <= lastRow; row++) {
        const { line, wrap, y } = this.rowInfo(f, row, c);
        // Continuation rows carry no number: the number belongs to the source
        // line, and repeating it would claim there are more lines than there
        // are.
        if (wrap !== 0) continue;
        const label = String(line + 1);
        // Right-aligned against the text, inside the reserved margin.
        const x = colX - (label.length + 1) * metrics.charWidth;
        this.pushText(label, x, y, UiInk.Path, fade * 0.7, label.length);
      }
    }
  }

  private pushGlyphs(
    f: SceneFile, fade: number, vx0: number, vy0: number, vx1: number, vy1: number,
  ): void {
    const b = this.glyphs;
    const g = f.node.geom;
    const em = metrics.charWidth / this.atlas.advanceRatio;
    const d0 = f.data;

    for (const [c, colX, firstRow, lastRow] of this.visibleRuns(f, vx0, vy0, vx1, vy1)) {
      for (let row = firstRow; row <= lastRow; row++) {
        const { line, wrap, y } = this.rowInfo(f, row, c);
        const text = this.text.lineText(f.node.path, line);
        if (!text) continue;
        const from = wrap * g.cols;
        const to = from + g.cols;
        const s0 = d0.spanStart[line];
        const s1 = d0.spanStart[line + 1];
        for (let s = s0; s < s1; s++) {
          const p = d0.spans[s];
          const col = spanCol(p);
          const end = col + spanLen(p);
          if (end <= from || col >= to) continue;
          const kind = spanKind(p);
          const lo = Math.max(col, from);
          const hi = Math.min(end, to);
          for (let k = lo; k < hi; k++) {
            const idx = GlyphAtlas.index(text.charCodeAt(k));
            if (idx < 0) continue;
            const o = b.alloc();
            const dd = b.data;
            dd[o] = colX + (k - from) * metrics.charWidth;
            dd[o + 1] = y;
            dd[o + 2] = idx;
            dd[o + 3] = kind;
            dd[o + 4] = em;
            dd[o + 5] = fade;
          }
        }
      }
    }
  }

  private drawGlyphs(pxPerLine: number, dpr: number): void {
    if (this.glyphs.count === 0) return;
    const { gl } = this;
    const em = (metrics.charWidth / this.atlas.advanceRatio) * (pxPerLine / metrics.lineHeight);
    const level = this.atlas.pick(em * dpr);

    gl.useProgram(this.progGlyph);
    gl.uniformMatrix3fv(this.uGlyph.uView, false, this.view);
    gl.uniform3fv(this.uGlyph['uKind[0]'], this.kindFlat);
    gl.uniform1i(this.uGlyph.uAtlas, 0);
    gl.uniform2f(
      this.uGlyph.uCell,
      level.cellW / level.texW,
      level.cellH / level.texH,
    );
    // The glyph box in em units, matching how the atlas cells were laid out.
    gl.uniform2f(
      this.uGlyph.uGlyphScale,
      level.cellW / level.size,
      level.cellH / level.size,
    );
    gl.uniform1f(this.uGlyph.uGridCols, GlyphAtlas.gridCols);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, level.tex);

    this.glyphs.upload();
    quadAttrib(gl, this.progGlyph, this.quad);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphs.buf);
    instanceAttribs(gl, this.progGlyph, GLYPH_STRIDE, [
      ['aPosGlyph', 4, 0], ['aSizeFade', 2, 4],
    ]);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.glyphs.count);
  }

  /** A change marker in the left margin of every changed line. Visible from
   *  the moment lines are resolvable at all, which is the point: you should be
   *  able to see where the repo is moving without zooming in. */
  private pushGutter(f: SceneFile, vy0: number, vy1: number): void {
    const w = Math.max(2, metrics.charWidth * 0.4);
    const [vx0, vx1] = [-Infinity, Infinity];

    for (const [c, colX, firstRow, lastRow] of this.visibleRuns(f, vx0, vy0, vx1, vy1)) {
      for (let row = firstRow; row <= lastRow; row++) {
        const { line, wrap, y } = this.rowInfo(f, row, c);
        // One marker per source line, on its first row: a wrapped line is one
        // change, not three.
        if (wrap !== 0) continue;
        const st = f.data.lineState[line];
        if (st === LineState.Unchanged) continue;
        const color =
          st === LineState.Added ? this.pal.surface.added
            : st === LineState.Modified ? this.pal.surface.modified
              : this.pal.surface.deleted;
        this.pushRect(
          this.fgRects, colX - w - 1, y, w, metrics.lineHeight, color, 0.85, 0, 0,
        );
      }
    }
  }
}
