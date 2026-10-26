/**
 * Issue 2261: portrait photos were cropped in the live slideshow because every
 * slide used object-fit: cover. 'auto' (the new default) fills the screen only
 * when the photo's orientation matches the screen's.
 */
import { describe, expect, it } from 'vitest';
import { slideObjectFit } from '../SlideshowPage';

const LANDSCAPE_SCREEN = { width: 1920, height: 1080 };
const PORTRAIT_SCREEN = { width: 1080, height: 1920 };
const PORTRAIT = { width: 3000, height: 4500 };
const LANDSCAPE = { width: 4500, height: 3000 };
const SQUARE = { width: 2000, height: 2000 };

describe('slideObjectFit', () => {
  it('auto shows a portrait photo whole on a landscape screen', () => {
    expect(slideObjectFit('auto', PORTRAIT, LANDSCAPE_SCREEN)).toBe('contain');
  });

  it('auto fills a landscape screen with a landscape photo', () => {
    expect(slideObjectFit('auto', LANDSCAPE, LANDSCAPE_SCREEN)).toBe('cover');
  });

  it('auto follows a portrait screen the other way round', () => {
    expect(slideObjectFit('auto', PORTRAIT, PORTRAIT_SCREEN)).toBe('cover');
    expect(slideObjectFit('auto', LANDSCAPE, PORTRAIT_SCREEN)).toBe('contain');
  });

  it('auto shows a square photo, or one whose size is not known yet, whole', () => {
    expect(slideObjectFit('auto', SQUARE, LANDSCAPE_SCREEN)).toBe('contain');
    expect(slideObjectFit('auto', null, LANDSCAPE_SCREEN)).toBe('contain');
    expect(slideObjectFit('auto', { width: 0, height: 0 }, LANDSCAPE_SCREEN)).toBe('contain');
  });

  it.each([PORTRAIT, LANDSCAPE, SQUARE, null])('contain never crops and cover always fills (%o)', (photo) => {
    expect(slideObjectFit('contain', photo, LANDSCAPE_SCREEN)).toBe('contain');
    expect(slideObjectFit('cover', photo, LANDSCAPE_SCREEN)).toBe('cover');
  });
});
