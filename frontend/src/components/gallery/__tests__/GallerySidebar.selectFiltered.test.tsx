/**
 * "Select all" in the sidebar selects what the active filters leave on screen
 * (issue 1733, A3c). The harness wires the sidebar to the filtering and
 * selection hooks the way GalleryView does, so the assertion is on the
 * selected id set, not on a callback having fired.
 */
import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GallerySidebar } from '../GallerySidebar';
import { useGalleryFiltering } from '../hooks/useGalleryFiltering';
import { useGallerySelection } from '../hooks/useGallerySelection';
import type { Photo } from '../../../types';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: unknown, opts?: Record<string, unknown>) => {
        const vars = (typeof fallback === 'object' && fallback ? fallback : opts) as Record<string, unknown> | undefined;
        const text = typeof fallback === 'string' ? fallback : key;
        return text.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars?.[k] ?? ''));
      },
      i18n: { language: 'en' }
    })
  };
});

function makePhoto(id: number, myRating: number | null): Photo {
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

const photos = [makePhoto(1, null), makePhoto(2, 2), makePhoto(3, 4), makePhoto(4, 5)];

const Harness: React.FC<{ onSelection: (ids: number[]) => void }> = ({ onSelection }) => {
  const [minRating, setMinRating] = useState<number | null>(null);
  const { isSelectionMode, setIsSelectionMode, selectedPhotos, setSelectedPhotos } = useGallerySelection(photos);
  const filteredPhotos = useGalleryFiltering({
    sourcePhotos: photos,
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
    minRating,
  });
  onSelection([...selectedPhotos].sort((a, b) => a - b));
  return (
    <GallerySidebar
      isOpen
      onClose={() => {}}
      categories={[]}
      selectedCategoryId={null}
      onCategoryChange={() => {}}
      searchTerm=""
      onSearchChange={() => {}}
      sortBy="date"
      onSortChange={() => {}}
      isSelectionMode={isSelectionMode}
      onToggleSelectionMode={() => setIsSelectionMode(!isSelectionMode)}
      selectedCount={selectedPhotos.size}
      onSelectAll={() => setSelectedPhotos(new Set(filteredPhotos.map((p) => p.id)))}
      onDeselectAll={() => setSelectedPhotos(new Set())}
      visibleCount={filteredPhotos.length}
      onDownloadAll={() => {}}
      onDownloadSelected={() => {}}
      isDownloading={false}
      allowDownloads
      totalPhotos={photos.length}
      isMobile={false}
      feedbackEnabled
      activeFilters={[]}
      onFilterChange={() => {}}
      ratingsEnabled
      minRating={minRating}
      onMinRatingChange={setMinRating}
      minRatingCounts={{ 1: 3, 2: 3, 3: 2, 4: 2, 5: 1 }}
    />
  );
};

describe('GallerySidebar select filtered (issue 1733)', () => {
  it('selects exactly the photos the rating filter leaves visible, then clears', () => {
    let selected: number[] = [];
    render(<Harness onSelection={(ids) => { selected = ids; }} />);

    // No Select All outside selection mode; the toggle is the way in.
    expect(screen.queryByText(/^gallery.selectAll/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'My rating: 3 stars or more' }));
    fireEvent.click(screen.getByText('Select Photos'));

    const selectAll = screen.getByRole('button', { name: 'gallery.selectAll (2)' });
    fireEvent.click(selectAll);
    expect(selected).toEqual([3, 4]);

    // Lowering the threshold does not grow the selection by itself …
    fireEvent.click(screen.getByRole('button', { name: 'My rating: 2 stars or more' }));
    expect(selected).toEqual([3, 4]);
    // … Select All over the wider set does.
    fireEvent.click(screen.getByRole('button', { name: 'gallery.selectAll (3)' }));
    expect(selected).toEqual([2, 3, 4]);

    fireEvent.click(screen.getByRole('button', { name: 'gallery.deselectAll' }));
    expect(selected).toEqual([]);
  });

  it('selects every photo when no filter is active', () => {
    let selected: number[] = [];
    render(<Harness onSelection={(ids) => { selected = ids; }} />);
    fireEvent.click(screen.getByText('Select Photos'));
    fireEvent.click(screen.getByRole('button', { name: 'gallery.selectAll (4)' }));
    expect(selected).toEqual([1, 2, 3, 4]);
  });
});
