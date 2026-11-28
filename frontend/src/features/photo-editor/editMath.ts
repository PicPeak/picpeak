/**
 * The photo editor's parameter model and math (issue 2619): the TypeScript
 * copy of backend/src/utils/photoEditMath.js, which the server renders with.
 * Both are pinned to the same fixtures
 * (backend/__tests__/fixtures/photoEditMath.fixtures.json); a change to the
 * math goes into both files, the GLSL in shader.ts and the fixtures.
 */

export interface CropRect { x: number; y: number; w: number; h: number }

export interface EditParams {
  v: 1;
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  straighten: number;
  crop: CropRect | null;
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  temperature: number;
  tint: number;
  vibrance: number;
  saturation: number;
  clarity: number;
  sharpen: number;
  bw: boolean;
  /** Camera RAW only: noise reduction in the develop. */
  nr: number;
  /** Camera RAW only: developed with the default look even without other changes. */
  develop: boolean;
}

export type SliderKey = 'exposure' | 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks'
  | 'temperature' | 'tint' | 'vibrance' | 'saturation' | 'clarity' | 'sharpen' | 'nr';

/** [min, max, decimals], as the server validates them. */
export const SLIDERS: Record<SliderKey, [number, number, number]> = {
  exposure: [-5, 5, 2],
  contrast: [-100, 100, 0],
  highlights: [-100, 100, 0],
  shadows: [-100, 100, 0],
  whites: [-100, 100, 0],
  blacks: [-100, 100, 0],
  temperature: [-100, 100, 0],
  tint: [-100, 100, 0],
  vibrance: [-100, 100, 0],
  saturation: [-100, 100, 0],
  clarity: [-100, 100, 0],
  sharpen: [0, 100, 0],
  nr: [0, 100, 0],
};
export const STRAIGHTEN_MAX = 45;
export const MIN_CROP = 0.02;
export const TONE_KEYS = [...Object.keys(SLIDERS), 'bw', 'develop'] as Array<SliderKey | 'bw' | 'develop'>;
export const GEOMETRY_KEYS = ['rotate', 'flipH', 'flipV', 'straighten', 'crop'] as const;

export const DEFAULT_PARAMS: EditParams = Object.freeze({
  v: 1,
  rotate: 0,
  flipH: false,
  flipV: false,
  straighten: 0,
  crop: null,
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  vibrance: 0,
  saturation: 0,
  clarity: 0,
  sharpen: 0,
  bw: false,
  nr: 0,
  develop: false,
}) as EditParams;

const roundTo = (value: number, decimals: number) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor + 0;
};
export const clampTo = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A slider value as the server stores it: in range and rounded. */
export function normalizeSlider(key: SliderKey, value: number): number {
  const [min, max, decimals] = SLIDERS[key];
  return roundTo(clampTo(Number.isFinite(value) ? value : 0, min, max), decimals);
}

/** True when the params change nothing (saved as no edit). */
export function isIdentity(params: EditParams | null | undefined): boolean {
  if (!params) return true;
  return (Object.keys(DEFAULT_PARAMS) as Array<keyof EditParams>).every((key) => (
    key === 'crop' ? !params.crop : params[key] === DEFAULT_PARAMS[key]
  ));
}

export function hasGeometry(params: EditParams | null | undefined): boolean {
  return Boolean(params && (params.rotate || params.flipH || params.flipV || params.straighten || params.crop));
}

/** `source` with the parts of `from` that a copy carries: 'tone' and/or 'geometry'. */
export function mergeParts(source: EditParams | null, from: EditParams, parts: Array<'tone' | 'geometry'>): EditParams {
  const out: EditParams = { ...DEFAULT_PARAMS, ...(source || {}) };
  const target = out as unknown as Record<string, unknown>;
  const copy = from as unknown as Record<string, unknown>;
  if (parts.includes('tone')) for (const key of TONE_KEYS) target[key] = copy[key];
  if (parts.includes('geometry')) {
    for (const key of GEOMETRY_KEYS) target[key] = key === 'crop' && from.crop ? { ...from.crop } : copy[key];
  }
  return out;
}

