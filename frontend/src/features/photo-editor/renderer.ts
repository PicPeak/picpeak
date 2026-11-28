/**
 * Draws the live preview of an edit (issue 2619) onto a canvas: WebGL2,
 * else WebGL1 (the same GLSL, without the detail texture), else a Canvas 2D
 * pass on the CPU over a smaller copy. The base is the unedited photo at
 * about 2000 px: an 8-bit JPEG, or for a camera RAW the server's 16-bit
 * linear develop (WebGL2 only). Nothing goes to the server while a slider
 * moves.
 */
import {
  type EditParams, type OutputSize, type PixelRect, type Prepared, type ToneStats, DEFAULT_PARAMS, LUMA, clamp01,
  detailTexture, effectiveCrop, frameSize, inverseAffine, linearPixels, linearToSrgb, outputPixel, outputSize, prepare,
  RAW_SIGMOID, scenePixel, toneStats,
} from './editMath';
import { FRAGMENT_SHADER, VERTEX_SHADER } from './shader';

export type RenderBackend = 'webgl2' | 'webgl' | 'canvas';
/** edit: the result; before: the photo untouched; frame: the whole turned frame, for cropping. */
export type ViewMode = 'edit' | 'before' | 'frame';
export interface ViewSize { width: number; height: number; crop: PixelRect }

/** A RAW's develop preview: 16-bit linear RGB and what the server measured. */
export interface RawBase { width: number; height: number; data: Uint16Array; exposureBias: number }

type GL = WebGLRenderingContext | WebGL2RenderingContext;
type Source = ImageBitmap | HTMLImageElement | HTMLCanvasElement;

// The canvas 2D fallback renders at most this many pixels a frame.
const CPU_MAX_PIXELS = 640 * 480;
const BACKGROUND = [0.09, 0.09, 0.09];

/** The view's size and the inverse map to draw it with, in base-image pixels. */
export function viewGeometry(params: EditParams, width: number, height: number, mode: ViewMode, maxPixels = Infinity) {
  if (mode === 'before') {
    const out = outputSize(DEFAULT_PARAMS, width, height, { maxPixels });
    return { out, map: inverseAffine(DEFAULT_PARAMS, width, height, out) };
  }
  if (mode === 'frame') {
    // The whole frame after turning and straightening; the crop is drawn over it.
    const frame = frameSize(params, width, height);
    const scale = Math.min(1, Math.sqrt(maxPixels / (frame.width * frame.height)));
    const out: OutputSize = {
      width: Math.max(1, Math.round(frame.width * scale)),
      height: Math.max(1, Math.round(frame.height * scale)),
      crop: { left: 0, top: 0, width: frame.width, height: frame.height },
    };
    return { out, map: inverseAffine(params, width, height, out) };
  }
  const out = outputSize(params, width, height, { maxPixels });
  return { out, map: inverseAffine(params, width, height, out) };
}

function readRgba(source: Source, width: number, height: number): Uint8ClampedArray {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D is not available');
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height).data;
}

/** RGB floats as RGBA, the layout every WebGL version uploads. */
function toRgba(rgb: Float32Array, count: number): Float32Array {
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    out[i * 4] = rgb[i * 3];
    out[i * 4 + 1] = rgb[i * 3 + 1];
    out[i * 4 + 2] = rgb[i * 3 + 2];
    out[i * 4 + 3] = 1;
  }
  return out;
}

export class EditRenderer {
  readonly backend: RenderBackend;
  readonly width: number;
  readonly height: number;
  /** True when the base is a RAW develop (linear light, the RAW look). */
  readonly linear: boolean;
  readonly exposureBias: number;
  /**
   * The canvas it draws on, its own: the editor mounts it. A canvas keeps the
   * kind of context it first gave out, so each fallback below needs a fresh
   * one; a canvas the caller passed in could not be swapped.
   */
  readonly canvas: HTMLCanvasElement;
  /** The base as linear light, RGB: textures, statistics and the CPU path read it. */
  private readonly light: Float32Array;
  private gl: GL | null = null;
  private program: WebGLProgram | null = null;
  private textures: WebGLTexture[] = [];
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private hasDetail = false;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private prepared: { params: EditParams; prep: Prepared } | null = null;

