/**
 * Unit tests for the shared hidden-photo access-control helper.
 *
 * Pins the rule that ordinary gallery guests never receive photos with
 * visibility='hidden' (NULL = visible), while PIN-clients see everything.
 */
const {
  canSeeHiddenPhotos,
  isPhotoHiddenFromViewer,
} = require('../../src/utils/photoVisibility');

describe('canSeeHiddenPhotos', () => {
  it('is true only for the client access level', () => {
    expect(canSeeHiddenPhotos('client')).toBe(true);
    expect(canSeeHiddenPhotos('guest')).toBe(false);
    expect(canSeeHiddenPhotos('slideshow')).toBe(false);
    expect(canSeeHiddenPhotos(undefined)).toBe(false);
  });
});

describe('isPhotoHiddenFromViewer', () => {
  it('blocks a hidden photo from guests', () => {
    expect(isPhotoHiddenFromViewer({ visibility: 'hidden' }, 'guest')).toBe(true);
    expect(isPhotoHiddenFromViewer({ visibility: 'hidden' }, 'slideshow')).toBe(true);
  });

  it('lets clients see hidden photos', () => {
    expect(isPhotoHiddenFromViewer({ visibility: 'hidden' }, 'client')).toBe(false);
  });

  it('treats visible and NULL visibility as viewable by everyone', () => {
    expect(isPhotoHiddenFromViewer({ visibility: 'visible' }, 'guest')).toBe(false);
    expect(isPhotoHiddenFromViewer({ visibility: null }, 'guest')).toBe(false);
    expect(isPhotoHiddenFromViewer({}, 'guest')).toBe(false);
  });

  it('is null-safe', () => {
    expect(isPhotoHiddenFromViewer(null, 'guest')).toBe(false);
  });
});
