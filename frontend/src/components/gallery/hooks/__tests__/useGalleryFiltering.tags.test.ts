/**
 * Scene-tag filter (issue 1733): several tags are OR-combined, and the
 * result ANDs with every other filter. "Select filtered" selects exactly
 * the list this hook returns, so the composition is pinned here.
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useGalleryFiltering, type GalleryFilterOptions } from '../useGalleryFiltering';
import type { Photo } from '../../../../types';

function makePhoto(id: number, fields: Partial<Photo>): Photo {
  return {
    id,
    filename: `IMG_${id}.jpg`,
    url: `/api/gallery/x/photo/${id}`,
    type: 'individual',
    size: 1,
    uploaded_at: `2026-01-0${id}T00:00:00Z`,
    ...fields,
  } as Photo;
}

const photos: Photo[] = [
  makePhoto(1, { tag_keys: ['cake', 'food'], category_id: 7, my_rating: 5 }),
  makePhoto(2, { tag_keys: ['dancing'], category_id: 7, my_rating: 2 }),
  makePhoto(3, { tag_keys: ['cake'], category_id: 8, my_rating: 4 }),
  makePhoto(4, { tag_keys: [], category_id: 7, my_rating: 5 }),
  // Tagging off for the gallery, or a photo from an older payload.
  makePhoto(5, { category_id: 7 }),
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
  myFeedbackPhotoIds: { liked: new Set(), favorited: new Set(), rated: new Set(), commented: new Set() },
  selectedPersonIds: [],
  peopleMatchAny: false,
};

const idsFor = (options: Partial<GalleryFilterOptions>) =>
  renderHook(() => useGalleryFiltering({ ...baseOptions, ...options })).result.current.map((p) => p.id);

describe('useGalleryFiltering tags (issue 1733)', () => {
  it('leaves the list alone with no tag selected', () => {
    expect(idsFor({})).toEqual([1, 2, 3, 4, 5]);
    expect(idsFor({ selectedTagKeys: [] })).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps the photos that carry the selected tag', () => {
    expect(idsFor({ selectedTagKeys: ['cake'] })).toEqual([1, 3]);
  });

  it('combines several tags with OR', () => {
    expect(idsFor({ selectedTagKeys: ['cake', 'dancing'] })).toEqual([1, 2, 3]);
    // AND would have been empty: no photo is both.
    expect(idsFor({ selectedTagKeys: ['food', 'dancing'] })).toEqual([1, 2]);
  });

  it('composes with the other filters', () => {
    expect(idsFor({ selectedTagKeys: ['cake', 'dancing'], selectedCategoryId: 7 })).toEqual([1, 2]);
    expect(idsFor({ selectedTagKeys: ['cake', 'dancing'], minRating: 4 })).toEqual([1, 3]);
    expect(idsFor({ selectedTagKeys: ['cake', 'dancing'], selectedCategoryId: 7, minRating: 4 })).toEqual([1]);
    expect(idsFor({ selectedTagKeys: ['cake'], searchTerm: 'IMG_3' })).toEqual([3]);
  });

  it('a tag no photo carries empties the list rather than being ignored', () => {
    expect(idsFor({ selectedTagKeys: ['fireworks'] })).toEqual([]);
  });
});
