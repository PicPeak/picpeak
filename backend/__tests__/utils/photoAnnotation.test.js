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
