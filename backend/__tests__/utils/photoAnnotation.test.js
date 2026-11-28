/**
 * Drawn annotations on a photo comment (issue 1733): the validator every
 * write and every read goes through.
 */

const {
  ANNOTATION_COLOR_COUNT,
  ANNOTATION_MAX_STROKES,
  ANNOTATION_MAX_POINTS,
  ANNOTATION_MAX_BYTES,
  normalizeAnnotation,
  serializeAnnotation,
  parseStoredAnnotation,
  withParsedAnnotation,
} = require('../../src/utils/photoAnnotation');

const free = (p = [[0.1, 0.2], [0.3, 0.4]], c = 0) => ({ t: 'free', c, p });
const arrow = (p = [[0, 0], [1, 1]], c = 1) => ({ t: 'arrow', c, p });
const doc = (...strokes) => ({ v: 1, strokes });

describe('photoAnnotation', () => {
  it('accepts a freehand stroke and an arrow and rounds to 4 decimals', () => {
    const out = normalizeAnnotation(doc(free([[0.123456, 0.5], [1, 0]]), arrow()));
    expect(out).toEqual({
      v: 1,
      strokes: [
        { t: 'free', c: 0, p: [[0.1235, 0.5], [1, 0]] },
        { t: 'arrow', c: 1, p: [[0, 0], [1, 1]] },
      ],
    });
  });

  it('returns a fresh structure, not the input', () => {
    const input = doc(free());
    const out = normalizeAnnotation(input);
    expect(out).not.toBe(input);
    expect(out.strokes[0]).not.toBe(input.strokes[0]);
    expect(out.strokes[0].p[0]).not.toBe(input.strokes[0].p[0]);
  });

  it('accepts exactly the caps', () => {
    const maxPoints = Array.from({ length: ANNOTATION_MAX_POINTS }, (_, i) => [i / ANNOTATION_MAX_POINTS, 0.5]);
    expect(normalizeAnnotation(doc(free(maxPoints)))).not.toBeNull();
    expect(normalizeAnnotation(doc(...Array.from({ length: ANNOTATION_MAX_STROKES }, () => arrow())))).not.toBeNull();
    expect(normalizeAnnotation(doc(free(undefined, ANNOTATION_COLOR_COUNT - 1)))).not.toBeNull();
  });

  const longStroke = Array.from({ length: ANNOTATION_MAX_POINTS + 1 }, () => [0.5, 0.5]);
  const proto = Object.create({ v: 1, strokes: [free()] });
  class Fancy { constructor() { this.v = 1; this.strokes = [free()]; } }

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', '{"v":1,"strokes":[]}'],
    ['a number', 1],
    ['an array', [free()]],
    ['an empty object', {}],
    ['inherited keys only', proto],
    ['a class instance', new Fancy()],
    ['a missing version', { strokes: [free()] }],
    ['a wrong version', { v: 2, strokes: [free()] }],
    ['a string version', { v: '1', strokes: [free()] }],
    ['an extra top-level key', { v: 1, strokes: [free()], html: '<script>' }],
    ['strokes not an array', { v: 1, strokes: { 0: free() } }],
    ['no strokes', doc()],
    ['too many strokes', doc(...Array.from({ length: ANNOTATION_MAX_STROKES + 1 }, () => arrow()))],
    ['a null stroke', doc(null)],
    ['an array stroke', doc(['free', 0, [[0, 0], [1, 1]]])],
    ['an unknown stroke type', doc({ t: 'rect', c: 0, p: [[0, 0], [1, 1]] })],
    ['a stroke with an extra key', doc({ ...free(), w: 3 })],
    ['a stroke with a missing key', doc({ t: 'free', p: [[0, 0], [1, 1]] })],
    ['a colour string', doc(free(undefined, '#ff0000'))],
    ['a colour string that looks numeric', doc(free(undefined, '1'))],
    ['a colour past the palette', doc(free(undefined, ANNOTATION_COLOR_COUNT))],
    ['a negative colour', doc(free(undefined, -1))],
    ['a fractional colour', doc(free(undefined, 1.5))],
    ['points not an array', doc({ t: 'free', c: 0, p: '0,0 1,1' })],
    ['a one-point freehand stroke', doc(free([[0.5, 0.5]]))],
    ['too many points', doc(free(longStroke))],
    ['a one-point arrow', doc(arrow([[0, 0]]))],
    ['a three-point arrow', doc(arrow([[0, 0], [0.5, 0.5], [1, 1]]))],
    ['a point with one coordinate', doc(free([[0.5], [0.5, 0.5]]))],
    ['a point with three coordinates', doc(free([[0.5, 0.5, 0.5], [0.5, 0.5]]))],
    ['a point object', doc(free([{ x: 0.5, y: 0.5 }, [0.5, 0.5]]))],
    ['a string coordinate', doc(free([['0.5', 0.5], [0.5, 0.5]]))],
    ['a markup coordinate', doc(free([['"/><script>alert(1)</script>', 0.5], [0.5, 0.5]]))],
    ['a null coordinate', doc(free([[null, 0.5], [0.5, 0.5]]))],
    ['a boolean coordinate', doc(free([[true, 0.5], [0.5, 0.5]]))],
    ['NaN', doc(free([[NaN, 0.5], [0.5, 0.5]]))],
    ['Infinity', doc(free([[Infinity, 0.5], [0.5, 0.5]]))],
    ['a coordinate below 0', doc(free([[-0.0001, 0.5], [0.5, 0.5]]))],
    ['a coordinate above 1', doc(free([[0.5, 1.0001], [0.5, 0.5]]))],
  ])('rejects %s', (_label, input) => {
    expect(normalizeAnnotation(input)).toBeNull();
    expect(serializeAnnotation(input)).toBeNull();
  });

  it('enforces the byte cap on the serialised form', () => {
    // 20 strokes of 500 four-decimal points is well past 64 KB.
    const dense = Array.from({ length: ANNOTATION_MAX_POINTS }, (_, i) => [0.1111 + i / 10000, 0.2222]);
    const big = doc(...Array.from({ length: ANNOTATION_MAX_STROKES }, () => free(dense)));
    expect(JSON.stringify(big).length).toBeGreaterThan(ANNOTATION_MAX_BYTES);
    expect(normalizeAnnotation(big)).toBeNull();
  });

  it('serialises from the validated structure and round-trips', () => {
    const text = serializeAnnotation(doc(free([[0.123456, 0.5], [1, 0]])));
    expect(text).toBe('{"v":1,"strokes":[{"t":"free","c":0,"p":[[0.1235,0.5],[1,0]]}]}');
    expect(parseStoredAnnotation(text)).toEqual(JSON.parse(text));
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['not JSON', '{v:1'],
    ['valid JSON, invalid annotation', '{"v":1,"strokes":[{"t":"free","c":"red","p":[[0,0],[1,1]]}]}'],
    ['an object instead of text', doc(free())],
    ['an over-long string', ' '.repeat(ANNOTATION_MAX_BYTES + 1)],
  ])('parses stored %s to null', (_label, stored) => {
    expect(parseStoredAnnotation(stored)).toBeNull();
  });

  it('withParsedAnnotation only ever yields a parsed annotation on a comment row', () => {
    const text = serializeAnnotation(doc(arrow()));
    expect(withParsedAnnotation({ id: 1, feedback_type: 'comment', annotation: text }).annotation)
      .toEqual(doc(arrow()));
    expect(withParsedAnnotation({ id: 2, feedback_type: 'decision', annotation: text }).annotation).toBeNull();
    expect(withParsedAnnotation({ id: 3, feedback_type: 'comment', annotation: 'junk' }).annotation).toBeNull();
    expect(withParsedAnnotation({ id: 4, feedback_type: 'comment' }).annotation).toBeNull();
  });
});

