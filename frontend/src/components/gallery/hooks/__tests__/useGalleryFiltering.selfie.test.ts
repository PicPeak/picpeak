/**
 * Selfie search filter (issue 2355): the photo ids the server matched narrow
 * the list and AND with every other filter; null leaves it alone and an
 * empty list empties it.
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useGalleryFiltering, type GalleryFilterOptions } from '../useGalleryFiltering';
import type { Photo } from '../../../../types';

const makePhoto = (id: number, fields: Partial<Photo> = {}): Photo => ({
  id, filename: `IMG_${id}.jpg`, url: `/api/gallery/x/photo/${id}`, type: 'individual', size: 1,
  uploaded_at: `2026-01-0${id}T00:00:00Z`, ...fields,
} as Photo);

const baseOptions: GalleryFilterOptions = {
  sourcePhotos: [
    makePhoto(1, { person_ids: [10], category_id: 7 }),
    makePhoto(2, { person_ids: [], category_id: 7 }),
    makePhoto(3, { person_ids: [10], category_id: 8 }),
    makePhoto(4, { person_ids: [], category_id: 7 }),
  ],
  folderId: null, selectedCategoryId: null, searchTerm: '', sortBy: 'name', sortDesc: false,
  watermarkEnabled: false, slug: 'x', activeFilters: [], activeColorFilters: [], mediaFilter: 'all',
  isGuestIdentityMode: true,
  myFeedbackPhotoIds: { liked: new Set(), favorited: new Set(), rated: new Set(), commented: new Set() },
  selectedPersonIds: [], peopleMatchAny: false,
};

const idsFor = (options: Partial<GalleryFilterOptions>) =>
  renderHook(() => useGalleryFiltering({ ...baseOptions, ...options })).result.current.map((p) => p.id);

describe('useGalleryFiltering selfie search (issue 2355)', () => {
  it('leaves the list alone without a selfie result', () => {
    expect(idsFor({})).toEqual([1, 2, 3, 4]);
    expect(idsFor({ selfiePhotoIds: null })).toEqual([1, 2, 3, 4]);
  });

  it('keeps the matched photos in the gallery order, ignoring ids it does not hold', () => {
    expect(idsFor({ selfiePhotoIds: [4, 2, 99] })).toEqual([2, 4]);
  });

  it('composes with the people and category filters', () => {
    expect(idsFor({ selfiePhotoIds: [1, 2, 3], selectedPersonIds: [10] })).toEqual([1, 3]);
    expect(idsFor({ selfiePhotoIds: [1, 2, 3], selectedCategoryId: 7 })).toEqual([1, 2]);
  });

  it('an empty result empties the list', () => {
    expect(idsFor({ selfiePhotoIds: [] })).toEqual([]);
  });
});