// ---------------------------------------------------------------- geometry

export interface Size { width: number; height: number }
export interface PixelRect { left: number; top: number; width: number; height: number }

export function frameSize(params: EditParams, width: number, height: number): Size {
  return params.rotate % 180 === 0 ? { width, height } : { width: height, height: width };
}

/** The crop actually rendered, in frame pixels: shrunk about its centre until it lies on the straightened image. */
export function effectiveCrop(params: EditParams, width: number, height: number): PixelRect {
  const frame = frameSize(params, width, height);
  const c = params.crop || { x: 0, y: 0, w: 1, h: 1 };
  let left = c.x * frame.width;
  let top = c.y * frame.height;
  const w = c.w * frame.width;
  const h = c.h * frame.height;
  const angle = (params.straighten || 0) * Math.PI / 180;
  if (!angle) return { left, top, width: w, height: h };
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const fcx = frame.width / 2;
  const fcy = frame.height / 2;
  const back = (x: number, y: number) => ({
    x: fcx + (x - fcx) * cos - (y - fcy) * sin,
    y: fcy + (x - fcx) * sin + (y - fcy) * cos,
  });
  let cx = left + w / 2;
  let cy = top + h / 2;
  let centre = back(cx, cy);
  if (centre.x < 0 || centre.x > frame.width || centre.y < 0 || centre.y > frame.height) {
    cx = fcx;
    cy = fcy;
    centre = { x: fcx, y: fcy };
  }
  let scale = 1;
  for (const [dx, dy] of [[-w / 2, -h / 2], [w / 2, -h / 2], [-w / 2, h / 2], [w / 2, h / 2]]) {
    const ax = dx * cos - dy * sin;
    const ay = dx * sin + dy * cos;
    for (const [pos, along, limit] of [[centre.x, ax, frame.width], [centre.y, ay, frame.height]]) {
      if (along > 1e-9) scale = Math.min(scale, (limit - pos) / along);
      else if (along < -1e-9) scale = Math.min(scale, -pos / along);
    }
  }
  scale = Math.max(0, Math.min(1, scale));
  left = cx - (w * scale) / 2;
  top = cy - (h * scale) / 2;
  return { left, top, width: w * scale, height: h * scale };
}

export interface OutputSize extends Size { crop: PixelRect }

export function outputSize(params: EditParams, width: number, height: number, { maxPixels = Infinity } = {}): OutputSize {
  const crop = effectiveCrop(params, width, height);
  let scale = 1;
  const pixels = crop.width * crop.height;
  if (pixels > maxPixels) scale = Math.sqrt(maxPixels / pixels);
  return {
    width: Math.max(1, Math.round(crop.width * scale)),
    height: Math.max(1, Math.round(crop.height * scale)),
    crop,
  };
}

/** Output pixel position -> upright source pixel position. */
export function inverseMapper(params: EditParams, width: number, height: number, out: OutputSize) {
  const frame = frameSize(params, width, height);
  const { crop } = out;
  const sx = crop.width / out.width;
  const sy = crop.height / out.height;
  const angle = (params.straighten || 0) * Math.PI / 180;
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const fcx = frame.width / 2;
  const fcy = frame.height / 2;
  const rotate = params.rotate || 0;
  return (ox: number, oy: number) => {
    let x = crop.left + ox * sx;
    let y = crop.top + oy * sy;
    const rx = fcx + (x - fcx) * cos - (y - fcy) * sin;
    const ry = fcy + (x - fcx) * sin + (y - fcy) * cos;
    x = rx;
    y = ry;
    if (params.flipH) x = frame.width - x;
    if (params.flipV) y = frame.height - y;
    if (rotate === 90) return { x: y, y: height - x };
    if (rotate === 180) return { x: width - x, y: height - y };
    if (rotate === 270) return { x: width - y, y: x };
    return { x, y };
  };
}

