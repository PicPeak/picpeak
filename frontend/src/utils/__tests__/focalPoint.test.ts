/**
 * A photo's focal point as CSS object-position (issue 2377): percentages of
 * the photo, nothing without a point, so the browser's centre stays.
 */
import { describe, expect, it } from 'vitest';
import { focalObjectPosition, withFocalPosition } from '../focalPoint';

describe('focalObjectPosition', () => {
  it('turns the stored fractions into percentages', () => {
    expect(focalObjectPosition({ focal_point: { x: 0.9, y: 0.25 } })).toBe('90% 25%');
    expect(focalObjectPosition({ focal_point: { x: 0.123, y: 1 } })).toBe('12.3% 100%');
    expect(focalObjectPosition({ focal_point: { x: 0, y: 0 } })).toBe('0% 0%');
  });

  it('leaves the centre to the browser without a point', () => {
    expect(focalObjectPosition({ focal_point: null })).toBeUndefined();
    expect(focalObjectPosition({})).toBeUndefined();
    expect(focalObjectPosition(null)).toBeUndefined();
    expect(focalObjectPosition({ focal_point: { x: Number.NaN, y: 0.5 } })).toBeUndefined();
  });

  it('clamps a value outside the photo to its edge', () => {
    expect(focalObjectPosition({ focal_point: { x: 1.4, y: -0.2 } })).toBe('100% 0%');
  });
});

describe('withFocalPosition', () => {
  it('adds object-position over the style a tile already has', () => {
    expect(withFocalPosition({ focal_point: { x: 0.75, y: 0.5 } }, { backgroundColor: 'red' }))
      .toEqual({ backgroundColor: 'red', objectPosition: '75% 50%' });
  });

  it('hands the style back untouched without a point', () => {
    const style = { backgroundColor: 'red' };
    expect(withFocalPosition({ focal_point: null }, style)).toBe(style);
    expect(withFocalPosition({ focal_point: null })).toBeUndefined();
  });
});
