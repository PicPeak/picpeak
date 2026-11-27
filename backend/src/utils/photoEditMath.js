'use strict';

/**
 * The photo editor's parameter model and pixel math (issue 2619).
 *
 * One definition of what an edit does, used three times: here by the server
 * render (photoEdits.js), by the browser's live preview (a TypeScript copy in
 * frontend/src/features/photo-editor/editMath.ts and the GLSL shader next to
 * it), and as the CPU reference the golden tests compare both against. The
 * fixtures in __tests__/fixtures/photoEditMath.fixtures.json pin this module
 * and the TypeScript copy to the same numbers; change the math in both.
 *
 * Order, for every output pixel:
 *   1. geometry: EXIF-upright source -> rotate in 90 degree steps (clockwise)
 *      -> flip -> straighten (a small rotation about the centre) -> crop.
 *      Applied as an inverse map with bilinear sampling.
 *   2. light and colour, on sRGB values in [0, 1]: to linear light, white
 *      balance and exposure gains, back to sRGB, the tone curve (blacks and
 *      whites, shadows, highlights, contrast), vibrance and saturation
 *      around Rec. 709 luma, black & white.
 *   3. detail: clarity and sharpening add the difference between the
 *      geometry output's luma and a blurred copy of it (a large and a small
 *      radius).
 *
 * Dependency-free on purpose: no sharp, no database. Pure functions over
 * plain arrays.
 */

const EDIT_VERSION = 1;

// The sliders: [min, max, decimals]. Everything else in the JSON is geometry
// or a switch.
const SLIDERS = {
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
};
const STRAIGHTEN_MAX = 45;
const ROTATIONS = [0, 90, 180, 270];
// A crop narrower than this share of a side is a slip, not an edit.
const MIN_CROP = 0.02;
// The parts batch copy can carry separately (BatchCopyDialog).
const TONE_KEYS = Object.keys(SLIDERS).concat(['bw']);
const GEOMETRY_KEYS = ['rotate', 'flipH', 'flipV', 'straighten', 'crop'];

const DEFAULT_PARAMS = Object.freeze({
  v: EDIT_VERSION,
  rotate: 0,
  flipH: false,
  flipV: false,
  straighten: 0,
  crop: null,
  ...Object.fromEntries(Object.keys(SLIDERS).map((key) => [key, 0])),
  bw: false,
});

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_PARAMS));

const roundTo = (value, decimals) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Strict validation of an edit as a client sends it. Missing keys take their
 * default; an unknown key, a wrong type, a value out of range or another
 * version is refused. Returns `{ params }` (normalised: rounded, the crop
 * clamped to the frame) or `{ error }`.
 */
function validateEditParams(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'The edit must be an object' };
  for (const key of Object.keys(input)) {
    if (!KNOWN_KEYS.has(key)) return { error: `Unknown edit setting: ${key.slice(0, 40)}` };
  }
  if (input.v !== undefined && input.v !== EDIT_VERSION) return { error: `Unsupported edit version (expected ${EDIT_VERSION})` };
  const params = { ...DEFAULT_PARAMS };
  for (const [key, [min, max, decimals]] of Object.entries(SLIDERS)) {
    if (input[key] === undefined) continue;
    if (!isFiniteNumber(input[key]) || input[key] < min || input[key] > max) {
      return { error: `${key} must be a number between ${min} and ${max}` };
    }
    params[key] = roundTo(input[key], decimals) + 0; // + 0 turns -0 into 0
  }
  for (const key of ['flipH', 'flipV', 'bw']) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') return { error: `${key} must be true or false` };
    params[key] = input[key];
  }
  if (input.rotate !== undefined) {
    if (!ROTATIONS.includes(input.rotate)) return { error: 'rotate must be 0, 90, 180 or 270' };
    params.rotate = input.rotate;
  }
  if (input.straighten !== undefined) {
    if (!isFiniteNumber(input.straighten) || Math.abs(input.straighten) > STRAIGHTEN_MAX) {
      return { error: `straighten must be a number between -${STRAIGHTEN_MAX} and ${STRAIGHTEN_MAX}` };
    }
    params.straighten = roundTo(input.straighten, 2) + 0;
  }
  if (input.crop !== undefined && input.crop !== null) {
    const crop = input.crop;
    if (!crop || typeof crop !== 'object' || Array.isArray(crop)
      || Object.keys(crop).some((key) => !['x', 'y', 'w', 'h'].includes(key))
      || !['x', 'y', 'w', 'h'].every((key) => isFiniteNumber(crop[key]))) {
      return { error: 'crop must be { x, y, w, h } fractions of the photo, or null' };
    }
    const w = roundTo(crop.w, 4);
    const h = roundTo(crop.h, 4);
    if (w < MIN_CROP || h < MIN_CROP || w > 1 || h > 1 || crop.x < 0 || crop.y < 0
      || crop.x + crop.w > 1 + 1e-6 || crop.y + crop.h > 1 + 1e-6) {
      return { error: 'crop must lie inside the photo and keep at least 2% of each side' };
    }
    const x = Math.min(roundTo(crop.x, 4), 1 - w);
    const y = Math.min(roundTo(crop.y, 4), 1 - h);
    // The whole frame is no crop.
    params.crop = (x === 0 && y === 0 && w === 1 && h === 1) ? null : { x: x + 0, y: y + 0, w, h };
  }
  return { params };
}