/**
 * The inverse map as an affine matrix [a, b, c, d, e, f]: source = (a*ox + b*oy + c, d*ox + e*oy + f).
 * It is affine by construction (crop, rotations, flips), which is what lets
 * the shader take it as two vectors.
 */
export function inverseAffine(params: EditParams, width: number, height: number, out: OutputSize): number[] {
  const map = inverseMapper(params, width, height, out);
  const o = map(0, 0);
  const x = map(1, 0);
  const y = map(0, 1);
  return [x.x - o.x, y.x - o.x, o.x, x.y - o.y, y.y - o.y, o.y];
}

export function mapPointToEdited(params: EditParams, width: number, height: number, point: { x: number; y: number }) {
  const frame = frameSize(params, width, height);
  let x = point.x * width;
  let y = point.y * height;
  const rotate = params.rotate || 0;
  if (rotate === 90) [x, y] = [height - y, x];
  else if (rotate === 180) [x, y] = [width - x, height - y];
  else if (rotate === 270) [x, y] = [y, width - x];
  if (params.flipH) x = frame.width - x;
  if (params.flipV) y = frame.height - y;
  const angle = (params.straighten || 0) * Math.PI / 180;
  const fcx = frame.width / 2;
  const fcy = frame.height / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const sx = fcx + (x - fcx) * cos - (y - fcy) * sin;
  const sy = fcy + (x - fcx) * sin + (y - fcy) * cos;
  const crop = effectiveCrop(params, width, height);
  return { x: (sx - crop.left) / crop.width, y: (sy - crop.top) / crop.height };
}

// ------------------------------------------------------------ light, colour
//
// The same scene-referred pipeline as the server (photoEditMath.js, which
// says where each idea comes from). Keep the two in step; the fixtures
// catch a drift.

export const G0 = 0.1845;
const LOG_G0 = Math.log2(G0);
export const RAW_BASELINE_EV = 0.7;
const MIN_LEVEL = 2 ** -16;
export const LUMA = [0.2126, 0.7152, 0.0722] as const;

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const linearToSrgb = (l: number) => (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const luminance = (r: number, g: number, b: number) => LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;

type Mat3 = number[];
const SRGB_TO_XYZ: Mat3 = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.0721750, 0.0193339, 0.1191920, 0.9503041];
const BRADFORD: Mat3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];

function multiply3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  }
  return out;
}
function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h; const B = -(d * i - f * g); const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
}
const apply3 = (m: Mat3, v: number[]) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const XYZ_TO_SRGB = invert3(SRGB_TO_XYZ);
const BRADFORD_INV = invert3(BRADFORD);

function planckianXy(kelvin: number): [number, number] {
  const t = Math.min(25000, Math.max(1667, kelvin));
  const x = t <= 4000
    ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.179910
    : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.240390;
  const y = t <= 2222 ? -1.1063814 * x ** 3 - 1.34811020 * x ** 2 + 2.18555832 * x - 0.20219683
    : t <= 4000 ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
      : 3.0817580 * x ** 3 - 5.87338670 * x ** 2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}
const toUv = ([x, y]: number[]) => [4 * x / (-2 * x + 12 * y + 3), 6 * y / (-2 * x + 12 * y + 3)];
const toXy = ([u, v]: number[]) => [3 * u / (2 * u - 8 * v + 4), 2 * v / (2 * u - 8 * v + 4)];

function lightXy(mired: number, duv: number) {
  const uv = toUv(planckianXy(1e6 / mired));
  if (!duv) return toXy(uv);
  const a = toUv(planckianXy(1e6 / (mired - 1)));
  const b = toUv(planckianXy(1e6 / (mired + 1)));
  let nu = -(b[1] - a[1]);
  let nv = b[0] - a[0];
  if (nv < 0) { nu = -nu; nv = -nv; }
  const len = Math.hypot(nu, nv);
  return toXy([uv[0] + duv * nu / len, uv[1] + duv * nv / len]);
}

