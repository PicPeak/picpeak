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
 *   2. light and colour, in linear light (see the section below): decode,
 *      white balance and exposure as one matrix, detail, shadows and
 *      highlights, contrast, whites and blacks, vibrance and saturation,
 *      black & white, then the output transform (a highlight shoulder for a
 *      JPEG, a sigmoid tone curve for a camera RAW) and the sRGB encoding.
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
  // Camera RAW only: noise reduction in the develop (rawDevelop.noiseOptions).
  nr: [0, 100, 0],
};
const STRAIGHTEN_MAX = 45;
const ROTATIONS = [0, 90, 180, 270];
// A crop narrower than this share of a side is a slip, not an edit.
const MIN_CROP = 0.02;
// The parts batch copy can carry separately (BatchCopyDialog).
const TONE_KEYS = Object.keys(SLIDERS).concat(['bw', 'develop']);
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
  // Camera RAW only: developed from the sensor data even with no other change
  // (the default look), instead of showing the camera's embedded preview.
  develop: false,
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
  for (const key of ['flipH', 'flipV', 'bw', 'develop']) {
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
//
// Scene-referred, in linear light, after the concepts of darktable (a +0.7 EV
// baseline for RAW, white balance as a chromatic adaptation, shadows and
// highlights as exposure shifts by tonal zone, contrast around middle grey,
// a sigmoid tone curve that never clips) and RapidRAW (the single-pass
// order, local contrast in the log domain, temperature on a mired scale).
// Formulas are standard or our own; no code of either project is used.
//
// Per pixel (scenePixel, then outputPixel):
//   decode      JPEG: the sRGB curve to linear. RAW: 16-bit linear from
//               LibRaw, times 2^(0.7 + bias) (the baseline).
//   matrix      white balance (Bradford adaptation from a Planckian light
//               moved in mireds and Duv) and exposure, one 3x3 matrix.
//   detail      clarity and sharpening as a gain 2^G from the pixel's log
//               luminance against a blurred copy (large and 1 px radius).
//   zones       shadows and highlights: exposure shifts weighted by how far
//               the local level is from middle grey.
//   contrast    a power curve on luminance around middle grey.
//   end points  whites and blacks: shifts near the white and the black end.
//   colour      vibrance (dull colours and not skin first) and saturation
//               around luminance, kept from going negative.
//   output      JPEG: identity unless an edit pushed values past white, then
//               a shoulder brings them back. RAW: a log-logistic sigmoid per
//               channel with the hue kept. Then the sRGB curve.

const G0 = 0.1845;
const LOG_G0 = Math.log2(G0);
const RAW_BASELINE_EV = 0.7;
const MIN_LEVEL = 2 ** -16;
const LUMA = [0.2126, 0.7152, 0.0722];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (l) => (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const luminance = (r, g, b) => LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;

// ---- white balance

const SRGB_TO_XYZ = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.0721750, 0.0193339, 0.1191920, 0.9503041];
const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];

function multiply3(a, b) {
  const out = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  }
  return out;
}
function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h; const B = -(d * i - f * g); const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
}
const apply3 = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const XYZ_TO_SRGB = invert3(SRGB_TO_XYZ);
const BRADFORD_INV = invert3(BRADFORD);

/** Chromaticity of a Planckian light, Kim et al. (2002) cubic fit, 1667..25000 K. */
function planckianXy(kelvin) {
  const t = Math.min(25000, Math.max(1667, kelvin));
  const x = t <= 4000
    ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.179910
    : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.240390;
  const y = t <= 2222 ? -1.1063814 * x ** 3 - 1.34811020 * x ** 2 + 2.18555832 * x - 0.20219683
    : t <= 4000 ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
      : 3.0817580 * x ** 3 - 5.87338670 * x ** 2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}
const toUv = ([x, y]) => [4 * x / (-2 * x + 12 * y + 3), 6 * y / (-2 * x + 12 * y + 3)];
const toXy = ([u, v]) => [3 * u / (2 * u - 8 * v + 4), 2 * v / (2 * u - 8 * v + 4)];

