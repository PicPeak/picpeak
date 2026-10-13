/**
 * Drawn annotations (issue 1733): the client-side parser every renderer goes
 * through, and the simplification of a freehand stroke before it is sent.
 */
import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_DRAW_MAX_POINTS,
  ANNOTATION_PALETTE,
  finishFreehand,
  parseAnnotation,
  strokePath,
  type AnnotationPoint,
} from '../../../../utils/photoAnnotation';

const free = { t: 'free', c: 0, p: [[0.1, 0.2], [0.3, 0.4]] };

describe('parseAnnotation', () => {
  it('returns a fresh, rounded structure for a valid drawing', () => {
    const input = { v: 1, strokes: [{ t: 'arrow', c: 2, p: [[0.123456, 0], [1, 1]] }] };
    const parsed = parseAnnotation(input);
    expect(parsed).toEqual({ v: 1, strokes: [{ t: 'arrow', c: 2, p: [[0.1235, 0], [1, 1]] }] });
    expect(parsed).not.toBe(input);
  });

  it.each([
    ['null', null],
    ['a JSON string', JSON.stringify({ v: 1, strokes: [free] })],
    ['an extra key', { v: 1, strokes: [free], x: 1 }],
    ['another version', { v: 2, strokes: [free] }],
    ['no strokes', { v: 1, strokes: [] }],
    ['21 strokes', { v: 1, strokes: Array.from({ length: 21 }, () => free) }],
    ['a colour string', { v: 1, strokes: [{ ...free, c: 'red' }] }],
    ['a colour past the palette', { v: 1, strokes: [{ ...free, c: ANNOTATION_PALETTE.length }] }],
    ['an unknown tool', { v: 1, strokes: [{ ...free, t: 'text' }] }],
    ['a stroke with an extra key', { v: 1, strokes: [{ ...free, style: 'x' }] }],
    ['a markup coordinate', { v: 1, strokes: [{ ...free, p: [['"/><script>', 0], [1, 1]] }] }],
    ['a coordinate above 1', { v: 1, strokes: [{ ...free, p: [[0, 0], [1.2, 1]] }] }],
    ['NaN', { v: 1, strokes: [{ ...free, p: [[0, 0], [NaN, 1]] }] }],
    ['a three-point arrow', { v: 1, strokes: [{ t: 'arrow', c: 0, p: [[0, 0], [0.5, 0.5], [1, 1]] }] }],
    ['a one-point stroke', { v: 1, strokes: [{ ...free, p: [[0, 0]] }] }],
  ])('rejects %s', (_label, input) => {
    expect(parseAnnotation(input)).toBeNull();
  });
});

describe('finishFreehand', () => {
  it('drops a tap', () => {
    expect(finishFreehand([[0.5, 0.5]])).toBeNull();
    expect(finishFreehand([[0.5, 0.5], [0.5, 0.5]])).toBeNull();
  });

  it('clamps to the image box and collapses a straight line to its ends', () => {
    const trail: AnnotationPoint[] = Array.from({ length: 50 }, (_, i) => [-0.1 + i * 0.03, 0.5]);
    expect(finishFreehand(trail)).toEqual([[0, 0.5], [1, 0.5]]);
  });

  it('never returns more points than the client cap, and the result still parses', () => {
    // A dense zig-zag: every point is a corner, so nothing is redundant.
    const trail: AnnotationPoint[] = Array.from({ length: 4000 }, (_, i) => [i / 4000, i % 2 ? 0.2 : 0.8]);
    const points = finishFreehand(trail)!;
    expect(points.length).toBeGreaterThanOrEqual(2);
    expect(points.length).toBeLessThanOrEqual(ANNOTATION_DRAW_MAX_POINTS);
    expect(parseAnnotation({ v: 1, strokes: [{ t: 'free', c: 0, p: points }] })).not.toBeNull();
  });

  // The simplification is quadratic at worst, and it runs on the main thread
  // when the pointer lifts. Counted rather than timed: 8000 zig-zag points
  // cost 261 million distance checks before the trail was thinned first.
  it('bounds the work a very long trail costs, and keeps both ends', () => {
    const trail: AnnotationPoint[] = Array.from({ length: 8000 }, (_, i) => [i / 8000, i % 2 ? 0.2 : 0.8]);
    const hypot = Math.hypot;
    let calls = 0;
    Math.hypot = (...values: number[]) => { calls += 1; return hypot(...values); };
    let points: AnnotationPoint[];
    try {
      points = finishFreehand(trail)!;
    } finally {
      Math.hypot = hypot;
    }
    expect(calls).toBeLessThan(10_000_000);
    expect(points[0]).toEqual([0, 0.8]);
    expect(points[points.length - 1]).toEqual([0.9999, 0.2]);
  });
});

describe('strokePath', () => {
  it('draws a freehand stroke as one polyline', () => {
    expect(strokePath({ t: 'free', c: 0, p: [[0, 0], [0.5, 0.25], [1, 1]] }, 1.5)).toBe('M0 0L0.5 0.25L1 1');
  });

  it('adds a head at the end of an arrow, made of numbers only', () => {
    const d = strokePath({ t: 'arrow', c: 0, p: [[0.2, 0.5], [0.8, 0.5]] }, 1.5);
    expect(d.startsWith('M0.2 0.5L0.8 0.5M')).toBe(true);
    expect(d).toMatch(/^[MLe0-9. -]+$/);
    // Two wings meeting at the tip.
    expect(d.split('L0.8 0.5')).toHaveLength(3);
  });
});