export function whiteBalanceMatrix(temperature: number, tint: number): Mat3 {
  if (!temperature && !tint) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const reference = 1e6 / 6504;
  const mired = Math.min(600, Math.max(40, reference - 1.5 * temperature));
  const cone = (xy: number[]) => apply3(BRADFORD, [xy[0] / xy[1], 1, (1 - xy[0] - xy[1]) / xy[1]]);
  const from = cone(lightXy(mired, 0.0003 * tint));
  const to = cone(lightXy(reference, 0));
  const scale = [to[0] / from[0], 0, 0, 0, to[1] / from[1], 0, 0, 0, to[2] / from[2]];
  const m = multiply3(XYZ_TO_SRGB, multiply3(BRADFORD_INV, multiply3(scale, multiply3(BRADFORD, SRGB_TO_XYZ))));
  const white = apply3(m, [1, 1, 1]);
  const norm = luminance(white[0], white[1], white[2]);
  return m.map((v) => v / norm);
}

export interface Sigmoid { n: number; phi: number; e: number }
export function fitSigmoid(contrast = 1.5, black = 0.000152): Sigmoid {
  const ratio = (G0 * (1 - black)) / (black * (1 - G0));
  const fit = (n: number) => {
    const phi = G0 / (ratio ** (1 / n) - 1);
    return { n, phi, e: (G0 + phi) ** n * (1 - G0) / G0 };
  };
  const first = fit(contrast);
  return fit(contrast * (G0 + first.phi) / G0);
}
export const RAW_SIGMOID = fitSigmoid();
const sigmoid = (x: number, s: Sigmoid) => {
  const p = (Math.max(0, x) + s.phi) ** s.n;
  return p / (p + s.e);
};

export function detailSigmas(sourceShortSide: number, outPerSource = 1) {
  return { clarity: Math.max(1, 0.015 * sourceShortSide * outPerSource), sharpen: 1 };
}
const limiter = (d: number, s: number) => d / (1 + (d / s) * (d / s));
const coring = (d: number, t: number) => (d * d) / (d * d + t * t);
const levelOf = (y: number) => Math.log2(Math.max(y, MIN_LEVEL));

export interface Prepared {
  linear: boolean;
  baseline: number;
  matrix: Mat3;
  clarity: number;
  sharpen: number;
  shadows: number;
  highlights: number;
  gamma: number;
  whites: number;
  blacks: number;
  saturation: number;
  vibrance: number;
  bw: boolean;
  whiteLevel: number;
  blackLevel: number;
  shoulder: number;
}

const contrastLuminance = (prep: Prepared, y: number) => (prep.gamma === 1 || y <= 0 ? y : G0 * (y / G0) ** prep.gamma);

export function prepare(params: EditParams, { linear = false, exposureBias = 0 } = {}): Prepared {
  const exposure = 2 ** params.exposure;
  const matrix = whiteBalanceMatrix(params.temperature, params.tint).map((v) => v * exposure);
  const prep: Prepared = {
    linear,
    baseline: linear ? 2 ** (RAW_BASELINE_EV + exposureBias) : 1,
    matrix,
    clarity: params.clarity / 100,
    sharpen: params.sharpen / 100,
    shadows: params.shadows / 100,
    highlights: params.highlights / 100,
    gamma: 2 ** (0.5 * params.contrast / 100),
    whites: params.whites / 100,
    blacks: params.blacks / 100,
    saturation: params.saturation / 100,
    vibrance: params.vibrance / 100,
    bw: Boolean(params.bw),
    whiteLevel: 0,
    blackLevel: 0,
    shoulder: 1,
  };
  const white = apply3(matrix, [prep.baseline, prep.baseline, prep.baseline]);
  prep.whiteLevel = levelOf(contrastLuminance(prep, luminance(white[0], white[1], white[2])));
  prep.blackLevel = prep.whiteLevel - 10;
  if (!linear) {
    let peak = 1;
    for (const probe of [[1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1]]) {
      const v = scenePixel(prep, probe[0], probe[1], probe[2], 0, 0);
      peak = Math.max(peak, v[0], v[1], v[2]);
    }
    prep.shoulder = peak;
  }
  return prep;
}

