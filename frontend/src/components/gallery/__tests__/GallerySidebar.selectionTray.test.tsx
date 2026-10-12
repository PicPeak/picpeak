/**
 * Selection tray in the sidebar (issue 1733, A3e): the selected photos listed
 * with a remove button each. The harness owns the selection the way
 * GalleryView does, so the assertions are on the selected id set.
 */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GallerySidebar } from '../GallerySidebar';
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

// Rows 1 and 2 are "in view", row 3 is not: its thumbnail must not be requested.
const mockInView = vi.fn(() => true);
vi.mock('react-intersection-observer', () => ({
  useInView: () => ({ ref: vi.fn(), inView: mockInView() }),
}));

vi.mock('../../common', async () => {
  const actual = await vi.importActual<typeof import('../../common')>('../../common');
  return {
    ...actual,
    AuthenticatedImage: ({ src }: { src: string }) => <img data-testid="tray-thumb" src={src} alt="" />,
  };
});

function makePhoto(id: number): Photo {
  return {
    id,
    filename: `IMG_${id}.jpg`,
    url: `/api/gallery/x/photo/${id}`,
    thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
    type: 'individual',
    size: 1,
    uploaded_at: `2026-01-0${id}T00:00:00Z`,
  } as Photo;
}

const photos = [makePhoto(1), makePhoto(2), makePhoto(3)];

const Harness: React.FC<{ onSelection: (ids: number[]) => void }> = ({ onSelection }) => {
  const { isSelectionMode, setIsSelectionMode, selectedPhotos, setSelectedPhotos } = useGallerySelection(photos);
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
      onSelectAll={() => setSelectedPhotos(new Set(photos.map((p) => p.id)))}
      onDeselectAll={() => setSelectedPhotos(new Set())}
      visibleCount={photos.length}
      onDownloadAll={() => {}}
      onDownloadSelected={() => {}}
      isDownloading={false}
      allowDownloads
      totalPhotos={photos.length}
      isMobile={false}
      selectedPhotoList={photos.filter((p) => selectedPhotos.has(p.id))}
      onDeselectPhoto={(id) => setSelectedPhotos((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      })}
      slug="x"
    />
  );
};

function selectAll() {
  fireEvent.click(screen.getByText('Select Photos'));
  fireEvent.click(screen.getByRole('button', { name: 'gallery.selectAll (3)' }));
}

describe('GallerySidebar selection tray (issue 1733)', () => {
  it('is hidden while nothing is selected', () => {
    render(<Harness onSelection={() => {}} />);
    expect(screen.queryByRole('button', { name: /^Selected \(/ })).toBeNull();
    // Selection mode alone, with an empty selection, shows no tray either.
    fireEvent.click(screen.getByText('Select Photos'));
    expect(screen.queryByRole('button', { name: /^Selected \(/ })).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('lists the selected photos and removes one at a time', () => {
    let selected: number[] = [];
    render(<Harness onSelection={(ids) => { selected = ids; }} />);
    selectAll();

    expect(screen.getByRole('button', { name: 'Selected (3)' })).toBeTruthy();
    const rows = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual(['IMG_1.jpg', 'IMG_2.jpg', 'IMG_3.jpg']);
    expect(screen.getAllByTestId('tray-thumb')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Remove IMG_2.jpg from the selection' }));
    expect(selected).toEqual([1, 3]);
    expect(screen.getByRole('button', { name: 'Selected (2)' })).toBeTruthy();
    expect(screen.queryByText('IMG_2.jpg')).toBeNull();

    // Removing the last ones hides the tray again.
    fireEvent.click(screen.getByRole('button', { name: 'Remove IMG_1.jpg from the selection' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove IMG_3.jpg from the selection' }));
    expect(selected).toEqual([]);
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('collapses, and requests no thumbnail for a row that is off screen', () => {
    mockInView.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false);
    render(<Harness onSelection={() => {}} />);
    selectAll();
    expect(screen.getAllByTestId('tray-thumb')).toHaveLength(2);

    const toggle = screen.getByRole('button', { name: 'Selected (3)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list')).toBeNull();
  });
});
