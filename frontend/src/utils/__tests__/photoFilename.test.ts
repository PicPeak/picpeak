import { describe, expect, it } from 'vitest';
import { joinFilenameStems, photoFilenameStem, photosForFilenameList } from '../photoFilename';

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