function skinWeight(r: number, g: number, b: number) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max <= min) return 0;
  const d = max - min;
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  const away = Math.min(Math.abs(hue - 25), 360 - Math.abs(hue - 25));
  return Math.exp(-(away / 15) * (away / 15));
}

export function scenePixel(prep: Prepared, r0: number, g0: number, b0: number, dc: number, ds: number, result: number[] = [0, 0, 0]) {
  const m = prep.matrix;
  let r = m[0] * r0 + m[1] * g0 + m[2] * b0;
  let g = m[3] * r0 + m[4] * g0 + m[5] * b0;
  let b = m[6] * r0 + m[7] * g0 + m[8] * b0;
  let y = luminance(r, g, b);
  const level = levelOf(y);
  const local = limiter(dc, 0.7);
  let detail = 0;
  if (prep.clarity || prep.sharpen) {
    const gate = smoothstep(-11, -8, level) * (prep.linear ? 1 : 1 - smoothstep(0.9, 1, y));
    if (prep.clarity > 0) detail += 1.6 * prep.clarity * local * coring(dc, 0.05) * gate;
    else if (prep.clarity < 0) detail += 0.6 * prep.clarity * dc;
    if (prep.sharpen) detail += 1.2 * prep.sharpen * limiter(ds, 0.25) * coring(ds, 0.02) * gate;
    detail /= 1 + Math.abs(detail);
  }
  const zone = level - 0.7 * local - LOG_G0;
  let shift = detail;
  if (prep.highlights) shift += 1.5 * prep.highlights * smoothstep(0, 3, zone);
  if (prep.shadows) {
    shift += 1.5 * prep.shadows * (1 - smoothstep(-5, 0, zone)) * (prep.shadows > 0 ? smoothstep(-12, -8.5, zone) : 1);
  }
  if (shift) {
    const gain = 2 ** shift;
    r *= gain; g *= gain; b *= gain;
  }
  if (prep.gamma !== 1) {
    y = luminance(r, g, b);
    if (y > 0) {
      const gain = contrastLuminance(prep, y) / y;
      r *= gain; g *= gain; b *= gain;
    }
  }
  if (prep.whites || prep.blacks) {
    const end = levelOf(luminance(r, g, b)) - 0.7 * local;
    let ends = prep.whites * smoothstep(prep.whiteLevel - 3, prep.whiteLevel, end);
    if (prep.blacks < 0) ends += 1.5 * prep.blacks * (1 - smoothstep(prep.blackLevel, prep.blackLevel + 4, end));
    if (ends) {
      const gain = 2 ** ends;
      r *= gain; g *= gain; b *= gain;
    }
    if (prep.blacks > 0) {
      const lift = 0.0025 * prep.blacks;
      r += lift; g += lift; b += lift;
    }
  }
  y = luminance(r, g, b);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let k = 1 + prep.saturation;
  if (prep.vibrance > 0) {
    const chroma = (max - min) / Math.max(max, 1e-6);
    k *= 1 + prep.vibrance * (1 - chroma) * (1 - chroma) * (1 - 0.5 * skinWeight(r, g, b));
  } else if (prep.vibrance < 0) {
    k *= 1 + prep.vibrance * smoothstep(0.05, 0.75, (max - min) / Math.max(max, 1e-6));
  }
  if (min < 0 && y > 0) k = Math.min(k, y / (y - min));
  if (k !== 1) {
    r = y + k * (r - y); g = y + k * (g - y); b = y + k * (b - y);
  }
  if (prep.bw) {
    const l = luminance(r, g, b);
    r = l; g = l; b = l;
  }
  result[0] = r; result[1] = g; result[2] = b;
  return result;
}

