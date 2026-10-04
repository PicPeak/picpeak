/**
 * redirectTarget: the query a short URL was opened with is carried to the
 * stored target_path (issue 1733). Pins the two shapes the first version
 * lost: a repeated key (`?tag=a&tag=b`) and a value containing `?`.
 */
process.env.NODE_ENV = 'test';
const { redirectTarget } = require('../../src/services/galleryShortUrlService');

describe('galleryShortUrlService.redirectTarget', () => {
  it('appends the incoming query to a bare target', () => {
    expect(redirectTarget('/gallery/wedding', '/s/w?photo=42')).toBe('/gallery/wedding?photo=42');
  });

  it('keeps every value of a repeated key', () => {
    expect(redirectTarget('/gallery/wedding', '/s/w?tag=a&tag=b&photo=42'))
      .toBe('/gallery/wedding?tag=a&tag=b&photo=42');
  });

  it('does not cut a value at a literal question mark', () => {
    expect(redirectTarget('/gallery/wedding', '/s/w?next=/a?photo=42'))
      .toBe('/gallery/wedding?next=%2Fa%3Fphoto%3D42');
  });

  it('lets params already on the stored target win, for that key only', () => {
    expect(redirectTarget('/gallery/wedding?photo=1', '/s/w?photo=2&photo=3&folder=x'))
      .toBe('/gallery/wedding?photo=1&folder=x');
  });

  it('returns the target untouched without a query', () => {
    expect(redirectTarget('/gallery/wedding', '/s/w')).toBe('/gallery/wedding');
    expect(redirectTarget('/gallery/wedding', '/s/w?')).toBe('/gallery/wedding');
  });
});
