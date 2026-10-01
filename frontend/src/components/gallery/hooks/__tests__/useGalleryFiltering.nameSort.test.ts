import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useGalleryFiltering, type GalleryFilterOptions } from '../useGalleryFiltering';
import type { Photo } from '../../../../types';

function makePhoto(
  id: number,
  storedFilename: string,
  originalFilename: string | null
): Photo {
  return {
    id,
    filename: storedFilename,
    original_filename: originalFilename,
    url: `/api/gallery/x/photo/${id}`,
    thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
    type: 'individual',
    size: 1,
    uploaded_at: '2026-01-01T00:00:00Z',
  } as Photo;
}

// Stored `filename` lex order must differ from `original_filename` lex order.
const uploadOrderPhotos: Photo[] = [
  makePhoto(1, 'Event_cat_0001_a.jpg', '0V3A9999.jpg'),
  makePhoto(2, 'Event_cat_0003_c.jpg', '0V3A1111.jpg'),
  makePhoto(3, 'Event_cat_0002_b.jpg', '0V3A5555.jpg'),
];

const baseOptions: GalleryFilterOptions = {
  sourcePhotos: uploadOrderPhotos,
  folderId: null,
  selectedCategoryId: null,
  searchTerm: '',
  sortBy: 'name',
  sortDesc: false,
  watermarkEnabled: false,
  slug: 'x',
  activeFilters: [],
  activeColorFilters: [],
  mediaFilter: 'all',
  isGuestIdentityMode: false,
  myFeedbackPhotoIds: {
    liked: new Set(),
    favorited: new Set(),
    rated: new Set(),
    commented: new Set(),
  },
  selectedPersonIds: [],
  peopleMatchAny: false,
};

describe('useGalleryFiltering name sort', () => {
  it('sorts by original_filename ascending when it differs from stored filename order', () => {
    const { result } = renderHook(() => useGalleryFiltering(baseOptions));
    // original: 1111, 5555, 9999 → ids 2, 3, 1 (not filename order 1, 3, 2)
    expect(result.current.map((p) => p.id)).toEqual([2, 3, 1]);
  });

  it('reverses original_filename order when sortDesc is true', () => {
    const { result } = renderHook(() =>
      useGalleryFiltering({ ...baseOptions, sortDesc: true })
    );
    expect(result.current.map((p) => p.id)).toEqual([1, 3, 2]);
  });

  it('falls back to filename when original_filename is null', () => {
    const photos: Photo[] = [
      makePhoto(10, 'beta.jpg', null),
      makePhoto(11, 'alpha.jpg', '0V3A8888.jpg'),
      makePhoto(12, 'gamma.jpg', null),
    ];
    const { result } = renderHook(() =>
      useGalleryFiltering({ ...baseOptions, sourcePhotos: photos })
    );
    // alpha (camera) < beta (stored) < gamma (stored)
    expect(result.current.map((p) => p.id)).toEqual([11, 10, 12]);
  });

  it('orders unpadded camera numbers numerically, not lexicographically', () => {
    const photos: Photo[] = [
      makePhoto(20, 'Event_cat_0001_a.jpg', 'IMG_100.jpg'),
      makePhoto(21, 'Event_cat_0002_b.jpg', 'IMG_9.jpg'),
      makePhoto(22, 'Event_cat_0003_c.jpg', 'IMG_10.jpg'),
    ];
    const { result } = renderHook(() =>
      useGalleryFiltering({ ...baseOptions, sourcePhotos: photos })
    );
    // IMG_9 < IMG_10 < IMG_100 (plain localeCompare gives 10, 100, 9)
    expect(result.current.map((p) => p.id)).toEqual([21, 22, 20]);
  });

  it('search matches original_filename or stored filename', () => {
    const { result } = renderHook(() =>
      useGalleryFiltering({ ...baseOptions, searchTerm: '0v3a9999' })
    );
    expect(result.current.map((p) => p.id)).toEqual([1]);
  });
});
