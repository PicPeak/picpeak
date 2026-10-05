import { describe, expect, it } from 'vitest';
import { isFilenameListFavourite, joinFilenameStems, photoFilenameStem, photosForFilenameList } from '../photoFilename';

describe('filename list for a RAW editor search (issue 1733, A3d)', () => {
  it('strips the last extension only, like the admin TXT export', () => {
    expect(photoFilenameStem('IMG_0001.JPG')).toBe('IMG_0001');
    expect(photoFilenameStem('DSC_0042.edit.jpg')).toBe('DSC_0042.edit');
    expect(photoFilenameStem('noext')).toBe('noext');
    expect(photoFilenameStem('.hidden')).toBe('.hidden');
    expect(photoFilenameStem('trailing.')).toBe('trailing');
  });

  it('uses the camera name when known, else the stored one', () => {
    const photos = [
      { filename: 'a1b2-render.jpg', original_filename: 'IMG_0009.JPG' },
      { filename: 'c3d4.jpg', original_filename: null },
    ];
    expect(joinFilenameStems(photos, 'comma')).toBe('IMG_0009,c3d4');
  });

  it('ignores a selection that is no longer in selection mode', () => {
    // Cancel only flips the mode flag; the set survives for re-entry.
    const photos = [{ id: 1, favorite_count: 1 }, { id: 2, favorite_count: 0 }];
    const selected = new Set([2]);
    const isFav = (p: { favorite_count: number }) => p.favorite_count > 0;
    expect(photosForFilenameList(photos, selected, isFav, true))
      .toEqual({ photos: [photos[1]], source: 'selection' });
    expect(photosForFilenameList(photos, selected, isFav, false))
      .toEqual({ photos: [photos[0]], source: 'favorites' });
  });

  it('counts likes as favourites where the layout\'s favourite control writes likes', () => {
    // Premium / Story persist `like` and seed from is_liked; the standard
    // layouts read `favorite` (own rows in identity mode, aggregate otherwise).
    const liked = { id: 1, favorite_count: 0, is_liked: true };
    const faved = { id: 2, favorite_count: 3, is_liked: false };
    const neither = { id: 3, favorite_count: 0, is_liked: false };
    const sets = { myLiked: new Set([3]), myFavorited: new Set([3]) };
    const standard = { likeBacked: false, guestIdentity: false, ...sets };
    const story = { likeBacked: true, guestIdentity: false, ...sets };
    expect([liked, faved, neither].filter((p) => isFilenameListFavourite(p, standard)).map((p) => p.id)).toEqual([2]);
    expect([liked, faved, neither].filter((p) => isFilenameListFavourite(p, story)).map((p) => p.id)).toEqual([1, 3]);
    expect([liked, faved, neither].filter((p) => isFilenameListFavourite(p, { ...standard, guestIdentity: true })).map((p) => p.id)).toEqual([3]);
  });

  it('offers no favourites until the feedback settings have loaded successfully', () => {
    // Pending, or the error fallback without identity_mode: the identity
    // mode is unknown, and the aggregate fallback would list other guests'
    // favourites in a guest-identity gallery. GalleryView derives the flag
    // from `settings?.identity_mode !== undefined`.
    const resolvedFrom = (settings?: { identity_mode?: string }) => settings?.identity_mode !== undefined;
    expect(resolvedFrom(undefined)).toBe(false);
    expect(resolvedFrom({})).toBe(false); // error fallback { feedback_enabled: false }
    expect(resolvedFrom({ identity_mode: 'guest' })).toBe(true);

    const photo = { id: 1, favorite_count: 5, is_liked: true };
    const sets = { myLiked: new Set([1]), myFavorited: new Set([1]) };
    expect(isFilenameListFavourite(photo, { likeBacked: false, guestIdentity: false, ...sets, settingsResolved: false })).toBe(false);
    expect(isFilenameListFavourite(photo, { likeBacked: true, guestIdentity: true, ...sets, settingsResolved: false })).toBe(false);
    expect(isFilenameListFavourite(photo, { likeBacked: false, guestIdentity: false, ...sets, settingsResolved: true })).toBe(true);
  });

  it('joins with a bare comma or a space, ordered by stored filename', () => {
    const photos = [
      { filename: 'b.jpg', original_filename: 'IMG_2.JPG' },
      { filename: 'a.jpg', original_filename: 'IMG_1.JPG' },
    ];
    expect(joinFilenameStems(photos, 'comma')).toBe('IMG_1,IMG_2');
    expect(joinFilenameStems(photos, 'space')).toBe('IMG_1 IMG_2');
    expect(joinFilenameStems([], 'comma')).toBe('');
  });

  it('lists the selection, or the favourites when nothing is selected', () => {
    const photos = [
      { id: 1, favorite_count: 1 },
      { id: 2, favorite_count: 0 },
      { id: 3, favorite_count: 2 },
    ];
    const isFavorited = (p: { favorite_count: number }) => p.favorite_count > 0;

    const selected = photosForFilenameList(photos, new Set([2]), isFavorited);
    expect(selected.source).toBe('selection');
    expect(selected.photos.map((p) => p.id)).toEqual([2]);

    const favourites = photosForFilenameList(photos, new Set(), isFavorited);
    expect(favourites.source).toBe('favorites');
    expect(favourites.photos.map((p) => p.id)).toEqual([1, 3]);
  });
});

describe('joinFilenameStems prefers the ingest-time camera name', () => {
  it('uses source_filename over an original_filename overwritten by a render', () => {
    const photos = [
      { filename: 'a.jpg', original_filename: 'render-edit.jpg', source_filename: 'DSC_0001.NEF' },
      { filename: 'b.jpg', original_filename: 'IMG_0002.JPG', source_filename: null },
      { filename: 'c.jpg', original_filename: null },
    ];
    expect(joinFilenameStems(photos, 'comma')).toBe('DSC_0001,IMG_0002,c');
  });
});
