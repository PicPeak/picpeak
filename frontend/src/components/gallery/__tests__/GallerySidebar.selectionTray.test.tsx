/**
 * Selection tray in the sidebar (issue 1733, A3e): the selected photos listed
 * with a remove button each. The harness owns the selection the way
 * GalleryView does, so the assertions are on the selected id set.
 */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GallerySidebar } from '../GallerySidebar';
import { GallerySidebarSelectionTray } from '../GallerySidebarSelectionTray';
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

const Harness: React.FC<{ onSelection: (ids: number[]) => void; allowDownloads?: boolean }> = ({ onSelection, allowDownloads = true }) => {
  const [started, setStarted] = React.useState(false);
  const { isSelectionMode, setIsSelectionMode, selectedPhotos, setSelectedPhotos } = useGallerySelection(photos);
  onSelection([...selectedPhotos].sort((a, b) => a - b));
  // A gallery with downloads off has no selection controls in the sidebar;
  // selection is entered from the grid toolbar, which this stands in for.
  if (!allowDownloads && !started) {
    setStarted(true);
    setIsSelectionMode(true);
    setSelectedPhotos(new Set(photos.map((p) => p.id)));
  }
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
      allowDownloads={allowDownloads}
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

  // Removing a row unmounts the focused button; without a hand-over focus
  // lands on <body> and a keyboard user starts again from the top of the page.
  it('keeps keyboard focus in the tray after a removal', () => {
    render(<Harness onSelection={() => {}} />);
    selectAll();
    const removeButton = (id: number) => screen.getByRole('button', { name: `Remove IMG_${id}.jpg from the selection` });

    // A middle row hands focus to the row that moves up into its place.
    removeButton(2).focus();
    fireEvent.click(removeButton(2));
    expect(document.activeElement).toBe(removeButton(3));

    // The last row has nothing after it: the row before takes focus.
    fireEvent.click(removeButton(3));
    expect(document.activeElement).toBe(removeButton(1));

    // The tray empties and unmounts: focus goes to the selection toggle.
    fireEvent.click(removeButton(1));
    expect(screen.queryByRole('list')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'gallery.cancelSelection' }));
  });

  it('falls back to the close button when the sidebar has no selection toggle', () => {
    render(<Harness onSelection={() => {}} allowDownloads={false} />);
    for (const id of [1, 2, 3]) {
      const button = screen.getByRole('button', { name: `Remove IMG_${id}.jpg from the selection` });
      button.focus();
      fireEvent.click(button);
    }
    expect(screen.queryByRole('list')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'common.close' }));
  });

  it('leaves focus alone when the removed button did not hold it', () => {
    render(<Harness onSelection={() => {}} />);
    selectAll();
    const toggle = screen.getByRole('button', { name: 'Selected (3)' });
    toggle.focus();
    fireEvent.click(screen.getByRole('button', { name: 'Remove IMG_2.jpg from the selection' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Selected (2)' }));
  });

  it('picks the focus target from the list as it is after the removal', () => {
    const onEmptied = vi.fn();
    const tray = (list: Photo[]) => (
      <GallerySidebarSelectionTray photos={list} onRemove={() => {}} onEmptied={onEmptied} />
    );
    const removeButton = (id: number) => screen.getByRole('button', { name: `Remove IMG_${id}.jpg from the selection` });
    const { rerender } = render(tray(photos));

    // A removal that did not happen moves nothing, even on a fresh array.
    removeButton(2).focus();
    fireEvent.click(removeButton(2));
    rerender(tray([...photos]));
    expect(document.activeElement).toBe(removeButton(2));

    // The neighbour went in the same update: the surviving row takes focus.
    fireEvent.click(removeButton(2));
    rerender(tray([photos[0]]));
    expect(document.activeElement).toBe(removeButton(1));
    expect(onEmptied).not.toHaveBeenCalled();
  });
});
