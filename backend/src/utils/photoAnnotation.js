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
  const move = ([x, y]) => {
    let point = { x, y };
    if (before) point = math.mapPointFromEdited(before, width, height, point);
    if (after) point = math.mapPointToEdited(after, width, height, point);
    const round = (v) => Math.round(v * 10000) / 10000;
    const inside = point.x >= -1e-6 && point.x <= 1 + 1e-6 && point.y >= -1e-6 && point.y <= 1 + 1e-6;
    return inside ? [round(Math.min(1, Math.max(0, point.x))), round(Math.min(1, Math.max(0, point.y)))] : null;
  };
  let clipped = false;
  const strokes = [];
  for (const stroke of annotation.strokes) {
    const moved = stroke.p.map(move);
    if (stroke.t === 'arrow') {
      if (moved.every(Boolean)) strokes.push({ ...stroke, p: moved });
      else clipped = true;
      continue;
    }
    // A line leaves the crop and may come back: the parts inside it stay.
    let run = [];
    for (const point of [...moved, null]) {
      if (point) { run.push(point); continue; }
      if (run.length >= 2) strokes.push({ ...stroke, p: run });
      run = [];
    }
    if (moved.some((point) => !point)) clipped = true;
  }
  if (strokes.length > ANNOTATION_MAX_STROKES) {
    strokes.length = ANNOTATION_MAX_STROKES;
    clipped = true;
  }
  const shown = strokes.length ? normalizeAnnotation({ v: ANNOTATION_VERSION, strokes }) : null;
  return { annotation: shown, clipped: clipped || !shown };
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
