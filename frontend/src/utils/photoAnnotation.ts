/**
 * Drawn annotations on a photo comment (issue 1733, item A2).
 *
 *   { v: 1, strokes: [{ t: 'free' | 'arrow', c: <palette index>, p: [[x, y], ...] }] }
 *
 * x and y are 0..1 relative to the image box. Mirrored in
 * backend/src/utils/photoAnnotation.js — update both together.
 *
 * Everything that draws an annotation goes through parseAnnotation first, so
 * only validated numbers and palette entries ever reach an SVG attribute.
 */

export type AnnotationPoint = [number, number];
export type AnnotationTool = 'free' | 'arrow';

export interface AnnotationStroke {
  t: AnnotationTool;
  c: number;
  p: AnnotationPoint[];
}

export interface PhotoAnnotation {
  v: 1;
  strokes: AnnotationStroke[];
}

/**
 * The fixed palette `c` indexes into. Literal colours on purpose, like the
 * colour-label swatches: a mark has to read the same on every gallery theme.
 * The server only knows the palette's size (ANNOTATION_COLOR_COUNT).
 */
export const ANNOTATION_PALETTE = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#ffffff', '#111827'] as const;

export const ANNOTATION_MAX_STROKES = 20;
/** What the server accepts per freehand stroke. */
export const ANNOTATION_MAX_POINTS = 500;
/**
 * What the client sends per freehand stroke. Lower than the server's cap so
 * that 20 full strokes still fit the server's 64 KB limit on the whole
 * drawing (20 x 150 points x 16 characters is about 48 KB).
 */
export const ANNOTATION_DRAW_MAX_POINTS = 150;
/**
 * How much of a pointer trail the simplification below looks at. Its worst
 * case is quadratic (a dense zig-zag, as in shading an area): 4000 points
 * took over a second on the main thread when the pointer lifted. A longer
 * trail is thinned evenly to this many points first, still several times
 * what is kept in the end.
 */
const ANNOTATION_TRAIL_MAX_POINTS = 1000;

const round4 = (n: number) => Math.round(n * 10000) / 10000;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

function parsePoint(point: unknown): AnnotationPoint | null {
  if (!Array.isArray(point) || point.length !== 2) return null;
  const [x, y] = point;
  for (const n of [x, y]) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) return null;
  }
  return [round4(x), round4(y)];
}

function parseStroke(stroke: unknown): AnnotationStroke | null {
  if (!isPlainObject(stroke) || !hasExactlyKeys(stroke, ['t', 'c', 'p'])) return null;
  const { t, c, p } = stroke;
  if (t !== 'free' && t !== 'arrow') return null;
  if (typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c >= ANNOTATION_PALETTE.length) return null;
  if (!Array.isArray(p)) return null;
  if (t === 'arrow' ? p.length !== 2 : p.length < 2 || p.length > ANNOTATION_MAX_POINTS) return null;
  const points: AnnotationPoint[] = [];
  for (const point of p) {
    const parsed = parsePoint(point);
    if (!parsed) return null;
    points.push(parsed);
  }
  return { t, c, p: points };
}

/**
 * Validate whatever the API handed over. Returns a fresh structure built from
 * the validated numbers only, or null when anything is off.
 */
export function parseAnnotation(value: unknown): PhotoAnnotation | null {
  if (!isPlainObject(value) || !hasExactlyKeys(value, ['v', 'strokes'])) return null;
  if (value.v !== 1 || !Array.isArray(value.strokes)) return null;
  if (value.strokes.length < 1 || value.strokes.length > ANNOTATION_MAX_STROKES) return null;
  const strokes: AnnotationStroke[] = [];
  for (const stroke of value.strokes) {
    const parsed = parseStroke(stroke);
    if (!parsed) return null;
    strokes.push(parsed);
  }
  return { v: 1, strokes };
}

/** Distance from `p` to the segment a-b. */
function segmentDistance(p: AnnotationPoint, a: AnnotationPoint, b: AnnotationPoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Ramer-Douglas-Peucker: drop the points a straight line already covers. */
function simplify(points: AnnotationPoint[], epsilon: number): AnnotationPoint[] {
  if (points.length <= 2) return points;
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let worst = 0;
    let index = -1;
    for (let i = first + 1; i < last; i += 1) {
      const distance = segmentDistance(points[i], points[first], points[last]);
      if (distance > worst) {
        worst = distance;
        index = i;
      }
    }
    if (index !== -1 && worst > epsilon) {
      keep[index] = true;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Turn the raw pointer trail of a freehand stroke into what is sent: clamped,
 * rounded, simplified, and never more than ANNOTATION_DRAW_MAX_POINTS points.
 * Null when the trail is not a line (a tap).
 */
export function finishFreehand(trail: AnnotationPoint[]): AnnotationPoint[] | null {
  const clamp = (n: number) => round4(Math.max(0, Math.min(1, n)));
  let points = trail.map(([x, y]): AnnotationPoint => [clamp(x), clamp(y)]);
  points = points.filter((point, i) => i === 0 || point[0] !== points[i - 1][0] || point[1] !== points[i - 1][1]);
  if (points.length < 2) return null;
  if (points.length > ANNOTATION_TRAIL_MAX_POINTS) {
    const all = points;
    const step = (all.length - 1) / (ANNOTATION_TRAIL_MAX_POINTS - 1);
    points = Array.from({ length: ANNOTATION_TRAIL_MAX_POINTS }, (_, i) => all[Math.round(i * step)]);
  }
  for (let epsilon = 0.0015; points.length > ANNOTATION_DRAW_MAX_POINTS; epsilon *= 2) {
    points = simplify(points, epsilon);
  }
  return simplify(points, 0.0015);
}

/**
 * SVG path data for one stroke in the 0..1 viewBox. `aspect` (width / height
 * of the image box) keeps an arrow head from being squashed by the
 * non-uniform viewBox. Built from numbers alone.
 */
export function strokePath(stroke: AnnotationStroke, aspect: number): string {
  const [first, ...rest] = stroke.p;
  const line = `M${first[0]} ${first[1]}${rest.map(([x, y]) => `L${x} ${y}`).join('')}`;
  if (stroke.t !== 'arrow') return line;

  // Work in units of the image height, where the picture is not distorted.
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const [from, to] = stroke.p;
  const dx = (to[0] - from[0]) * safeAspect;
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return line;
  const head = Math.min(0.05 * Math.min(safeAspect, 1), length * 0.5);
  const angle = Math.atan2(dy, dx);
  const wing = (offset: number) => {
    const x = to[0] * safeAspect - head * Math.cos(angle + offset);
    const y = to[1] - head * Math.sin(angle + offset);
    return `${round4(x / safeAspect)} ${round4(y)}`;
  };
  return `${line}M${wing(Math.PI / 7)}L${to[0]} ${to[1]}L${wing(-Math.PI / 7)}`;
}
