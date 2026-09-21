// The scene: owns the GPU resources, decides the level of detail per file and
// builds this frame's instance data.
//
// The load-bearing property is that detail and count trade off against each
// other. Zoomed out, every file is a handful of textured quads, so the frame
// cost is proportional to the file count and nothing else. Zoomed in, token
// and glyph geometry appears, but by then only a few files intersect the
// viewport and only a few hundred of their lines do, so the instance count
// stays in the tens of thousands no matter how large the repository is.

import { Camera } from '../camera';
import { kindColors, lodThresholds, metrics, palette, rgb, timing } from '../tokens';
import { LineState, spanCol, spanKind, spanLen, type FileData } from '../data/wire';
import { COLUMN_GUTTER, textOriginX, textOriginY } from '../layout/panel';
import type { DirNode, FileNode, Layout } from '../layout/tree';
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

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

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
  private kindFlat = new Float32Array(kindColors.length * 3);

  files = new Map<string, SceneFile>();
  stats: FrameStats = {
    visibleFiles: 0, overviewQuads: 0, spanQuads: 0, glyphQuads: 0,
    rectQuads: 0, pxPerLine: 0, cpuMs: 0,
  };

  constructor(gl: GL, public layout: Layout, private text: TextSource) {
    this.gl = gl;
    this.quad = unitQuad(gl);
    this.textures = new OverviewTextures(gl);
    this.atlas = new GlyphAtlas(gl);

    this.progRect = createProgram(gl, rectVS, rectFS, 'rect');
    this.progOverview = createProgram(gl, overviewVS, overviewFS, 'overview');
    this.progSpan = createProgram(gl, spanVS, spanFS, 'span');
    this.progGlyph = createProgram(gl, glyphVS, glyphFS, 'glyph');
    this.uRect = uniforms(gl, this.progRect, ['uView', 'uScale']);
    this.uOverview = uniforms(gl, this.progOverview, ['uView', 'uTex']);
    this.uSpan = uniforms(gl, this.progSpan, ['uView', 'uKind[0]']);
    this.uGlyph = uniforms(gl, this.progGlyph, [
      'uView', 'uKind[0]', 'uAtlas', 'uCell', 'uGlyphScale', 'uGridCols',
    ]);

    this.bgRects = new InstanceBuffer(gl, RECT_STRIDE, 2048);
    this.fgRects = new InstanceBuffer(gl, RECT_STRIDE, 2048);
    this.spans = new InstanceBuffer(gl, SPAN_STRIDE, 65536);
    this.glyphs = new InstanceBuffer(gl, GLYPH_STRIDE, 65536);

    kindColors.forEach((hex, i) => {
      const [r, g, b] = rgb(hex);
      this.kindFlat[i * 3] = r;
      this.kindFlat[i * 3 + 1] = g;
      this.kindFlat[i * 3 + 2] = b;
    });

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  addFile(node: FileNode, data: FileData): void {
    const slot = this.textures.allocate(data.lineCount);
    node.layer = slot.layer;
    let state: LineState = LineState.Unchanged;
    for (let i = 0; i < data.lineState.length; i++) {
      if (data.lineState[i] !== LineState.Unchanged) {
        state = data.lineState[i] as LineState;
        break;
      }
    }
    this.textures.write(slot, data, node.geom.cols);
    this.files.set(node.path, { node, data, slot, heat: 0, state });
  }

  /** Called when the watcher reports a file changed on disk. */
  touch(path: string, data?: FileData): void {
    const f = this.files.get(path);
    if (!f) return;
    if (data) {
      f.data = data;
      this.textures.write(f.slot, data, f.node.geom.cols);
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

  private drawRects(b: InstanceBuffer, scale: number): void {
    if (b.count === 0) return;
    const { gl } = this;
    gl.useProgram(this.progRect);
    gl.uniformMatrix3fv(this.uRect.uView, false, this.view);
    gl.uniform1f(this.uRect.uScale, scale);
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

    // Two crossfades, not four: the overview texture covers everything from a
    // single averaged pixel up to the point where token geometry takes over.
    const spanFade =
      smoothstep(lodThresholds.texture, lodThresholds.texture * 1.5, pxPerLine) *
      (1 - smoothstep(lodThresholds.spans, lodThresholds.spans * 1.3, pxPerLine));
    const glyphFade = smoothstep(lodThresholds.glyphs, lodThresholds.glyphs * 1.3, pxPerLine);
    const overviewFade = 1 - Math.max(spanFade, glyphFade);

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
      this.pushDir(d);
    }

    let visibleFiles = 0;
    for (const f of this.files.values()) {
      const n = f.node;
      if (n.x > vx1 || n.y > vy1 || n.x + n.w < vx0 || n.y + n.h < vy0) continue;
      visibleFiles++;

      if (f.heat > 0) f.heat = Math.max(0, f.heat - dt / timing.heatDecay);

      this.pushPanel(f, pxPerLine);
      if (overviewFade > 0.004) this.pushOverview(f, overviewFade);
      if (spanFade > 0.004) this.pushSpans(f, spanFade, vx0, vy0, vx1, vy1);
      if (glyphFade > 0.004) this.pushGlyphs(f, glyphFade, vx0, vy0, vx1, vy1);
      if (pxPerLine >= lodThresholds.texture) this.pushGutter(f, vy0, vy1);
    }

    // Draw.
    const [br, bg, bb] = rgb(palette.bg);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(br, bg, bb, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const scale = cam.zoom * cam.dpr;
    this.drawRects(this.bgRects, scale);
    this.drawOverview();
    this.drawSpans();
    this.drawGlyphs(pxPerLine, cam.dpr);
    this.drawRects(this.fgRects, scale);

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

  private pushDir(d: DirNode): void {
    const shade = d.depth % 2 === 0 ? palette.dirBg : palette.panelBgAlt;
    this.pushRect(this.bgRects, d.x, d.y, d.w, d.h, shade, 1, palette.border, 1);
  }

  private pushPanel(f: SceneFile, pxPerLine: number): void {
    const n = f.node;
    // Recency, not aggregate git state: at any realistic change rate nearly
    // every file has one changed line somewhere, so colouring borders by state
    // lights up the whole canvas and carries no information. Where a change is
    // belongs in the gutter; how recent it is belongs on the border.
    const hot = f.heat > 0.02;
    const border = hot ? palette.heat : palette.border;
    const borderPx = hot ? 1 + 2 * f.heat : 1;
    this.pushRect(this.bgRects, n.x, n.y, n.w, n.h, palette.panelBg, 1, border, borderPx);

    // Title bar, only once it is tall enough to mean anything.
    if (pxPerLine >= lodThresholds.texture) {
      this.pushRect(
        this.bgRects, n.x, n.y, n.w, metrics.titleHeight,
        palette.panelBgAlt, 1, palette.border, 0,
      );
    }
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
    const colWidth = g.cols * metrics.charWidth;
    const colHeight = g.linesPerColumn * metrics.lineHeight;

    for (let c = 0; c < g.columns; c++) {
      const first = c * g.linesPerColumn;
      if (first >= n.lineCount) break;
      const last = Math.min(n.lineCount, first + g.linesPerColumn);
      // The texture holds the file as a single column, so each code column
      // samples its own slice of the v range.
      const v0 = (first / n.lineCount) * vTotal;
      const v1 = (last / n.lineCount) * vTotal;
      const h = ((last - first) / g.linesPerColumn) * colHeight;

      const o = b.alloc();
      const d = b.data;
      d[o] = n.x + textOriginX + c * (colWidth + COLUMN_GUTTER);
      d[o + 1] = n.y + textOriginY;
      d[o + 2] = colWidth;
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
  private *visibleRuns(
    f: SceneFile, vx0: number, vy0: number, vx1: number, vy1: number,
  ): Generator<[column: number, colX: number, first: number, last: number]> {
    const g = f.node.geom;
    const colWidth = g.cols * metrics.charWidth;
    const yBase = f.node.y + textOriginY;
    for (let c = 0; c < g.columns; c++) {
      const colX = f.node.x + textOriginX + c * (colWidth + COLUMN_GUTTER);
      if (colX > vx1 || colX + colWidth < vx0) continue;
      const rowFrom = Math.max(0, Math.floor((vy0 - yBase) / metrics.lineHeight));
      const rowTo = Math.min(
        g.linesPerColumn - 1,
        Math.ceil((vy1 - yBase) / metrics.lineHeight),
      );
      if (rowTo < rowFrom) continue;
      const first = c * g.linesPerColumn + rowFrom;
      const last = Math.min(f.data.lineCount - 1, c * g.linesPerColumn + rowTo);
      if (last < first) continue;
      yield [c, colX, first, last];
    }
  }

  private pushSpans(
    f: SceneFile, fade: number, vx0: number, vy0: number, vx1: number, vy1: number,
  ): void {
    const b = this.spans;
    const d0 = f.data;
    const yBase = f.node.y + textOriginY;
    const g = f.node.geom;
    const h = metrics.lineHeight * 0.68;
    const yOff = (metrics.lineHeight - h) * 0.5;

    for (const [c, colX, first, last] of this.visibleRuns(f, vx0, vy0, vx1, vy1)) {
      for (let i = first; i <= last; i++) {
        const y = yBase + (i - c * g.linesPerColumn) * metrics.lineHeight + yOff;
        const s0 = d0.spanStart[i];
        const s1 = d0.spanStart[i + 1];
        for (let s = s0; s < s1; s++) {
          const p = d0.spans[s];
          const o = b.alloc();
          const dd = b.data;
          dd[o] = colX + spanCol(p) * metrics.charWidth;
          dd[o + 1] = y;
          dd[o + 2] = spanLen(p) * metrics.charWidth;
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

  private pushGlyphs(
    f: SceneFile, fade: number, vx0: number, vy0: number, vx1: number, vy1: number,
  ): void {
    const b = this.glyphs;
    const g = f.node.geom;
    const yBase = f.node.y + textOriginY;
    const em = metrics.charWidth / this.atlas.advanceRatio;
    const d0 = f.data;

    for (const [c, colX, first, last] of this.visibleRuns(f, vx0, vy0, vx1, vy1)) {
      for (let i = first; i <= last; i++) {
        const text = this.text.lineText(f.node.path, i);
        if (!text) continue;
        const y = yBase + (i - c * g.linesPerColumn) * metrics.lineHeight;
        const s0 = d0.spanStart[i];
        const s1 = d0.spanStart[i + 1];
        for (let s = s0; s < s1; s++) {
          const p = d0.spans[s];
          const col = spanCol(p);
          const len = spanLen(p);
          const kind = spanKind(p);
          for (let k = 0; k < len; k++) {
            const idx = GlyphAtlas.index(text.charCodeAt(col + k));
            if (idx < 0) continue;
            const o = b.alloc();
            const dd = b.data;
            dd[o] = colX + (col + k) * metrics.charWidth;
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
    const g = f.node.geom;
    const yBase = f.node.y + textOriginY;
    const colWidth = g.cols * metrics.charWidth;
    const w = Math.max(2, metrics.charWidth * 0.4);

    for (let c = 0; c < g.columns; c++) {
      const colX = f.node.x + textOriginX + c * (colWidth + COLUMN_GUTTER);
      const rowFrom = Math.max(0, Math.floor((vy0 - yBase) / metrics.lineHeight));
      const rowTo = Math.min(g.linesPerColumn - 1, Math.ceil((vy1 - yBase) / metrics.lineHeight));
      for (let r = rowFrom; r <= rowTo; r++) {
        const i = c * g.linesPerColumn + r;
        if (i >= f.data.lineCount) break;
        const st = f.data.lineState[i];
        if (st === LineState.Unchanged) continue;
        const color =
          st === LineState.Added ? palette.added
            : st === LineState.Modified ? palette.modified
              : palette.deleted;
        this.pushRect(
          this.fgRects, colX - w - 1, yBase + r * metrics.lineHeight,
          w, metrics.lineHeight, color, 0.85, 0, 0,
        );
      }
    }
  }
}