/** True when the params change nothing: stored as no edit at all. */
function isIdentity(params) {
  if (!params) return true;
  return Object.keys(DEFAULT_PARAMS).every((key) => {
    if (key === 'crop') return !params.crop;
    return params[key] === DEFAULT_PARAMS[key];
  });
}

/** Whether the params move pixels (and so focal points and print crops). */
function hasGeometry(params) {
  return Boolean(params && (params.rotate || params.flipH || params.flipV || params.straighten || params.crop));
}

/** The params as stored: keys in one order, so equal edits are equal strings. */
function canonicalJson(params) {
  const ordered = {};
  for (const key of Object.keys(DEFAULT_PARAMS)) {
    ordered[key] = key === 'crop' && params.crop
      ? { x: params.crop.x, y: params.crop.y, w: params.crop.w, h: params.crop.h }
      : params[key];
  }
  return JSON.stringify(ordered);
}

/** Parse a stored edit; null for none or for a value that no longer validates. */
function parseStoredParams(raw) {
  if (raw == null || raw === '') return null;
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return null; }
  }
  const { params } = validateEditParams(value);
  return params && !isIdentity(params) ? params : null;
}

/**
 * `source` merged with the parts of `from` that batch copy carries:
 * 'tone' (light, colour, detail, black & white) and/or 'geometry'.
 */
function mergeParts(source, from, parts) {
  const out = { ...DEFAULT_PARAMS, ...(source || {}) };
  if (parts.includes('tone')) for (const key of TONE_KEYS) out[key] = from[key];
  if (parts.includes('geometry')) for (const key of GEOMETRY_KEYS) out[key] = key === 'crop' && from.crop ? { ...from.crop } : from[key];
  return out;
}

// ---------------------------------------------------------------- geometry

/** The frame after the 90 degree rotation: the source's sides, swapped for 90/270. */
function frameSize(params, width, height) {
  return params.rotate % 180 === 0 ? { width, height } : { width: height, height: width };
}

/**
 * The crop actually rendered, in frame pixels: the stored crop (or the
 * whole frame), shrunk about its centre until all four corners lie on the
 * straightened image, so no corner ever shows the background. A centre that
 * fell off the image moves to the frame's centre first.
 */