  constructor(source: Source | RawBase, { allowGl = true } = {}) {
    const raw = 'data' in source ? source : null;
    this.linear = Boolean(raw);
    this.exposureBias = raw ? raw.exposureBias : 0;
    if (raw) {
      this.width = raw.width;
      this.height = raw.height;
      this.light = linearPixels({ rgb16: raw.data }, raw.width * raw.height);
    } else {
      const image = source as Source;
      this.width = 'naturalWidth' in image ? image.naturalWidth : image.width;
      this.height = 'naturalHeight' in image ? image.naturalHeight : image.height;
      this.light = linearPixels({ rgba: readRgba(image, this.width, this.height) }, this.width * this.height);
    }
    const options = { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true, alpha: false };
    let canvas = document.createElement('canvas');
    const gl2 = allowGl ? (canvas.getContext('webgl2', options) as WebGL2RenderingContext | null) : null;
    if (gl2 && this.initGl(gl2, source, true)) this.backend = 'webgl2';
    else {
      if (raw) throw new Error('A RAW develop needs WebGL 2');
      if (gl2) {
        this.release(gl2);
        canvas = document.createElement('canvas');
      }
      const gl1 = allowGl ? (canvas.getContext('webgl', options) as WebGLRenderingContext | null) : null;
      if (gl1 && this.initGl(gl1, source, false)) this.backend = 'webgl';
      else {
        if (gl1) {
          this.release(gl1);
          canvas = document.createElement('canvas');
        }
        this.ctx2d = canvas.getContext('2d');
        if (!this.ctx2d) throw new Error('This browser cannot draw the preview');
        this.backend = 'canvas';
      }
    }
    this.canvas = canvas;
  }

  /** Levels of the base for Auto tone (linear luminance, after the RAW baseline). */
  toneStats(): ToneStats {
    const baseline = this.linear ? prepare(DEFAULT_PARAMS, { linear: true, exposureBias: this.exposureBias }).baseline : 1;
    const step = Math.max(1, Math.floor((this.width * this.height) / 250000));
    const values: number[] = [];
    for (let i = 0; i < this.width * this.height; i += step) {
      values.push((LUMA[0] * this.light[i * 3] + LUMA[1] * this.light[i * 3 + 1] + LUMA[2] * this.light[i * 3 + 2]) * baseline);
    }
    return toneStats(values);
  }

