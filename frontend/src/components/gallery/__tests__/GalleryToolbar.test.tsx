/**
 * The gallery toolbar (issue 1733, E8): one sticky bar whose actions swap from
 * browsing (search, filters, sort, select) to the batch actions as soon as
 * selection mode is on or anything is selected.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: unknown, opts?: Record<string, unknown>) => {
        const values = typeof fallback === 'object' ? (fallback as Record<string, unknown>) : opts;
        const count = values?.count;
        return count === undefined ? key : `${key}:${count}`;
      },
      i18n: { language: 'en' },
    }),
  };
});
vi.mock('../BulkRating', () => ({
  BulkRating: ({ photoIds }: { photoIds: number[] }) => <div data-testid="bulk-rating">{photoIds.join(',')}</div>,
}));
vi.mock('../DownloadQuotaNotice', () => ({ DownloadQuotaNotice: () => null }));
vi.mock('../GallerySidebarSelectionTray', () => ({
  GallerySidebarSelectionTray: ({ photos }: { photos: Array<{ id: number }> }) => (
    <ul data-testid="tray">{photos.map((p) => <li key={p.id}>{p.id}</li>)}</ul>
  ),
}));

import { GalleryToolbar, type GalleryToolbarSelection } from '../GalleryToolbar';

const selection = (overrides: Partial<GalleryToolbarSelection> = {}): GalleryToolbarSelection => ({
  available: true,
  hasVideos: false,
  isSelectionMode: false,
  selectedCount: 0,
  visibleCount: 12,
  onStart: vi.fn(),
  onCancel: vi.fn(),
  onSelectAll: vi.fn(),
  onDeselectAll: vi.fn(),
  ...overrides,
});

const search = { value: '', onChange: vi.fn() };
const sort = { sortBy: 'date' as const, onSortChange: vi.fn() };

describe('GalleryToolbar', () => {
  it('is sticky, under the safe area, and out of scroll anchoring', () => {
    render(<GalleryToolbar search={search} selection={selection()} />);
    const bar = screen.getByTestId('gallery-toolbar');
    expect(bar.className).toContain('sticky');
    expect(bar.style.top).toContain('env(safe-area-inset-top');
    expect(bar.style.overflowAnchor).toBe('none');
  });

  it('shows the browse actions while nothing is selected', () => {
    const start = vi.fn();
    render(<GalleryToolbar search={search} sort={sort} selection={selection({ onStart: start })} />);
    expect(screen.getByTestId('gallery-toolbar')).toHaveAttribute('data-mode', 'browse');
    expect(screen.getByRole('textbox', { name: 'gallery.searchPhotos' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'gallery.sortByDate' })).toBeInTheDocument();
    expect(screen.queryByText('gallery.photosSelected:0')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'gallery.selectPhotos' }));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('swaps to the selection actions once a photo is selected, even outside selection mode', () => {
    const download = vi.fn();
    render(
      <GalleryToolbar
        search={search}
        sort={sort}
        selection={selection({
          selectedCount: 2,
          download: { onClick: download },
          bulkRating: { slug: 'g', photoIds: [1, 2] },
          tray: { photos: [{ id: 1, filename: 'a.jpg' }, { id: 2, filename: 'b.jpg' }] as never, onRemove: vi.fn() },
        })}
        copyFilenames={{ count: 2, onClick: vi.fn() }}
      />,
    );
    expect(screen.getByTestId('gallery-toolbar')).toHaveAttribute('data-mode', 'selection');
    // The browse face is gone, not hidden next to it.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'gallery.sortByDate' })).toBeNull();
    expect(screen.getByText('gallery.photosSelected:2')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-rating')).toHaveTextContent('1,2');
    expect(screen.getByRole('button', { name: 'gallery.copyFilenames.button (2)' })).toBeInTheDocument();
    fireEvent.click(screen.getByText('gallery.downloadSelected:2'));
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('offers select all over what is on screen, deselect and cancel in selection mode', () => {
    const sel = selection({ isSelectionMode: true, selectedCount: 0, visibleCount: 5 });
    render(<GalleryToolbar search={search} selection={sel} />);
    expect(screen.getByText('gallery.photosSelected:0')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'gallery.selectAll (5)' }));
    expect(sel.onSelectAll).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'gallery.deselectAll' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'gallery.cancelSelection' }));
    expect(sel.onCancel).toHaveBeenCalledTimes(1);
  });

  it('opens the filter panel, closes it on Escape and hands focus back', () => {
    render(
      <GalleryToolbar
        search={search}
        filters={{ activeCount: 0, render: () => <p>panel body</p> }}
        selection={selection()}
      />,
    );
    const button = screen.getByRole('button', { name: 'gallery.filters' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog', { name: 'gallery.filters' })).toHaveTextContent('panel body');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button).toHaveFocus();
  });

  it('closes the filter panel on a press outside it', () => {
    render(
      <div>
        <p>outside</p>
        <GalleryToolbar search={search} filters={{ activeCount: 0, render: () => <p>panel body</p> }} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'gallery.filters' }));
    fireEvent.pointerDown(screen.getByText('panel body'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByText('outside'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('names the active filter count on the filter button', () => {
    render(<GalleryToolbar search={search} filters={{ activeCount: 2, render: () => null }} />);
    expect(screen.getByRole('button', { name: 'gallery.filters, gallery.filterPanel.activeCount:2' })).toBeInTheDocument();
  });

  it('closes the filter panel when the panel selects, and the bar swaps', () => {
    const Harness = () => {
      const [selected, setSelected] = React.useState(0);
      return (
        <GalleryToolbar
          search={search}
          filters={{
            activeCount: 1,
            render: (close) => (
              <button type="button" onClick={() => { setSelected(4); close(); }}>select these</button>
            ),
          }}
          selection={selection({ selectedCount: selected, isSelectionMode: selected > 0 })}
        />
      );
    };
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'gallery.filters, gallery.filterPanel.activeCount:1' }));
    fireEvent.click(screen.getByRole('button', { name: 'select these' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('gallery-toolbar')).toHaveAttribute('data-mode', 'selection');
    expect(screen.getByText('gallery.photosSelected:4')).toBeInTheDocument();
  });

  it('opens the selection list from the selection face', () => {
    render(
      <GalleryToolbar
        selection={selection({
          isSelectionMode: true,
          selectedCount: 1,
          tray: { photos: [{ id: 9, filename: 'x.jpg' }] as never, onRemove: vi.fn() },
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'gallery.selectionTray.title:1' }));
    expect(screen.getByTestId('tray')).toHaveTextContent('9');
  });

  it('does not reopen the selection list by itself once it emptied', () => {
    const withTray = (ids: number[]) => (
      <GalleryToolbar
        selection={selection({
          isSelectionMode: true,
          selectedCount: ids.length,
          tray: { photos: ids.map((id) => ({ id, filename: `${id}.jpg` })) as never, onRemove: vi.fn() },
        })}
      />
    );
    const { rerender } = render(withTray([9]));
    fireEvent.click(screen.getByRole('button', { name: 'gallery.selectionTray.title:1' }));
    expect(screen.getByTestId('tray')).toBeInTheDocument();
    rerender(withTray([]));
    expect(screen.queryByTestId('tray')).toBeNull();
    expect(screen.getByRole('button', { name: 'gallery.cancelSelection' })).toHaveFocus();
    rerender(withTray([4]));
    expect(screen.queryByTestId('tray')).toBeNull();
  });

  it('has no Select button where picking is not offered', () => {
    render(<GalleryToolbar search={search} selection={selection({ available: false })} />);
    expect(screen.queryByRole('button', { name: 'gallery.selectPhotos' })).toBeNull();
  });
});
