/**
 * Minimum own-rating filter (issue 1733, A3c): `minRating` keeps only photos
 * whose `my_rating` reaches the threshold and ANDs with the feedback chips.
 */
import fs from 'node:fs';
import path from 'node:path';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useGalleryFiltering, type GalleryFilterOptions } from '../useGalleryFiltering';
import type { Photo } from '../../../../types';

function makePhoto(id: number, myRating: number | null | undefined): Photo {
  return {
    id,
    filename: `IMG_${id}.jpg`,
    url: `/api/gallery/x/photo/${id}`,
    thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
    type: 'individual',
    size: 1,
    uploaded_at: `2026-01-0${id}T00:00:00Z`,
    my_rating: myRating,
  } as Photo;
}

// 0, null, missing, 2 and 4 stars — only the 4 clears a threshold of 3.
const photos: Photo[] = [
  makePhoto(1, 0),
  makePhoto(2, null),
  makePhoto(3, undefined),
  makePhoto(4, 2),
  makePhoto(5, 4),
];

const baseOptions: GalleryFilterOptions = {
  sourcePhotos: photos,
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
  isGuestIdentityMode: true,
  myFeedbackPhotoIds: {
    liked: new Set(),
    favorited: new Set([4, 5]),
    rated: new Set(),
    commented: new Set(),
  },
  selectedPersonIds: [],
  peopleMatchAny: false,
};

describe('useGalleryFiltering minRating (issue 1733)', () => {
  it('keeps only photos the viewer rated at or above the threshold', () => {
    const { result } = renderHook(() => useGalleryFiltering({ ...baseOptions, minRating: 3 }));
    expect(result.current.map((p) => p.id)).toEqual([5]);
  });

  it('treats the threshold as inclusive', () => {
    const { result } = renderHook(() => useGalleryFiltering({ ...baseOptions, minRating: 2 }));
    expect(result.current.map((p) => p.id)).toEqual([4, 5]);
  });

  it('is off when null or omitted', () => {
    const { result: omitted } = renderHook(() => useGalleryFiltering(baseOptions));
    expect(omitted.current).toHaveLength(5);
    const { result: nulled } = renderHook(() => useGalleryFiltering({ ...baseOptions, minRating: null }));
    expect(nulled.current).toHaveLength(5);
  });

  it('ANDs with the favourites filter: saved photos rated 3+ only', () => {
    // Saved = {4, 5}; 3+ = {5}; a 3-star photo that is not saved stays out.
    const withUnsaved = [...photos, makePhoto(6, 3)];
    const { result } = renderHook(() => useGalleryFiltering({
      ...baseOptions,
      sourcePhotos: withUnsaved,
      activeFilters: ['favorited'],
      minRating: 3,
    }));
    expect(result.current.map((p) => p.id)).toEqual([5]);
  });

  it('yields an empty list rather than falling back when nothing reaches the threshold', () => {
    const { result } = renderHook(() => useGalleryFiltering({ ...baseOptions, minRating: 5 }));
    expect(result.current).toEqual([]);
  });
});

describe('GalleryView hands the threshold to the hook only while ratings are reachable', () => {
  // The chips hide with feedbackEnabled; the master switch leaves
  // allow_ratings as it was, so gating on allow_ratings alone kept a stale
  // threshold emptying the grid with nothing left to clear it.
  it('gates minRating on feedback_enabled and allow_ratings', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../GalleryView.tsx'), 'utf8');
    expect(src).toContain('minRating: feedbackSettings?.feedback_enabled && feedbackSettings?.allow_ratings ? minRating : null');
  });
});
