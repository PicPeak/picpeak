/**
 * Unit tests for the shared hidden-photo access-control helper.
 *
 * Pins the rule that ordinary gallery guests never receive photos with
 * visibility='hidden' (NULL = visible), while PIN-clients see everything.
 */
const {
  canSeeHiddenPhotos,
  isPhotoHiddenFromViewer,
  seesWholeSource,
  viewerOf,
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
    expect(isPhotoHiddenFromViewer({ visibility: 'visible', selection_hidden: false }, 'guest')).toBe(false);
    expect(isPhotoHiddenFromViewer({ visibility: null, selection_hidden: false }, 'guest')).toBe(false);
    expect(isPhotoHiddenFromViewer({ selection_hidden: 0 }, 'guest')).toBe(false);
  });

  it('is null-safe', () => {
    expect(isPhotoHiddenFromViewer(null, 'guest')).toBe(false);
  });

  it('blocks a photo under review from every viewer, clients included (migration 269)', () => {
    for (const status of ['pending', 'rejected']) {
      expect(isPhotoHiddenFromViewer({ visibility: 'hidden', moderation_status: status }, 'client')).toBe(true);
      expect(isPhotoHiddenFromViewer({ visibility: 'hidden', moderation_status: status }, 'guest')).toBe(true);
    }
    expect(isPhotoHiddenFromViewer({ visibility: 'hidden', moderation_status: null }, 'client')).toBe(false);
  });
});

describe('curated selection (issue 2356)', () => {
  const outside = { visibility: 'visible', selection_hidden: true };
  const full = { accessLevel: 'guest', fullView: true };

  it('keeps a photo outside the selection from ordinary guests and the slideshow', () => {
    expect(isPhotoHiddenFromViewer(outside, 'guest')).toBe(true);
    expect(isPhotoHiddenFromViewer({ ...outside, selection_hidden: 1 }, 'guest')).toBe(true);
    expect(isPhotoHiddenFromViewer(outside, { accessLevel: 'slideshow', fullView: true })).toBe(true);
  });

  it('shows it to the full link and the client, but not a hidden one to the full link', () => {
    expect(isPhotoHiddenFromViewer(outside, full)).toBe(false);
    expect(isPhotoHiddenFromViewer(outside, 'client')).toBe(false);
    expect(isPhotoHiddenFromViewer({ ...outside, visibility: 'hidden' }, full)).toBe(true);
  });

  it('refuses a row read without the column rather than guessing', () => {
    expect(isPhotoHiddenFromViewer({ visibility: 'visible' }, 'guest')).toBe(true);
    expect(isPhotoHiddenFromViewer({ visibility: 'visible' }, full)).toBe(false);
  });

  it('reads the viewer off the request', () => {
    expect(viewerOf({ accessLevel: 'guest', galleryFullView: true })).toEqual(full);
    expect(viewerOf({ accessLevel: 'guest' })).toEqual({ accessLevel: 'guest', fullView: false });
    expect(seesWholeSource('guest')).toBe(false);
    expect(seesWholeSource(full)).toBe(true);
    expect(seesWholeSource('client')).toBe(true);
  });
});