/** The light at `mired`, moved `duv` off the Planckian locus towards green (positive) or magenta. */
function lightXy(mired, duv) {
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

/**
 * The white balance matrix (linear sRGB) for the sliders, relative to the
 * picture as it is: temperature moves the light the picture was taken under
 * by up to 150 mired (left: a warmer light was assumed, so the result is
 * cooler), tint by up to 0.03 Duv (right: a greener light, so the result is
 * more magenta). Bradford adaptation, white kept at its luminance. Exactly
 * the identity at 0 / 0.
 */
function whiteBalanceMatrix(temperature, tint) {
  if (!temperature && !tint) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const reference = 1e6 / 6504;
  const mired = Math.min(600, Math.max(40, reference - 1.5 * temperature));
  const cone = (xy) => apply3(BRADFORD, [xy[0] / xy[1], 1, (1 - xy[0] - xy[1]) / xy[1]]);
  const from = cone(lightXy(mired, 0.0003 * tint));
  const to = cone(lightXy(reference, 0));
  const scale = [to[0] / from[0], 0, 0, 0, to[1] / from[1], 0, 0, 0, to[2] / from[2]];
  const m = multiply3(XYZ_TO_SRGB, multiply3(BRADFORD_INV, multiply3(scale, multiply3(BRADFORD, SRGB_TO_XYZ))));
  const white = apply3(m, [1, 1, 1]);
  const norm = luminance(white[0], white[1], white[2]);
  return m.map((v) => v / norm);
}

// ---- the sigmoid of the RAW look

/**
 * A log-logistic curve f(x) = (x+p)^n / ((x+p)^n + e) fitted so middle grey
 * stays middle grey, scene black lands on a deep display black and the slope
 * at grey is `contrast` (the darktable defaults: 1.5, black 0.0152 %). It
 * approaches white without ever reaching it: nothing clips.
 */
function fitSigmoid(contrast = 1.5, black = 0.000152) {
  const ratio = (G0 * (1 - black)) / (black * (1 - G0));
  const fit = (n) => {
    const phi = G0 / (ratio ** (1 / n) - 1);
    return { n, phi, e: (G0 + phi) ** n * (1 - G0) / G0 };
  };
  const first = fit(contrast);
  return fit(contrast * (G0 + first.phi) / G0);
}
const RAW_SIGMOID = fitSigmoid();
const sigmoid = (x, s) => {
  const p = (Math.max(0, x) + s.phi) ** s.n;
  return p / (p + s.e);
};

// ---- detail

/** Clarity and sharpening radii in output pixels: a share of the source's short side, and one pixel. */
function detailSigmas(sourceShortSide, outPerSource = 1) {
  return { clarity: Math.max(1, 0.015 * sourceShortSide * outPerSource), sharpen: 1 };
}
// A halo limiter: linear for texture, back towards 0 across big edges.
const limiter = (d, s) => d / (1 + (d / s) * (d / s));
// Leaves the faintest differences (noise) alone.
const coring = (d, t) => (d * d) / (d * d + t * t);
const levelOf = (y) => Math.log2(Math.max(y, MIN_LEVEL));

/** What the sliders work out to, once per edit; the per-pixel steps read it. */
function prepare(params, { linear = false, exposureBias = 0 } = {}) {
  const exposure = 2 ** params.exposure;
  const matrix = whiteBalanceMatrix(params.temperature, params.tint).map((v) => v * exposure);
  const prep = {
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
  // The white end: where the brightest input (diffuse white, or the sensor's
  // clipping point times the baseline) lands after exposure and contrast.
  const whiteIn = prep.baseline;
  const white = apply3(matrix, [whiteIn, whiteIn, whiteIn]);
  prep.whiteLevel = levelOf(contrastLuminance(prep, luminance(white[0], white[1], white[2])));
  prep.blackLevel = prep.whiteLevel - 10;
  if (!linear) {
    // A JPEG keeps its look until an edit pushes something past white: then
    // the shoulder starts at 0.8 and ends at the brightest probe colour.
    let peak = 1;
    for (const probe of [[1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1]]) {
      const v = scenePixel(prep, probe[0], probe[1], probe[2], 0, 0);
      peak = Math.max(peak, v[0], v[1], v[2]);
    }
    prep.shoulder = peak;
  }
  return prep;
}

function contrastLuminance(prep, y) {
  return prep.gamma === 1 || y <= 0 ? y : G0 * (y / G0) ** prep.gamma;
}

/** How strongly a hue reads as skin (HSV hue near 25 degrees): 1 there, 0 far away. */
function skinWeight(r, g, b) {
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

/**
 * One pixel from linear input to linear scene output, before the output
 * transform. `dc`, `ds`: the pixel's log luminance minus its clarity and
 * sharpening blur (0 without detail).
 */
function scenePixel(prep, r0, g0, b0, dc, ds, result = [0, 0, 0]) {
  const m = prep.matrix;
  let r = m[0] * r0 + m[1] * g0 + m[2] * b0;
  let g = m[3] * r0 + m[4] * g0 + m[5] * b0;
  let b = m[6] * r0 + m[7] * g0 + m[8] * b0;
  let y = luminance(r, g, b);
  const level = levelOf(y);
  const local = limiter(dc, 0.7);

  // Detail and tonal zones, one gain.
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
  // Left darkens the bright zones (recovery), right brightens them.
  if (prep.highlights) shift += 1.5 * prep.highlights * smoothstep(0, 3, zone);
  if (prep.shadows) {
    shift += 1.5 * prep.shadows * (1 - smoothstep(-5, 0, zone)) * (prep.shadows > 0 ? smoothstep(-12, -8.5, zone) : 1);
  }
  if (shift) {
    const gain = 2 ** shift;
    r *= gain; g *= gain; b *= gain;
  }

  // Contrast around middle grey.
  if (prep.gamma !== 1) {
    y = luminance(r, g, b);
    if (y > 0) {
      const gain = contrastLuminance(prep, y) / y;
      r *= gain; g *= gain; b *= gain;
    }
  }

  // Whites and blacks.
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

  // Colour: chroma scaled around luminance, never below zero.
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

/** Scene to display, still linear: the RAW sigmoid or the JPEG shoulder. In place. */
function outputPixel(prep, rgb) {
  let r = rgb[0];
  let g = rgb[1];
  let b = rgb[2];
  if (prep.linear) {
    // Per channel, then the middle channel put back where the hue had it.
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

/** The input value (0..1 encoded for a JPEG, 0..1 linear for a RAW) as scene-linear light. */
const decode = (prep, v) => (prep.linear ? v * prep.baseline : srgbToLinear(v));

/**
 * One pixel by the formulas (the CPU reference): `rgb` as stored (0..1),
 * `dc` / `ds` the detail differences. Returns display sRGB in [0, 1].
 */
function referencePixel(rgb, params, { dc = 0, ds = 0, linear = false, exposureBias = 0, prep } = {}) {
  const p = prep || prepare(params, { linear, exposureBias });
  const out = outputPixel(p, scenePixel(p, decode(p, rgb[0]), decode(p, rgb[1]), decode(p, rgb[2]), dc, ds));
  return [linearToSrgb(clamp01(out[0])), linearToSrgb(clamp01(out[1])), linearToSrgb(clamp01(out[2]))];
}

/** Whether the edit needs the detail planes (the log luminance and its blurs). */
const usesDetail = (prep) => Boolean(prep.clarity || prep.sharpen || prep.shadows || prep.highlights || prep.whites || prep.blacks);

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
 * Gaussian-like blur of an integer plane in place (three box passes each
 * way), with `scratch` the same size. Integer arithmetic, so every JS
 * implementation gets the same numbers.
 */
function blurPlane(plane, scratch, width, height, sigma) {
  for (const size of boxesForGauss(sigma)) {
    const radius = (size - 1) / 2;
    boxPass(plane, scratch, width, height, radius, true);
    boxPass(scratch, plane, width, height, radius, false);
  }
}

// Log luminance in the detail planes: 1/1024 EV steps in an Int16.
const LEVEL_SCALE = 1024;
const quantLevel = (y) => Math.max(-32768, Math.min(32767, Math.round(levelOf(y) * LEVEL_SCALE)));

// ----------------------------------------------------------------- render

/**
 * Bilinear sample at (x, y) in pixel units (centres at +0.5), edges clamped,
 * of interleaved samples; writes three values in the source's scale to `out`.
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
 * Linear display light -> 8-bit sRGB through a 16384-step table with linear
 * interpolation: within half a level of the formula everywhere.
 */
function encoder() {
  const steps = 16384;
  const table = Float64Array.from({ length: steps + 1 }, (_, i) => linearToSrgb(i / steps) * 255);
  return (v) => {
    if (!(v > 0)) return 0;
    if (v >= 1) return 255;
    const p = v * steps;
    const i = p | 0;
    return Math.round(table[i] + (table[i + 1] - table[i]) * (p - i));
  };
}

/**
 * Render an edit. `src` is the upright source, interleaved: 8-bit sRGB
 * (a JPEG and the like) or, with `linear`, 16-bit linear RGB from the RAW
 * develop. `channels` is 3 or 4 (the fourth ignored). Returns
 * `{ data, width, height }`, 8-bit sRGB RGB.
 *
 * Two passes over the output, sampling the source each time, so there is no
 * full-size intermediate: memory is the source, the 3-byte output and, when
 * the edit needs them, three 2-byte detail planes of the output size.
 */
function renderEdit(src, width, height, channels, params, { maxPixels = Infinity, linear = false, exposureBias = 0 } = {}) {
  const out = outputSize(params, width, height, { maxPixels });
  const map = inverseMapper(params, width, height, out);
  const prep = prepare(params, { linear, exposureBias });
  const scale = linear ? 65535 : 255;
  const n = out.width * out.height;
  const px = [0, 0, 0];
  const plain = !hasGeometry(params) && out.width === width && out.height === height;
  // Whole 8-bit values decode through a table; a sample between pixels by the formula.
  const table = linear ? null : Float64Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));
  const sample = (x, y) => {
    if (plain) {
      const s = (y * width + x) * channels;
      if (table) {
        px[0] = table[src[s]]; px[1] = table[src[s + 1]]; px[2] = table[src[s + 2]];
        return;
      }
      px[0] = src[s]; px[1] = src[s + 1]; px[2] = src[s + 2];
    } else {
      const p = map(x + 0.5, y + 0.5);
      sampleBilinear(src, width, height, channels, p.x, p.y, px);
    }
    px[0] = decode(prep, px[0] / scale); px[1] = decode(prep, px[1] / scale); px[2] = decode(prep, px[2] / scale);
  };
  const encode = encoder();
  const rgb = [0, 0, 0];

  let level = null;
  let clarityBlur = null;
  let sharpenBlur = null;
  if (usesDetail(prep)) {
    level = new Int16Array(n);
    for (let y = 0, i = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++, i++) {
        sample(x, y);
        level[i] = quantLevel(luminance(px[0], px[1], px[2]));
      }
    }
    const sigmas = detailSigmas(Math.min(width, height), out.width / out.crop.width);
    const scratch = new Int16Array(n);
    clarityBlur = Int16Array.from(level);
    blurPlane(clarityBlur, scratch, out.width, out.height, sigmas.clarity);
    if (prep.sharpen) {
      sharpenBlur = Int16Array.from(level);
      blurPlane(sharpenBlur, scratch, out.width, out.height, sigmas.sharpen);
    }
  }

  const data = Buffer.alloc(n * 3);
  for (let y = 0, i = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++, i++) {
      sample(x, y);
      const dc = level ? (level[i] - clarityBlur[i]) / LEVEL_SCALE : 0;
      const ds = sharpenBlur ? (level[i] - sharpenBlur[i]) / LEVEL_SCALE : 0;
      outputPixel(prep, scenePixel(prep, px[0], px[1], px[2], dc, ds, rgb));
      const o = i * 3;
      data[o] = encode(rgb[0]);
      data[o + 1] = encode(rgb[1]);
      data[o + 2] = encode(rgb[2]);
    }
  }
  return { data, width: out.width, height: out.height };
}

// --------------------------------------------------------------- auto tone

/**
 * Levels of a picture for Auto tone, from its linear luminances (after the
 * RAW baseline): percentiles and the log mean, in EV. The browser measures
 * its base image; only the resulting slider values are saved.
 */
function toneStats(luminances) {
  const levels = Float64Array.from(luminances, (y) => levelOf(y)).sort();
  const at = (q) => levels[Math.min(levels.length - 1, Math.max(0, Math.floor(q * (levels.length - 1))))];
  let sum = 0;
  for (const level of levels) sum += level;
  return {
    p005: at(0.005), p10: at(0.1), p50: at(0.5), p99: at(0.99), p995: at(0.995),
    mean: levels.length ? sum / levels.length : LOG_G0,
    clipped: luminances.length ? luminances.filter((y) => y >= 0.999).length / luminances.length : 0,
  };
}

/**
 * One-click tone (the order and the "do not brighten what already clips"
 * rule after RapidRAW's auto adjust; the targets are ours): exposure brings
 * the log mean towards middle grey, highlights and shadows pull in what then
 * sits far from it, contrast fits the range into about 8 EV, whites and
 * blacks set the ends. Plain slider values; nothing else is stored.
 */
function autoTone(stats, { linear = false } = {}) {
  const clampTo = (v, min, max) => Math.min(max, Math.max(min, v));
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
  const round = (v) => Math.round(v * 100) + 0;
  return {
    exposure: Math.round(exposure * 100) / 100 + 0,
    contrast: round(contrast),
    highlights: round(highlights),
    shadows: round(shadows),
    whites: round(whites),
    blacks: round(blacks),
  };
}

module.exports = {
  EDIT_VERSION,
  SLIDERS,
  STRAIGHTEN_MAX,
  MIN_CROP,
  TONE_KEYS,
  GEOMETRY_KEYS,
  DEFAULT_PARAMS,
  G0,
  RAW_BASELINE_EV,
  LEVEL_SCALE,
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
  whiteBalanceMatrix,
  fitSigmoid,
  prepare,
  scenePixel,
  outputPixel,
  referencePixel,
  usesDetail,
  detailSigmas,
  quantLevel,
  boxesForGauss,
  blurPlane,
  renderEdit,
  toneStats,
  autoTone,
};
