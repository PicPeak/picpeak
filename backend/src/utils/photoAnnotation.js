/**
 * Drawn annotations on a photo comment (issue 1733, item A2).
 *
 * Shape:
 *   { v: 1, strokes: [{ t: 'free' | 'arrow', c: <palette index>, p: [[x, y], ...] }] }
 * with x and y in 0..1 relative to the image box, 4 decimals.
 *
 * The one place an annotation is validated. Both directions go through it:
 * a submission is normalised and re-serialised from the validated structure
 * (the client's string is never stored), and a stored value is parsed through
 * the same rules before it leaves the server, so a row written by anything
 * else still cannot ship a string into an SVG attribute.
 *
 * Mirrored in frontend/src/utils/photoAnnotation.ts — update both together.
 */

const ANNOTATION_VERSION = 1;
/** Size of the fixed palette the client draws from; `c` indexes into it. */
const ANNOTATION_COLOR_COUNT = 6;
const ANNOTATION_MAX_STROKES = 20;
const ANNOTATION_MAX_POINTS = 500;
const ANNOTATION_MAX_BYTES = 64 * 1024;
const STROKE_TYPES = ['free', 'arrow'];

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactlyKeys(value, keys) {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function normalizePoint(point) {
  if (!Array.isArray(point) || point.length !== 2) return null;
  const out = [];
  for (const n of point) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) return null;
    out.push(Math.round(n * 10000) / 10000);
  }
  return out;
}

function normalizeStroke(stroke) {
  if (!isPlainObject(stroke) || !hasExactlyKeys(stroke, ['t', 'c', 'p'])) return null;
  if (!STROKE_TYPES.includes(stroke.t)) return null;
  if (!Number.isInteger(stroke.c) || stroke.c < 0 || stroke.c >= ANNOTATION_COLOR_COUNT) return null;
  if (!Array.isArray(stroke.p)) return null;
  const validLength = stroke.t === 'arrow'
    ? stroke.p.length === 2
    : stroke.p.length >= 2 && stroke.p.length <= ANNOTATION_MAX_POINTS;
  if (!validLength) return null;
  const points = [];
  for (const point of stroke.p) {
    const normalized = normalizePoint(point);
    if (!normalized) return null;
    points.push(normalized);
  }
  return { t: stroke.t, c: stroke.c, p: points };
}

/**
 * Validate an already-parsed annotation. Returns a fresh structure built only
 * from the validated numbers and enum values, or null when anything at all is
 * off (wrong type, out of range, over a cap, an extra key).
 */
function normalizeAnnotation(value) {
  if (!isPlainObject(value) || !hasExactlyKeys(value, ['v', 'strokes'])) return null;
  if (value.v !== ANNOTATION_VERSION) return null;
  if (!Array.isArray(value.strokes)) return null;
  if (value.strokes.length < 1 || value.strokes.length > ANNOTATION_MAX_STROKES) return null;
  const strokes = [];
  for (const stroke of value.strokes) {
    const normalized = normalizeStroke(stroke);
    if (!normalized) return null;
    strokes.push(normalized);
  }
  const annotation = { v: ANNOTATION_VERSION, strokes };
  if (Buffer.byteLength(JSON.stringify(annotation), 'utf8') > ANNOTATION_MAX_BYTES) return null;
  return annotation;
}

/** The text stored in photo_feedback.annotation, or null when invalid. */
function serializeAnnotation(value) {
  const annotation = normalizeAnnotation(value);
  return annotation ? JSON.stringify(annotation) : null;
}