export function outputPixel(prep: Prepared, rgb: number[]) {
  let r = rgb[0];
  let g = rgb[1];
  let b = rgb[2];
  if (prep.linear) {
    const hi = r >= g ? (r >= b ? 0 : 2) : (g >= b ? 1 : 2);
    const lo = r < g ? (r < b ? 0 : 2) : (g < b ? 1 : 2);
    const spread = rgb[hi] - rgb[lo] > 0 && hi !== lo;
    const t = spread ? (rgb[3 - hi - lo] - rgb[lo]) / (rgb[hi] - rgb[lo]) : 0;
    rgb[0] = sigmoid(r, RAW_SIGMOID);
    rgb[1] = sigmoid(g, RAW_SIGMOID);
    rgb[2] = sigmoid(b, RAW_SIGMOID);
    if (spread) rgb[3 - hi - lo] = rgb[lo] + t * (rgb[hi] - rgb[lo]);
    return rgb;
  }
  if (prep.shoulder > 1) {
    const peak = Math.max(r, g, b);
    const knee = 0.8;
    if (peak > knee) {
      const u = (peak - knee) / (1 - knee);
      const top = (prep.shoulder - knee) / (1 - knee);
      const mapped = knee + (1 - knee) * (u * (1 + u / (top * top))) / (1 + u);
      const gain = mapped / peak;
      r *= gain; g *= gain; b *= gain;
    }
  }
  rgb[0] = r; rgb[1] = g; rgb[2] = b;
  return rgb;
}

const decode = (prep: Prepared, v: number) => (prep.linear ? v * prep.baseline : srgbToLinear(v));

export function referencePixel(
  rgb: number[], params: EditParams,
  { dc = 0, ds = 0, linear = false, exposureBias = 0, prep }: { dc?: number; ds?: number; linear?: boolean; exposureBias?: number; prep?: Prepared } = {},
): [number, number, number] {
  const p = prep || prepare(params, { linear, exposureBias });
  const out = outputPixel(p, scenePixel(p, decode(p, rgb[0]), decode(p, rgb[1]), decode(p, rgb[2]), dc, ds));
  return [linearToSrgb(clamp01(out[0])), linearToSrgb(clamp01(out[1])), linearToSrgb(clamp01(out[2]))];
}

// ------------------------------------------------------------- blur, detail

export function boxesForGauss(sigma: number): number[] {
  const n = 3;
  const ideal = Math.sqrt((12 * sigma * sigma / n) + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

type Plane = Int16Array | Uint16Array;
function boxPass(src: Plane, dst: Plane, width: number, height: number, radius: number, horizontal: boolean) {
  const lines = horizontal ? height : width;
  const length = horizontal ? width : height;
  const step = horizontal ? 1 : width;
  const span = 2 * radius + 1;
  const last = length - 1;
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * width : line;
    // The window of the first sample, edges repeated: indices -r..r clamped.
    let sum = 0;
    for (let j = -radius; j <= radius; j++) sum += src[base + Math.min(last, Math.max(0, j)) * step];
    for (let i = 0; i < length; i++) {
      dst[base + i * step] = Math.round(sum / span);
      // Slide: in comes i + r + 1, out goes i - r (both clamped).
      sum += src[base + Math.min(last, i + radius + 1) * step] - src[base + Math.max(0, i - radius) * step];
    }
  }
}

export function blurPlane(plane: Plane, scratch: Plane, width: number, height: number, sigma: number) {
  for (const size of boxesForGauss(sigma)) {
    const radius = (size - 1) / 2;
    boxPass(plane, scratch, width, height, radius, true);
    boxPass(scratch, plane, width, height, radius, false);
  }
}

export const LEVEL_SCALE = 1024;
const quantLevel = (y: number) => Math.max(-32768, Math.min(32767, Math.round(levelOf(y) * LEVEL_SCALE)));

/**
 * The base image as linear light (RGB float), from 8-bit sRGB RGBA or, for a
 * RAW develop, 16-bit linear RGB times the baseline. What the textures and
 * the statistics are made from.
 */
export function linearPixels(source: { rgba?: Uint8ClampedArray | Uint8Array; rgb16?: Uint16Array }, count: number, baseline = 1): Float32Array {
  const out = new Float32Array(count * 3);
  if (source.rgb16) {
    for (let i = 0; i < count * 3; i++) out[i] = (source.rgb16[i] / 65535) * baseline;
    return out;
  }
  const table = Float32Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));
  const rgba = source.rgba as Uint8ClampedArray;
  for (let i = 0, o = 0; i < count; i++, o += 4) {
    out[i * 3] = table[rgba[o]];
    out[i * 3 + 1] = table[rgba[o + 1]];
    out[i * 3 + 2] = table[rgba[o + 2]];
  }
  return out;
}