function effectiveCrop(params, width, height) {
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
  // A point of the frame, rotated back onto the unrotated image.
  const back = (x, y) => ({
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

/**
 * Output size of an edit of a `width` x `height` (upright) source, at most
 * `maxPixels` large. `scale` maps crop pixels to output pixels.
 */
function outputSize(params, width, height, { maxPixels = Infinity } = {}) {
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

/**
 * The inverse map: for an output pixel position (in output pixels, centres
 * at +0.5), the position in the upright source, in source pixels.
 * Returned as a function, set up once per render.
 */
function inverseMapper(params, width, height, out) {
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
  return (ox, oy) => {
    // Output -> frame (straightened).
    let x = crop.left + ox * sx;
    let y = crop.top + oy * sy;
    // Undo the straighten.
    const rx = fcx + (x - fcx) * cos - (y - fcy) * sin;
    const ry = fcy + (x - fcx) * sin + (y - fcy) * cos;
    x = rx;
    y = ry;
    // Undo the flips (applied in the rotated frame).
    if (params.flipH) x = frame.width - x;
    if (params.flipV) y = frame.height - y;
    // Undo the 90 degree rotation (clockwise).
    if (rotate === 90) return { x: y, y: height - x };
    if (rotate === 180) return { x: width - x, y: height - y };
    if (rotate === 270) return { x: width - y, y: x };
    return { x, y };
  };
}

/** The forward map of a point, fractions of the upright source -> fractions of the edited image (may fall outside 0..1). */
function mapPointToEdited(params, width, height, point) {
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

/** The inverse of mapPointToEdited: fractions of the edited image -> fractions of the upright source. */
function mapPointFromEdited(params, width, height, point) {
  const out = { width: 1, height: 1, crop: effectiveCrop(params, width, height) };
  const p = inverseMapper(params, width, height, out)(point.x, point.y);
  return { x: p.x / width, y: p.y / height };
}

// ------------------------------------------------------------ light, colour

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (l) => (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055);
const LUMA = [0.2126, 0.7152, 0.0722];

/** Per-channel linear gains of white balance and exposure, grey kept grey. */
function channelGains(params) {
  const t = params.temperature / 100;
  const m = params.tint / 100;
  const r = 2 ** (0.3 * t);
  const g = 2 ** (-0.25 * m);
  const b = 2 ** (-0.3 * t);
  const norm = 1 / (LUMA[0] * r + LUMA[1] * g + LUMA[2] * b);
  const e = 2 ** params.exposure;
  return [r * norm * e, g * norm * e, b * norm * e];
}

/**
 * The tone curve on an sRGB value in [0, 1]: blacks and whites move the end
 * points, shadows and highlights bend the lower and upper part, contrast is
 * an S around the middle. Monotonic for every slider position.
 */
function toneCurve(x, params) {
  const bp = -params.blacks / 100 * 0.1;
  const wp = 1 - params.whites / 100 * 0.15;
  let y = clamp01((x - bp) / (wp - bp));
  // Bumps that peak at a third and two thirds. The gains are the largest
  // that keep the curve monotonic (lifting shadows / pulling highlights can
  // go further than the opposite direction without folding over).
  const s = params.shadows / 100;
  y += s * (s > 0 ? 2.5 : 1) * y * (1 - y) * (1 - y);
  const h = params.highlights / 100;
  y += h * (h < 0 ? 2.5 : 1) * y * y * (1 - y);
  y = clamp01(y);
  const c = params.contrast / 100 * 0.75;
  y += c * (y * y * (3 - 2 * y) - y);
  return clamp01(y);
}

/** Saturation factor for a pixel: vibrance favours the dull ones. */
function saturationFactor(r, g, b, params) {
  const v = params.vibrance / 100;
  const s = params.saturation / 100;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  return (1 + v * (1 - sat)) * (1 + s);
}

/** Detail weights: clarity (large radius) and sharpening (small radius). */
function detailWeights(params) {
  return { clarity: params.clarity / 100 * 0.8, sharpen: params.sharpen / 100 * 1.5 };
}

/**
 * Blur radii in output pixels. Clarity's is a share of the upright source's
 * long edge, so a crop does not change its look and the browser can blur its
 * preview once per photo; sharpening works at the pixel. `outPerSource` is
 * output pixels per source pixel (below 1 when the render is scaled down).
 */
function detailSigmas(sourceLongEdge, outPerSource = 1) {
  return { clarity: Math.max(1, 0.012 * sourceLongEdge * outPerSource), sharpen: 1 };
}

/**
 * One pixel through steps 2 and 3, by the formulas (the CPU reference).
 * `rgb` in [0, 1] sRGB; `detail` is the weighted luma difference (0 without
 * clarity or sharpening). Returns sRGB in [0, 1].
 */
function referencePixel(rgb, params, detail = 0) {
  const gains = channelGains(params);
  let out = rgb.map((c, i) => toneCurve(linearToSrgb(clamp01(srgbToLinear(c) * gains[i])), params));
  const luma = LUMA[0] * out[0] + LUMA[1] * out[1] + LUMA[2] * out[2];
  const f = saturationFactor(out[0], out[1], out[2], params);
  out = out.map((c) => clamp01(luma + (c - luma) * f));
  if (params.bw) {
    const l = LUMA[0] * out[0] + LUMA[1] * out[1] + LUMA[2] * out[2];
    out = [l, l, l];
  }
  return out.map((c) => clamp01(c + detail));
}

// ------------------------------------------------------------- blur, detail

/** Box widths whose three passes approximate a gaussian of `sigma` (odd, >= 1). */
function boxesForGauss(sigma) {
  const n = 3;
  const ideal = Math.sqrt((12 * sigma * sigma / n) + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

function boxPass(src, dst, width, height, radius, horizontal) {
  const lines = horizontal ? height : width;
  const length = horizontal ? width : height;
  const step = horizontal ? 1 : width;
  const span = 2 * radius + 1;
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * width : line;
    const first = src[base];
    const last = src[base + (length - 1) * step];
    let sum = (radius + 1) * first;
    for (let i = 0; i < radius; i++) sum += src[base + Math.min(i, length - 1) * step];
    for (let i = 0; i < length; i++) {
      const addIndex = i + radius;
      sum += addIndex < length ? src[base + addIndex * step] : last;
      dst[base + i * step] = Math.round(sum / span);
      const removeIndex = i - radius;
      sum -= removeIndex >= 0 ? src[base + removeIndex * step] : first;
    }
  }
}

/**
 * Gaussian-like blur of a 16-bit plane (three box passes each way), in
 * place, with `scratch` the same size. Integer arithmetic, so every JS
 * implementation gets the same numbers.
 */
function blurPlane(plane, scratch, width, height, sigma) {
  for (const size of boxesForGauss(sigma)) {
    const radius = (size - 1) / 2;
    boxPass(plane, scratch, width, height, radius, true);
    boxPass(scratch, plane, width, height, radius, false);
  }
}

// ----------------------------------------------------------------- render

/** Interpolated lookup into a table over [0, 1]. */
function lookup(table, v) {
  const last = table.length - 1;
  const p = clamp01(v) * last;
  const i = p | 0;
  if (i >= last) return table[last];
  const f = p - i;
  return table[i] + (table[i + 1] - table[i]) * f;
}

/** linear light in [0, 1] -> tone-curved sRGB, tabulated (4096 steps). */
function toneTable(params) {
  const table = new Float32Array(4097);
  for (let i = 0; i <= 4096; i++) table[i] = toneCurve(linearToSrgb(i / 4096), params);
  return table;
}

const LINEAR_8 = Float32Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));

/**
 * Bilinear sample of an interleaved 8-bit image at (x, y) in pixel units
 * (centres at +0.5), edges clamped. Writes three floats in [0, 255] to `out`.
 */
function sampleBilinear(src, width, height, channels, x, y, out) {
  let fx = x - 0.5;
  let fy = y - 0.5;
  if (fx < 0) fx = 0; else if (fx > width - 1) fx = width - 1;
  if (fy < 0) fy = 0; else if (fy > height - 1) fy = height - 1;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = x0 + 1 < width ? x0 + 1 : x0;
  const y1 = y0 + 1 < height ? y0 + 1 : y0;
  const ax = fx - x0;
  const ay = fy - y0;
  const i00 = (y0 * width + x0) * channels;
  const i10 = (y0 * width + x1) * channels;
  const i01 = (y1 * width + x0) * channels;
  const i11 = (y1 * width + x1) * channels;
  for (let c = 0; c < 3; c++) {
    const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * ax;
    const bottom = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * ax;
    out[c] = top + (bottom - top) * ay;
  }
}

/**
 * Render an edit. `src` is the upright source as interleaved 8-bit RGB
 * (`channels` 3, or 4 with the alpha ignored), `width` x `height`. Returns
 * `{ data, width, height }`, 8-bit RGB. `maxPixels` caps the output.
 *
 * Memory: the output (3 bytes a pixel) next to the source; with clarity or
 * sharpening, two 16-bit planes of the output size more.
 */
function renderEdit(src, width, height, channels, params, { maxPixels = Infinity } = {}) {
  const out = outputSize(params, width, height, { maxPixels });
  const map = inverseMapper(params, width, height, out);
  const data = Buffer.alloc(out.width * out.height * 3);
  const px = [0, 0, 0];
  // 1. Geometry. Identity geometry at the same size is a straight copy.
  const identity = !hasGeometry(params) && out.width === width && out.height === height;
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const o = (y * out.width + x) * 3;
      if (identity) {
        const s = (y * width + x) * channels;
        data[o] = src[s]; data[o + 1] = src[s + 1]; data[o + 2] = src[s + 2];
        continue;
      }
      const p = map(x + 0.5, y + 0.5);
      sampleBilinear(src, width, height, channels, p.x, p.y, px);
      data[o] = Math.round(px[0]); data[o + 1] = Math.round(px[1]); data[o + 2] = Math.round(px[2]);
    }
  }
  applyColour(data, out.width, out.height, params, detailSigmas(Math.max(width, height), out.width / out.crop.width));
  return { data, width: out.width, height: out.height };
}

/** Steps 2 and 3 in place on interleaved 8-bit RGB (the geometry output). */
function applyColour(data, width, height, params, sigmas = detailSigmas(Math.max(width, height))) {
  const weights = detailWeights(params);
  let detail = null;
  if (weights.clarity || weights.sharpen) {
    const n = width * height;
    const luma = new Uint16Array(n);
    for (let i = 0, o = 0; i < n; i++, o += 3) {
      luma[i] = Math.round((LUMA[0] * data[o] + LUMA[1] * data[o + 1] + LUMA[2] * data[o + 2]) * 257);
    }
    detail = new Int16Array(n);
    const blurred = new Uint16Array(n);
    const scratch = new Uint16Array(n);
    for (const [kind, weight] of [['clarity', weights.clarity], ['sharpen', weights.sharpen]]) {
      if (!weight) continue;
      blurred.set(luma);
      blurPlane(blurred, scratch, width, height, sigmas[kind]);
      // In 1/4096ths of the full range, which fits Int16 for any weight.
      for (let i = 0; i < n; i++) {
        const v = detail[i] + Math.round(weight * (luma[i] - blurred[i]) / 16);
        detail[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
      }
    }
  }
  const gains = channelGains(params);
  const table = toneTable(params);
  const vib = params.vibrance / 100;
  const sat = params.saturation / 100;
  const bw = params.bw;
  const n = width * height;
  for (let i = 0, o = 0; i < n; i++, o += 3) {
    let r = lookup(table, LINEAR_8[data[o]] * gains[0]);
    let g = lookup(table, LINEAR_8[data[o + 1]] * gains[1]);
    let b = lookup(table, LINEAR_8[data[o + 2]] * gains[2]);
    const l = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
    if (vib || sat) {
      const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const f = (1 + vib * (1 - (max - min))) * (1 + sat);
      r = clamp01(l + (r - l) * f);
      g = clamp01(l + (g - l) * f);
      b = clamp01(l + (b - l) * f);
    }
    if (bw) {
      const k = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
      r = k; g = k; b = k;
    }
    if (detail) {
      const d = detail[i] / 4096;
      r += d; g += d; b += d;
    }
    data[o] = Math.round(clamp01(r) * 255);
    data[o + 1] = Math.round(clamp01(g) * 255);
    data[o + 2] = Math.round(clamp01(b) * 255);
  }
}

// --------------------------------------------------------------- auto tone

/**
 * One-click tone from a 256-bin luma histogram (sRGB): stretch the ends to
 * the 0.5 / 99.5 percentiles and pull the median towards the middle with
 * exposure. Light-handed on purpose; the result is ordinary slider values.
 */
function autoTone(histogram) {
  const total = histogram.reduce((sum, v) => sum + v, 0);
  if (!total) return { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 };
  const percentile = (q) => {
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += histogram[i];
      if (acc >= q * total) return i / 255;
    }
    return 1;
  };
  const lo = percentile(0.005);
  const hi = percentile(0.995);
  const median = percentile(0.5);
  const clampTo = (v, min, max) => Math.min(max, Math.max(min, v));
  const blacks = Math.round(clampTo(-(Math.min(lo, 0.1) / 0.1) * 100, -100, 0));
  const whites = Math.round(clampTo(((1 - Math.max(hi, 0.85)) / 0.15) * 100, 0, 100));
  // Median after the stretch, then the exposure that brings it to 0.45.
  const stretched = clampTo((median - lo) / Math.max(0.05, hi - lo), 0.02, 0.98);
  const exposure = roundTo(clampTo(Math.log2(srgbToLinear(0.45) / srgbToLinear(stretched)), -1.5, 1.5), 2) + 0;
  const shadows = Math.round(clampTo((0.3 - stretched) * 100, 0, 30));
  const highlights = Math.round(clampTo(-(percentile(0.98) - 0.9) * 300, -30, 0)) + 0;
  return { exposure, contrast: 0, highlights, shadows, whites, blacks };
}

module.exports = {
  EDIT_VERSION,
  SLIDERS,
  STRAIGHTEN_MAX,
  MIN_CROP,
  TONE_KEYS,
  GEOMETRY_KEYS,
  DEFAULT_PARAMS,
  validateEditParams,
  isIdentity,
  hasGeometry,
  canonicalJson,
  parseStoredParams,
  mergeParts,
  frameSize,
  effectiveCrop,
  outputSize,
  inverseMapper,
  mapPointToEdited,
  mapPointFromEdited,
  srgbToLinear,
  linearToSrgb,
  channelGains,
  toneCurve,
  saturationFactor,
  detailWeights,
  detailSigmas,
  referencePixel,
  boxesForGauss,
  blurPlane,
  renderEdit,
  applyColour,
  autoTone,
};
