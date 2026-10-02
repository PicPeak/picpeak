/**
 * The rating-derived XMP colour label must treat "no rating" the same on
 * both engines. photos.average_rating is a decimal column, and Postgres
 * hands decimals to node as strings: an unrated photo arrives as "0.00",
 * which is truthy, so the old `if (!avgRating)` guard let it through and
 * every unrated photo was exported with a Purple label. SQLite returns the
 * number 0 and never showed the bug.
 */
const { XmpGenerator } = require('../../src/services/xmpGenerator');

describe('XmpGenerator.mapRatingToLabel', () => {
  const generator = new XmpGenerator();

  it('gives an unrated photo no label whatever shape the engine returns', () => {
    expect(generator.mapRatingToLabel('0.00')).toBeNull();
    expect(generator.mapRatingToLabel(0)).toBeNull();
    expect(generator.mapRatingToLabel(null)).toBeNull();
    expect(generator.mapRatingToLabel(undefined)).toBeNull();
    expect(generator.mapRatingToLabel('')).toBeNull();
    expect(generator.mapRatingToLabel('not a number')).toBeNull();
  });

  it('maps a decimal string the way it maps the number', () => {
    expect(generator.mapRatingToLabel('4.50')).toBe('Red');
    expect(generator.mapRatingToLabel(4.5)).toBe('Red');
    expect(generator.mapRatingToLabel('3.50')).toBe('Yellow');
    expect(generator.mapRatingToLabel('2.50')).toBe('Green');
    expect(generator.mapRatingToLabel('1.50')).toBe('Blue');
    expect(generator.mapRatingToLabel('1.00')).toBe('Purple');
  });

  it('leaves xmp:Label out of the sidecar for an unrated photo on Postgres', () => {
    const xmp = generator.generateXmp({
      filename: 'a.jpg', average_rating: '0.00', like_count: 0, favorite_count: 0,
    });
    expect(xmp).not.toContain('xmp:Label');
    expect(xmp).toContain('xmp:Rating="0"');
  });
});
