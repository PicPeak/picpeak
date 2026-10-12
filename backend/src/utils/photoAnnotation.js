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
 * Only a comment carries one; any other row type gets null.
 */
function withParsedAnnotation(row) {
  return {
    ...row,
    annotation: row.feedback_type === 'comment' ? parseStoredAnnotation(row.annotation) : null,
  };
}

module.exports = {
  ANNOTATION_COLOR_COUNT,
  ANNOTATION_MAX_STROKES,
  ANNOTATION_MAX_POINTS,
  ANNOTATION_MAX_BYTES,
  normalizeAnnotation,
  serializeAnnotation,
  parseStoredAnnotation,
  withParsedAnnotation,
};