  private initGl(gl: GL, source: Source | RawBase, floats: boolean): boolean {
    const compile = (type: number, text: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, text);
      gl.compileShader(shader);
      return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
    };
    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) return false;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
    gl.useProgram(program);

    // One triangle that covers the viewport.
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const texture = (unit: number, upload: () => void) => {
      const tex = gl.createTexture();
      if (!tex) return null;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // Bilinear, edges clamped: the server samples the same way.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      upload();
      return tex;
    };
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    const count = this.width * this.height;
    const gl2 = gl as WebGL2RenderingContext;
    const image = texture(0, () => {
      if ('data' in source) {
        // Linear light needs more than 8 bits: half floats keep the shadows.
        gl2.texImage2D(gl.TEXTURE_2D, 0, gl2.RGBA16F, this.width, this.height, 0, gl.RGBA, gl.FLOAT,
          toRgba(Float32Array.from(source.data, (v) => v / 65535), count));
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      }
    });
    let detail: WebGLTexture | null = null;
    if (floats) {
      detail = texture(1, () => gl2.texImage2D(gl.TEXTURE_2D, 0, gl2.RGBA16F, this.width, this.height, 0, gl.RGBA, gl.FLOAT,
        detailTexture(this.baselineLight(), this.width, this.height)));
    }
    if (!image || gl.getError() !== gl.NO_ERROR) return false;
    this.textures = detail ? [image, detail] : [image];
    this.hasDetail = Boolean(detail);

    for (const name of ['u_image', 'u_detail', 'u_srcSize', 'u_outSize', 'u_mapX', 'u_mapY', 'u_linear', 'u_baseline', 'u_hasDetail',
      'u_matrix', 'u_local', 'u_tone', 'u_ends', 'u_shoulder', 'u_sigmoid', 'u_plain', 'u_background']) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    gl.uniform1i(this.uniforms.u_image, 0);
    gl.uniform1i(this.uniforms.u_detail, 1);
    gl.uniform2f(this.uniforms.u_srcSize, this.width, this.height);
    gl.uniform1f(this.uniforms.u_linear, this.linear ? 1 : 0);
    gl.uniform1f(this.uniforms.u_hasDetail, this.hasDetail ? 1 : 0);
    gl.uniform3f(this.uniforms.u_sigmoid, RAW_SIGMOID.n, RAW_SIGMOID.phi, RAW_SIGMOID.e);
    gl.uniform3f(this.uniforms.u_background, BACKGROUND[0], BACKGROUND[1], BACKGROUND[2]);
    this.gl = gl;
    this.program = program;
    return true;
  }

  /** The base's linear light as the pipeline decodes it (RAW: times the baseline). */
  private baselineLight(): Float32Array {
    if (!this.linear) return this.light;
    const baseline = prepare(DEFAULT_PARAMS, { linear: true, exposureBias: this.exposureBias }).baseline;
    return Float32Array.from(this.light, (v) => v * baseline);
  }

  private prep(params: EditParams): Prepared {
    if (this.prepared?.params !== params) {
      this.prepared = { params, prep: prepare(params, { linear: this.linear, exposureBias: this.exposureBias }) };
    }
    return this.prepared.prep;
  }

  /** Draw the view; the canvas takes its size. One draw call on the GPU backends. */
  render(params: EditParams, mode: ViewMode = 'edit'): ViewSize {
    if (this.gl) return this.renderGl(this.gl, params, mode);
    return this.renderCpu(params, mode);
  }

  private resize(width: number, height: number) {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  private renderGl(gl: GL, params: EditParams, mode: ViewMode): ViewSize {
    const { out, map } = viewGeometry(params, this.width, this.height, mode);
    this.resize(out.width, out.height);
    gl.viewport(0, 0, out.width, out.height);
    const u = this.uniforms;
    const p = this.prep(params);
    const m = p.matrix;
    gl.uniform2f(u.u_outSize, out.width, out.height);
    gl.uniform3f(u.u_mapX, map[0], map[1], map[2]);
    gl.uniform3f(u.u_mapY, map[3], map[4], map[5]);
    gl.uniform1f(u.u_baseline, p.baseline);
    // GLSL matrices are column-major.
    gl.uniformMatrix3fv(u.u_matrix, false, [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
    gl.uniform4f(u.u_local, p.clarity, p.sharpen, p.shadows, p.highlights);
    gl.uniform4f(u.u_tone, p.gamma, p.whites, p.blacks, p.saturation);
    gl.uniform4f(u.u_ends, p.vibrance, p.bw ? 1 : 0, p.whiteLevel, p.blackLevel);
    gl.uniform1f(u.u_shoulder, p.shoulder);
    gl.uniform1f(u.u_plain, mode === 'before' ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return { width: out.width, height: out.height, crop: mode === 'frame' ? effectiveCrop(params, this.width, this.height) : out.crop };
  }

  private renderCpu(params: EditParams, mode: ViewMode): ViewSize {
    const { out, map } = viewGeometry(params, this.width, this.height, mode, CPU_MAX_PIXELS);
    this.resize(out.width, out.height);
    const ctx = this.ctx2d;
    if (ctx) {
      const image = ctx.createImageData(out.width, out.height);
      const prep = this.prep(mode === 'before' ? DEFAULT_PARAMS : params);
      const rgb = [0, 0, 0];
      const data = image.data;
      for (let y = 0; y < out.height; y++) {
        for (let x = 0; x < out.width; x++) {
          const sx = map[0] * (x + 0.5) + map[1] * (y + 0.5) + map[2];
          const sy = map[3] * (x + 0.5) + map[4] * (y + 0.5) + map[5];
          const o = (y * out.width + x) * 4;
          data[o + 3] = 255;
          if (sx < 0 || sy < 0 || sx >= this.width || sy >= this.height) {
            data[o] = data[o + 1] = data[o + 2] = Math.round(BACKGROUND[0] * 255);
            continue;
          }
          // Nearest sample, no detail: the fallback shows light and colour.
          const s = ((sy | 0) * this.width + (sx | 0)) * 3;
          outputPixel(prep, scenePixel(prep, this.light[s], this.light[s + 1], this.light[s + 2], 0, 0, rgb));
          data[o] = linearToSrgb(clamp01(rgb[0])) * 255;
          data[o + 1] = linearToSrgb(clamp01(rgb[1])) * 255;
          data[o + 2] = linearToSrgb(clamp01(rgb[2])) * 255;
        }
      }
      ctx.putImageData(image, 0, 0);
    }
    const crop = mode === 'frame' ? effectiveCrop(params, this.width, this.height) : out.crop;
    return { width: out.width, height: out.height, crop };
  }

  /** Read the drawn pixels back (tests, the golden check). */
  readPixels(): Uint8Array {
    const gl = this.gl;
    const out = new Uint8Array(this.canvas.width * this.canvas.height * 4);
    if (gl) gl.readPixels(0, 0, this.canvas.width, this.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  dispose() {
    if (this.gl) this.release(this.gl);
  }

  /** Free a context's resources: a failed set-up's too, browsers cap live contexts. */
  private release(gl: GL) {
    for (const texture of this.textures) gl.deleteTexture(texture);
    if (this.program) gl.deleteProgram(this.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.textures = [];
    this.program = null;
    this.gl = null;
  }
}
