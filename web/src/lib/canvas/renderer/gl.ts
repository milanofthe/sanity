// Thin WebGL2 helpers. Deliberately not an abstraction layer: just enough to
// keep the passes readable.

export type GL = WebGL2RenderingContext;

export function createContext(canvas: HTMLCanvasElement): GL {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    desynchronized: true,
    powerPreference: 'high-performance',
    // So a frame can be skipped when nothing changed. WebGL clears the drawing
    // buffer after every composite unless this is set, which would turn a
    // skipped frame into a blank canvas. The cost is a blit per composite
    // instead of re-rendering thousands of quads sixty times a second at a
    // canvas nobody is touching.
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error('WebGL2 is not available');
  return gl;
}

function compile(gl: GL, type: number, src: string, label: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`${label} shader failed: ${log}`);
  }
  return sh;
}

export function createProgram(gl: GL, vsSrc: string, fsSrc: string, label = 'program'): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc, `${label} vertex`);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc, `${label} fragment`);
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`${label} link failed: ${log}`);
  }
  return p;
}

export function uniforms(gl: GL, p: WebGLProgram, names: string[]): Record<string, WebGLUniformLocation | null> {
  const out: Record<string, WebGLUniformLocation | null> = {};
  for (const n of names) out[n] = gl.getUniformLocation(p, n);
  return out;
}

/** A unit quad shared by every instanced pass: corners (0,0) to (1,1). */
export function unitQuad(gl: GL): WebGLBuffer {
  const b = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  return b;
}

/**
 * A growable instance buffer written from a CPU-side Float32Array. Instance
 * data is rebuilt whenever the visible set or the LOD changes, which is far
 * cheaper than it sounds because the LOD system guarantees the count stays
 * small wherever detail is high.
 */
export class InstanceBuffer {
  buf: WebGLBuffer;
  data: Float32Array;
  /** Number of floats per instance. */
  readonly stride: number;
  count = 0;
  private capacity: number;

  constructor(private gl: GL, stride: number, initialInstances = 4096) {
    this.stride = stride;
    this.capacity = initialInstances;
    this.data = new Float32Array(initialInstances * stride);
    this.buf = gl.createBuffer()!;
  }

  reset(): void {
    this.count = 0;
  }

  /**
   * Make room for `extra` more instances, so a hot loop can hold `data` and a
   * cursor instead of calling `alloc` per instance.
   *
   * `alloc` may replace `data` when it grows, which is why the loops that
   * write thousands of instances cannot hoist it without reserving first.
   */
  reserve(extra: number): void {
    const need = this.count + extra;
    if (need <= this.capacity) return;
    while (this.capacity < need) this.capacity *= 2;
    const next = new Float32Array(this.capacity * this.stride);
    next.set(this.data);
    this.data = next;
  }

  /** Returns the float offset at which to write one instance, growing first. */
  alloc(): number {
    if (this.count >= this.capacity) {
      this.capacity *= 2;
      const next = new Float32Array(this.capacity * this.stride);
      next.set(this.data);
      this.data = next;
    }
    return this.count++ * this.stride;
  }

  upload(): void {
    if (this.count === 0) return;
    const { gl } = this;
    const floats = this.count * this.stride;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    // Orphan the buffer so the driver does not stall on the previous frame,
    // but only for what is actually in it. Orphaning the whole capacity threw
    // away and reallocated three megabytes a frame at a view with four hundred
    // quads in it, because the span and glyph buffers are sized for sixty-five
    // thousand and keep that size once they have grown.
    gl.bufferData(gl.ARRAY_BUFFER, floats * 4, gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, floats);
  }
}

/** Declares interleaved instanced float attributes in one call. */
export function instanceAttribs(
  gl: GL,
  p: WebGLProgram,
  strideFloats: number,
  attrs: [name: string, size: number, offsetFloats: number][],
): void {
  const strideBytes = strideFloats * 4;
  for (const [name, size, off] of attrs) {
    const loc = gl.getAttribLocation(p, name);
    if (loc < 0) continue;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, strideBytes, off * 4);
    gl.vertexAttribDivisor(loc, 1);
  }
}

export function quadAttrib(gl: GL, p: WebGLProgram, buf: WebGLBuffer, name = 'aCorner'): void {
  const loc = gl.getAttribLocation(p, name);
  if (loc < 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(loc, 0);
}
