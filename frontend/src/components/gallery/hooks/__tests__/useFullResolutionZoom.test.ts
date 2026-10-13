import { describe, expect, it } from 'vitest';
import {
  BASE_MAX_ZOOM, TOUCH_PIXEL_BUDGET, actualPixelsZoom, maxZoomFor, overlayBox, withinPixelBudget,
} from '../useFullResolutionZoom';

describe('full-resolution zoom maths', () => {
  it('puts 100 % where one image pixel covers one device pixel', () => {
    expect(actualPixelsZoom({ width: 6000, height: 4000 }, { width: 600, height: 400 }, 1)).toBe(10);
    expect(actualPixelsZoom({ width: 6000, height: 4000 }, { width: 600, height: 400 }, 2)).toBe(5);
    expect(actualPixelsZoom({ width: 6000, height: 4000 }, { width: 600, height: 400 }, 3)).toBeCloseTo(3.333, 3);
  });

  it('compares long edges, so dimensions stated before EXIF rotation still work', () => {
    expect(actualPixelsZoom({ width: 4000, height: 6000 }, { width: 400, height: 600 }, 1)).toBe(10);
    expect(actualPixelsZoom({ width: 6000, height: 4000 }, { width: 400, height: 600 }, 1)).toBe(10);
  });

  it('has no answer without a rendered box', () => {
    expect(actualPixelsZoom({ width: 6000, height: 4000 }, { width: 0, height: 0 }, 1)).toBeNull();
    expect(actualPixelsZoom({ width: 0, height: 0 }, { width: 600, height: 400 }, 1)).toBeNull();
  });

  it('never drops the ceiling below 3x of fit', () => {
    expect(maxZoomFor(null)).toBe(BASE_MAX_ZOOM);
    expect(maxZoomFor(1.2)).toBe(BASE_MAX_ZOOM);
    expect(maxZoomFor(0.4)).toBe(BASE_MAX_ZOOM);
    expect(maxZoomFor(7.5)).toBe(7.5);
  });

  it('draws the original in its own proportions inside the preview box', () => {
    expect(overlayBox({ width: 6000, height: 4000 }, { width: 600, height: 400 })).toEqual({ width: 600, height: 400 });
    // A square thumbnail standing in for the preview.
    expect(overlayBox({ width: 6000, height: 4000 }, { width: 300, height: 300 })).toEqual({ width: 300, height: 200 });
    expect(overlayBox({ width: 4000, height: 6000 }, { width: 300, height: 300 })).toEqual({ width: 200, height: 300 });
  });

  it('budgets pixels on touch devices only, and treats unknown dimensions as too large there', () => {
    const big = { width: 10000, height: 6000 };
    expect(big.width * big.height).toBeGreaterThan(TOUCH_PIXEL_BUDGET);
    expect(withinPixelBudget(big, false)).toBe(true);
    expect(withinPixelBudget(null, false)).toBe(true);
    expect(withinPixelBudget(big, true)).toBe(false);
    expect(withinPixelBudget(null, true)).toBe(false);
    expect(withinPixelBudget({ width: 8000, height: 6000 }, true)).toBe(true);
  });
});