/** A stored value back into the validated structure; null for anything else. */
function parseStoredAnnotation(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > ANNOTATION_MAX_BYTES) return null;
  try {
    return normalizeAnnotation(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Replace a feedback row's raw `annotation` text with the parsed structure.
 * Only a comment carries one; any other row type gets null. With `photo`
 * ({ width, height, appliedParams }: the original's size and the applied
 * edit), the drawing is moved from the geometry it was made on (the row's
 * annotation_geometry) to the one shown now, and annotation_clipped says
 * whether part of it is outside the current crop (issue 2619).
 */
function withParsedAnnotation(row, photo = null) {
  const { annotation_geometry: geometry, ...rest } = row;
  if (rest.feedback_type !== 'comment') return { ...rest, annotation: null };
  if (!photo) return { ...rest, annotation: parseStoredAnnotation(rest.annotation) };
  const shown = displayAnnotation(rest.annotation, geometry, photo);
  return { ...rest, annotation: shown.annotation, annotation_clipped: shown.clipped };
}

// ------------------------------------------------- the photo's edit (2619)
//
// A drawing's points are fractions of the image shown when it was made. A
// photo edit (issue 2619) may turn, flip or crop that image later, so a
// drawing is stored with the geometry of the edit applied when it was made
// (photo_feedback.annotation_geometry, null: the unedited original) and is
// moved to the geometry applied now when it is shown, through the original
// image, as focal points and face boxes are. What a crop removed is left
// out, and the result says so.

/** The stored geometry of an applied edit (its params), or null when it does not move a pixel. */
function annotationGeometry(appliedParams) {
  const math = require('./photoEditMath');
  if (!appliedParams) return null;
  const geometry = Object.fromEntries(math.GEOMETRY_KEYS.map((key) => [key, appliedParams[key] ?? math.DEFAULT_PARAMS[key]]));
  const unchanged = math.GEOMETRY_KEYS.every((key) => JSON.stringify(geometry[key]) === JSON.stringify(math.DEFAULT_PARAMS[key]));
  return unchanged ? null : JSON.stringify(geometry);
}

function storedGeometry(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const math = require('./photoEditMath');
    const { params, error } = math.validateEditParams({ v: 1, ...JSON.parse(text) });
    return error ? null : annotationGeometry(params);
  } catch {
    return null;
  }
}

/**
 * The part of the segment a..b inside the unit square (Liang-Barsky), as
 * { from, to, t0, t1 } with t the position along it (0: a, 1: b); null when
 * none of it is inside.
 */
function clipSegment(a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const EPS = 1e-6;
  for (const [p, q] of [[-dx, a[0] + EPS], [dx, 1 + EPS - a[0]], [-dy, a[1] + EPS], [dy, 1 + EPS - a[1]]]) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return { from: [a[0] + t0 * dx, a[1] + t0 * dy], to: [a[0] + t1 * dx, a[1] + t1 * dy], t0, t1 };
}

/**
 * The stored drawing (`text`, made on `geometryText`) as it lies on the
 * photo now: `photo` is { width, height } of the original and the applied
 * edit's params. Returns { annotation, clipped }: clipped when part of the
 * drawing is outside the current crop (and left out); annotation null when
 * nothing of it is left, or nothing valid was stored.
 */
function displayAnnotation(text, geometryText, photo) {
  const annotation = parseStoredAnnotation(text);
  if (!annotation) return { annotation: null, clipped: false };
  const from = storedGeometry(geometryText);
  const to = annotationGeometry(photo.appliedParams || null);
  const width = Number(photo.width);
  const height = Number(photo.height);
  if (from === to || !(width > 0) || !(height > 0)) return { annotation, clipped: false };
  const math = require('./photoEditMath');
  const full = (geometry) => (geometry ? { ...math.DEFAULT_PARAMS, ...JSON.parse(geometry) } : null);
  const before = full(from);
  const after = full(to);
  // Where a point lies on the picture shown, outside 0..1 where a crop
  // removed it. The geometry is affine, so a straight segment stays one.
  const move = ([x, y]) => {
    let point = { x, y };
    if (before) point = math.mapPointFromEdited(before, width, height, point);
    if (after) point = math.mapPointToEdited(after, width, height, point);
    return [point.x, point.y];
  };
  const round = (v) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
  const shown = (point) => [round(point[0]), round(point[1])];
  const inside = ([x, y]) => x >= -1e-6 && x <= 1 + 1e-6 && y >= -1e-6 && y <= 1 + 1e-6;
  let clipped = false;
  const strokes = [];
  for (const stroke of annotation.strokes) {
    const moved = stroke.p.map(move);
    if (stroke.t === 'arrow') {
      // An arrow cut short loses its head or its tail: all of it, or none.
      if (moved.every(inside)) strokes.push({ ...stroke, p: moved.map(shown) });
      else clipped = true;
      continue;
    }
    // A line leaves the crop and may come back: each segment is cut at the
    // crop's edges, and the parts inside it stay, a piece each.
    let run = [];
    const close = () => {
      if (run.length >= 2) strokes.push({ ...stroke, p: run });
      run = [];
    };
    for (let i = 1; i < moved.length; i++) {
      const cut = clipSegment(moved[i - 1], moved[i]);
      if (!cut) { clipped = true; close(); continue; }
      if (cut.t0 > 0) { clipped = true; close(); }
      if (!run.length) run.push(shown(cut.from));
      run.push(shown(cut.to));
      if (cut.t1 < 1) { clipped = true; close(); }
    }
    close();
  }
  if (strokes.length > ANNOTATION_MAX_STROKES) {
    strokes.length = ANNOTATION_MAX_STROKES;
    clipped = true;
  }
  const result = strokes.length ? normalizeAnnotation({ v: ANNOTATION_VERSION, strokes }) : null;
  return { annotation: result, clipped: clipped || !result };
}

module.exports = {
  annotationGeometry,
  displayAnnotation,
  ANNOTATION_COLOR_COUNT,
  ANNOTATION_MAX_STROKES,
  ANNOTATION_MAX_POINTS,
  ANNOTATION_MAX_BYTES,
  normalizeAnnotation,
  serializeAnnotation,
  parseStoredAnnotation,
  withParsedAnnotation,
};
