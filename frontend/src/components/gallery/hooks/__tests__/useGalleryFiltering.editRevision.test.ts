import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useGalleryFiltering, type GalleryFilterOptions } from '../useGalleryFiltering';
import type { Photo } from '../../../../types';

// Issue 2619: the full-size URL rewritten for a watermarked gallery keeps the
// applied edit revision the listing put on it, so no copy cached before the
// edit landed is reused.
const photo = (id: number, url: string) => ({
  id, filename: `p${id}.jpg`, original_filename: `p${id}.jpg`, url, thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
  type: 'individual', media_type: 'image', mime_type: 'image/jpeg', size: 1, uploaded_at: '2026-08-01T12:00:00Z',
}) as unknown as Photo;

const base: GalleryFilterOptions = {
  sourcePhotos: [photo(1, '/api/gallery/x/photo/1?e=3&fp=40-50'), photo(2, '/api/gallery/x/photo/2')],
  folderId: null, selectedCategoryId: null, searchTerm: '', sortBy: 'date', sortDesc: true, watermarkEnabled: true, slug: 'x',
  activeFilters: [], activeColorFilters: [], mediaFilter: 'all', isGuestIdentityMode: false,
  myFeedbackPhotoIds: { liked: new Set(), favorited: new Set(), rated: new Set(), commented: new Set() },
  selectedPersonIds: [], peopleMatchAny: false,
};

describe('useGalleryFiltering with a watermark', () => {
  it('keeps the edit revision on the rewritten full-size URL', () => {
    const urls = Object.fromEntries(renderHook(() => useGalleryFiltering(base)).result.current.map((p) => [p.id, p.url]));
    expect(urls[1]).toBe('/api/gallery/x/photo/1?e=3');
    expect(urls[2]).toBe('/api/gallery/x/photo/2');
  });
});
