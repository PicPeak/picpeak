import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useGalleryFiltering, type GalleryFilterOptions } from '../useGalleryFiltering';
import type { Photo } from '../../../../types';

function makePhoto(id: number, originalFilename: string | null, capturedAt: string, filename = `stored-${id}.jpg`): Photo {
  return {
    id,
    filename,
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

  it('takes the stored name where no original name is kept, as external imports store it', () => {
    const external: Photo[] = [
      makePhoto(1, null, burst, 'IMG_0003.jpg'),
      makePhoto(2, 'IMG_0002.jpg', burst),
      makePhoto(3, null, burst, 'IMG_0001.jpg'),
    ];
    const { result } = renderHook(() => useGalleryFiltering({ ...baseOptions, sourcePhotos: external }));
    expect(result.current.map((p) => p.id)).toEqual([3, 2, 1]);
  });

  it('compares names the way the database does: plain, case-sensitive, not numeric', () => {
    // SQLite's BINARY collation and the postgres:15-alpine image order by
    // code point, so the server and the browser must agree on this.
    const unpadded: Photo[] = [
      makePhoto(1, 'IMG_9.jpg', burst),
      makePhoto(2, 'IMG_10.jpg', burst),
      makePhoto(3, 'img_2.jpg', burst),
      makePhoto(4, 'IMG_3.jpg', burst),
    ];
    const { result } = renderHook(() => useGalleryFiltering({ ...baseOptions, sourcePhotos: unpadded }));
    expect(result.current.map((p) => p.original_filename)).toEqual(['IMG_10.jpg', 'IMG_3.jpg', 'IMG_9.jpg', 'img_2.jpg']);
  });

  it('keeps milliseconds apart before the name tie-break', () => {
    const subSecond: Photo[] = [
      makePhoto(1, null, '2026-06-03T10:00:00.900Z', 'A.mp4'),
      makePhoto(2, null, '2026-06-03T10:00:00.100Z', 'Z.mp4'),
    ];
    const { result } = renderHook(() => useGalleryFiltering({ ...baseOptions, sourcePhotos: subSecond }));
    expect(result.current.map((p) => p.filename)).toEqual(['Z.mp4', 'A.mp4']);
  });
});
