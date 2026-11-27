import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useGalleryFiltering, type GalleryFilterOptions } from '../useGalleryFiltering';
import type { Photo } from '../../../../types';

function makePhoto(id: number, originalFilename: string | null, capturedAt: string): Photo {
  return {
    id,
    filename: `stored-${id}.jpg`,
    original_filename: originalFilename,
    url: `/api/gallery/x/photo/${id}`,
    thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
    type: 'individual',
    size: 1,
    uploaded_at: '2026-09-01T00:00:00Z',
    captured_at: capturedAt,
  } as Photo;
}

// A same-second burst, ids against the camera counter, as the server sends
// it in upload order (newest first), plus one earlier shot.
const burst = '2026-06-03T13:15:42Z';
const photos: Photo[] = [
  makePhoto(4, 'IMG_0001.jpg', burst),
  makePhoto(3, 'IMG_0001.jpg', burst),
  makePhoto(2, 'IMG_0002.jpg', burst),
  makePhoto(1, 'IMG_0003.jpg', burst),
  makePhoto(5, 'IMG_0099.jpg', '2026-06-03T13:00:00Z'),
];

const baseOptions: GalleryFilterOptions = {
  sourcePhotos: photos,
  folderId: null,
  selectedCategoryId: null,
  searchTerm: '',
  sortBy: 'capture_date',
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

describe('useGalleryFiltering capture-date sort (issue 2617)', () => {
  it('orders a same-second burst by the camera file name, then by id, oldest first', () => {
    const { result } = renderHook(() => useGalleryFiltering(baseOptions));
    expect(result.current.map((p) => p.id)).toEqual([5, 3, 4, 2, 1]);
  });

  it('reverses the whole order newest first', () => {
    const { result } = renderHook(() => useGalleryFiltering({ ...baseOptions, sortDesc: true }));
    expect(result.current.map((p) => p.id)).toEqual([1, 2, 4, 3, 5]);
  });
});