/**
 * The detail texture of the base image: its log luminance (EV) and the
 * clarity and sharpening blurs of it, as R, G, B floats. Built once a photo,
 * with the server's integer blur.
 */
export function detailTexture(linear: Float32Array, width: number, height: number): Float32Array {
  const n = width * height;
  const level = new Int16Array(n);
  for (let i = 0; i < n; i++) level[i] = quantLevel(luminance(linear[i * 3], linear[i * 3 + 1], linear[i * 3 + 2]));
  const sigmas = detailSigmas(Math.min(width, height));
  const scratch = new Int16Array(n);
  const clarity = Int16Array.from(level);
  blurPlane(clarity, scratch, width, height, sigmas.clarity);
  const sharpen = Int16Array.from(level);
  blurPlane(sharpen, scratch, width, height, sigmas.sharpen);
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = level[i] / LEVEL_SCALE;
    out[i * 4 + 1] = clarity[i] / LEVEL_SCALE;
    out[i * 4 + 2] = sharpen[i] / LEVEL_SCALE;
    out[i * 4 + 3] = 0;
  }
  return out;
}

// --------------------------------------------------------------- auto tone

export interface ToneStats { p005: number; p10: number; p50: number; p99: number; p995: number; mean: number; clipped: number }

export function toneStats(luminances: ArrayLike<number>): ToneStats {
  const levels = Float64Array.from(luminances, (y) => levelOf(y)).sort();
  const at = (q: number) => levels[Math.min(levels.length - 1, Math.max(0, Math.floor(q * (levels.length - 1))))];
  let sum = 0;
  for (const level of levels) sum += level;
  let clipped = 0;
  for (let i = 0; i < luminances.length; i++) if (luminances[i] >= 0.999) clipped++;
  return {
    p005: at(0.005), p10: at(0.1), p50: at(0.5), p99: at(0.99), p995: at(0.995),
    mean: levels.length ? sum / levels.length : LOG_G0,
    clipped: luminances.length ? clipped / luminances.length : 0,
  };
}

export type ToneSettings = Pick<EditParams, 'exposure' | 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks'>;

export function autoTone(stats: ToneStats, { linear = false } = {}): ToneSettings {
  const white = linear ? RAW_BASELINE_EV : 0;
  let exposure = 0.7 * (LOG_G0 - stats.mean);
  if (stats.p995 + exposure > LOG_G0 + 2.3 || stats.clipped > 0.005) {
    exposure = Math.min(exposure, 0, LOG_G0 + 2.3 - stats.p995);
  }
  exposure = clampTo(exposure, -2, 3);
  const highlights = -clampTo((stats.p99 + exposure - (LOG_G0 + 2)) / 1.5, 0, 0.6);
  const shadows = clampTo(((LOG_G0 - 4) - (stats.p10 + exposure)) / 3, 0, 0.5);
  const range = Math.max(0.5, stats.p995 - stats.p005);
  const contrast = clampTo(2 * Math.log2(8 / range), -0.3, 0.5);
  const whites = clampTo((white - 0.3 - (stats.p995 + exposure)) / 3, -0.4, 0.4);
  const blacks = -clampTo(((LOG_G0 - 7) - (stats.p005 + exposure)) / -4, 0, 0.4);
  const round = (v: number) => Math.round(v * 100) + 0;
  return {
    exposure: Math.round(exposure * 100) / 100 + 0,
    contrast: round(contrast),
    highlights: round(highlights),
    shadows: round(shadows),
    whites: round(whites),
    blacks: round(blacks),
  };
}
