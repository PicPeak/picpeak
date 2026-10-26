import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useGalleryFiltering, type GalleryFilterOptions, type GallerySort } from '../useGalleryFiltering';
import type { Photo } from '../../../../types';

// Issue 2263: videos first is the primary order, the chosen sort within.
function media(id: number, filename: string, kind: 'photo' | 'video', day: number, extra: Partial<Photo> = {}): Photo {
  return {
    id,
    filename,
    original_filename: filename,
    url: `/api/gallery/x/photo/${id}`,
    thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
    type: 'individual',
    media_type: kind === 'video' ? 'video' : 'image',
    mime_type: kind === 'video' ? 'video/mp4' : 'image/jpeg',
    size: id * 100,
    uploaded_at: `2026-08-0${day}T12:00:00Z`,
    ...extra,
  } as Photo;
}

const PHOTOS: Photo[] = [
  media(1, 'c_photo.jpg', 'photo', 1, { captured_at: '2026-07-03T00:00:00Z', category_id: 7 } as Partial<Photo>),
  // No capture date: the capture sort falls back to the upload date.
  media(2, 'a_video.mp4', 'video', 2, { category_id: 7 } as Partial<Photo>),
  media(3, 'e_photo.jpg', 'photo', 3, { captured_at: '2026-07-01T00:00:00Z' } as Partial<Photo>),
  // A video recognised by its MIME type alone.
  media(4, 'd_video.mov', 'photo', 4, { mime_type: 'video/quicktime', captured_at: '2026-07-05T00:00:00Z' } as Partial<Photo>),
  media(5, 'b_photo.jpg', 'photo', 5, { captured_at: '2026-07-04T00:00:00Z', category_id: 7 } as Partial<Photo>),
];

const base: GalleryFilterOptions = {
  sourcePhotos: PHOTOS,
  folderId: null,
  selectedCategoryId: null,
  searchTerm: '',
  sortBy: 'date',
  sortDesc: true,
  watermarkEnabled: false,
  slug: 'x',
  activeFilters: [],
  activeColorFilters: [],
  mediaFilter: 'all',
  isGuestIdentityMode: false,
  myFeedbackPhotoIds: { liked: new Set(), favorited: new Set(), rated: new Set(), commented: new Set() },
  selectedPersonIds: [],
  peopleMatchAny: false,
};

const order = (options: Partial<GalleryFilterOptions>) =>
  renderHook(() => useGalleryFiltering({ ...base, ...options })).result.current.map((p) => p.id);
const isVideo = (id: number) => id === 2 || id === 4;

describe('useGalleryFiltering videos first', () => {
  const sorts: Array<[GallerySort, boolean]> = [
    ['date', true], ['date', false], ['capture_date', true], ['capture_date', false],
    ['name', false], ['name', true], ['size', true], ['rating', true],
  ];

  it.each(sorts)('puts videos first and keeps the %s sort (desc=%s) inside each group', (sortBy, sortDesc) => {
    const plain = order({ sortBy, sortDesc });
    const first = order({ sortBy, sortDesc, videosFirst: true });
    expect(first).toEqual([...plain.filter(isVideo), ...plain.filter((id) => !isVideo(id))]);
  });

  it('orders by capture date within each group, falling back to the upload date', () => {
    // Video 2 has no capture date and sorts by its upload (Aug 2), after
    // video 4 taken on Jul 5.
    expect(order({ sortBy: 'capture_date', sortDesc: false, videosFirst: true })).toEqual([4, 2, 3, 1, 5]);
    expect(order({ sortBy: 'capture_date', sortDesc: true, videosFirst: true })).toEqual([2, 4, 5, 1, 3]);
  });

  it('orders by filename within each group', () => {
    expect(order({ sortBy: 'name', sortDesc: false, videosFirst: true })).toEqual([2, 4, 5, 1, 3]);
  });

  it('leaves the order alone when off', () => {
    expect(order({ sortBy: 'date', sortDesc: true })).toEqual([5, 4, 3, 2, 1]);
    expect(order({ sortBy: 'name', sortDesc: false })).toEqual([2, 5, 1, 4, 3]);
    expect(order({ sortBy: 'date', sortDesc: true, videosFirst: false })).toEqual([5, 4, 3, 2, 1]);
  });

  it('applies inside a selected category', () => {
    expect(order({ sortBy: 'name', sortDesc: false, selectedCategoryId: 7, videosFirst: true })).toEqual([2, 5, 1]);
    expect(order({ sortBy: 'date', sortDesc: true, selectedCategoryId: 7, videosFirst: true })).toEqual([2, 5, 1]);
    expect(order({ sortBy: 'date', sortDesc: true, selectedCategoryId: 7 })).toEqual([5, 2, 1]);
  });
});
