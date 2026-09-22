// Resampling a picture to an exact size on the GPU; see `resampleFS`.

import { createProgram, uniforms, type GL } from './gl';
import { resampleFS, resampleVS } from './shaders';

/** Most taps per axis the shader takes; see `resampleFS`. */
const MAX_TAPS = 16;

export class Resampler {
  private gl: GL;
  private prog: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null>;
  private fbo: WebGLFramebuffer;
  private vao: WebGLVertexArrayObject;

  constructor(gl: GL) {
    this.gl = gl;
    this.prog = createProgram(gl, resampleVS, resampleFS, 'resample');
    this.u = uniforms(gl, this.prog, ['uSrc', 'uSrcSize', 'uDstSize', 'uLod', 'uTaps']);
    this.fbo = gl.createFramebuffer()!;
    // An empty vertex array: the triangle comes from gl_VertexID, and drawing
    // with whatever array the renderer left bound would read its attributes.
    this.vao = gl.createVertexArray()!;
  }

  /**
   * A new texture of `dw` by `dh` holding `src` averaged down to it, with a
   * mip chain so it can still be drawn smaller while the camera moves.
   *
   * `src` must have a mip chain of its own when it is more than sixteen times
   * the target, which is the only case the shader reads past level zero.
   */
  resample(src: WebGLTexture, sw: number, sh: number, dw: number, dh: number): WebGLTexture {
    const { gl } = this;
    const out = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, out);
    const levels = 1 + Math.floor(Math.log2(Math.max(dw, dh)));
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, dw, dh);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const scale = Math.max(sw / dw, sh / dh, 1);
    const lod = Math.max(0, Math.ceil(Math.log2(scale / MAX_TAPS)));
    const taps = Math.max(1, Math.min(MAX_TAPS, Math.ceil(scale / 2 ** lod)));

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out, 0);
    gl.viewport(0, 0, dw, dh);
    gl.disable(gl.BLEND);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(this.u.uSrc, 0);
    gl.uniform2f(this.u.uSrcSize, sw, sh);
    gl.uniform2f(this.u.uDstSize, dw, dh);
    gl.uniform1f(this.u.uLod, lod);
    gl.uniform1i(this.u.uTaps, taps);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    gl.bindTexture(gl.TEXTURE_2D, out);
    gl.generateMipmap(gl.TEXTURE_2D);
    return out;
  }
}