// Issue 2619: a drawing is made on the image shown at the time, which an
// edit may have turned, flipped or cropped since. It is recorded with the
// applied edit's geometry and moved to the current one when shown.
describe('a drawing after the photo was edited', () => {
  const { annotationGeometry, displayAnnotation } = require('../../src/utils/photoAnnotation');
  const math = require('../../src/utils/photoEditMath');
  const params = (input) => math.validateEditParams(input).params;
  const photo = (edit) => ({ width: 600, height: 400, appliedParams: edit ? params(edit) : null });
  const arrow = (from, to) => ({ v: 1, strokes: [{ t: 'arrow', c: 0, p: [from, to] }] });
  const stored = (a) => JSON.stringify(a);

  it('records the geometry of the applied edit, nothing for a photo shown unedited', () => {
    expect(annotationGeometry(null)).toBeNull();
    expect(annotationGeometry(params({ exposure: 1 }))).toBeNull();
    expect(JSON.parse(annotationGeometry(params({ rotate: 90, exposure: 1 })))).toMatchObject({ rotate: 90, crop: null });
  });

  it('turns with a rotation made after it', () => {
    const shown = displayAnnotation(stored(arrow([0.1, 0.2], [0.5, 0.5])), null, photo({ rotate: 90 }));
    expect(shown.clipped).toBe(false);
    // Turned clockwise: x' = 1 - y, y' = x.
    expect(shown.annotation.strokes[0].p).toEqual([[0.8, 0.1], [0.5, 0.5]]);
  });

  it('mirrors with a flip', () => {
    const shown = displayAnnotation(stored(arrow([0.1, 0.2], [0.3, 0.4])), null, photo({ flipH: true }));
    expect(shown.annotation.strokes[0].p).toEqual([[0.9, 0.2], [0.7, 0.4]]);
  });

  it('hides what a crop removed and says so', () => {
    const drawing = { v: 1, strokes: [
      { t: 'arrow', c: 0, p: [[0.1, 0.5], [0.2, 0.5]] },
      { t: 'free', c: 1, p: [[0.3, 0.5], [0.6, 0.5], [0.8, 0.5], [0.9, 0.5]] },
    ] };
    const shown = displayAnnotation(stored(drawing), null, photo({ crop: { x: 0.5, y: 0, w: 0.5, h: 1 } }));
    expect(shown.clipped).toBe(true);
    // The arrow was in the left half: gone. The line keeps what is in the
    // right half, from where it crosses the crop's edge.
    expect(shown.annotation.strokes).toEqual([{ t: 'free', c: 1, p: [[0, 0.5], [0.2, 0.5], [0.6, 0.5], [0.8, 0.5]] }]);
  });

  it('keeps the middle of a line drawn across a crop whose ends are both outside it', () => {
    const across = { v: 1, strokes: [{ t: 'free', c: 0, p: [[0.1, 0.5], [0.9, 0.5]] }] };
    const shown = displayAnnotation(stored(across), null, photo({ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }));
    expect(shown.clipped).toBe(true);
    expect(shown.annotation.strokes).toEqual([{ t: 'free', c: 0, p: [[0, 0.5], [1, 0.5]] }]);
  });

  it('splits a stroke that leaves the crop and comes back into two pieces', () => {
    // Right half kept (x 0.5..1, shown as 0..1): in, out across the left edge, in again.
    const wander = { v: 1, strokes: [{ t: 'free', c: 2, p: [[0.75, 0.2], [0.25, 0.2], [0.25, 0.8], [0.75, 0.8]] }] };
    const shown = displayAnnotation(stored(wander), null, photo({ crop: { x: 0.5, y: 0, w: 0.5, h: 1 } }));
    expect(shown.clipped).toBe(true);
    expect(shown.annotation.strokes).toEqual([
      { t: 'free', c: 2, p: [[0.5, 0.2], [0, 0.2]] },
      { t: 'free', c: 2, p: [[0, 0.8], [0.5, 0.8]] },
    ]);
  });

  it('goes back to the original after a reset, and nothing is shown when all of it was cropped away', () => {
    const turned = annotationGeometry(params({ rotate: 90 }));
    const back = displayAnnotation(stored(arrow([0.8, 0.1], [0.5, 0.5])), turned, photo(null));
    expect(back.annotation.strokes[0].p).toEqual([[0.1, 0.2], [0.5, 0.5]]);
    const gone = displayAnnotation(stored(arrow([0.1, 0.1], [0.2, 0.2])), null, photo({ crop: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } }));
    expect(gone).toEqual({ annotation: null, clipped: true });
  });

  it('leaves a drawing on an unchanged geometry as it was', () => {
    const turned = annotationGeometry(params({ rotate: 90 }));
    const same = displayAnnotation(stored(arrow([0.1, 0.2], [0.3, 0.4])), turned, photo({ rotate: 90, exposure: 0.5 }));
    expect(same).toEqual({ annotation: arrow([0.1, 0.2], [0.3, 0.4]), clipped: false });
  });
});
