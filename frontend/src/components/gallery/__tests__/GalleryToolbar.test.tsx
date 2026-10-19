/**
 * The gallery toolbar (issue 1733, E8): one sticky bar whose actions swap from
 * browsing (search, filters, sort, select) to the batch actions as soon as
 * selection mode is on or anything is selected.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  BulkRating: ({ photoIds, onDialogChange }: { photoIds: number[]; onDialogChange?: (open: boolean) => void }) => (
    <div data-testid="bulk-rating">
      {photoIds.join(',')}
      <button type="button" onClick={() => onDialogChange?.(true)}>identity open</button>
      <button type="button" onClick={() => onDialogChange?.(false)}>identity closed</button>
    </div>
  ),
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

  it('keeps the filter panel within the screen under the stuck bar', () => {
    render(
      <GalleryToolbar
        search={search}
        filters={{ activeCount: 0, render: () => <p>panel body</p> }}
        selection={selection()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'gallery.filters' }));
    expect(screen.getByRole('dialog').getAttribute('style')).toContain('100dvh');
  });

  it('moves focus across the swap when Select and cancel unmount', () => {
    const face = (isSelectionMode: boolean) => (
      <GalleryToolbar search={search} selection={selection({ isSelectionMode })} />
    );
    const { rerender } = render(face(false));
    screen.getByRole('button', { name: 'gallery.selectPhotos' }).focus();
    rerender(face(true));
    expect(screen.getByRole('button', { name: 'gallery.cancelSelection' })).toHaveFocus();
    rerender(face(false));
    expect(screen.getByRole('button', { name: 'gallery.selectPhotos' })).toHaveFocus();
  });

  it('closes the sort menu when the filter panel opens, and on Escape', () => {
    render(
      <GalleryToolbar
        search={search}
        sort={sort}
        filters={{ activeCount: 0, render: () => <p>panel body</p> }}
        selection={selection()}
      />,
    );
    const sortButton = screen.getByRole('button', { name: 'gallery.sortByDate' });
    fireEvent.click(sortButton);
    expect(screen.getByRole('button', { name: 'photoSort.dateTaken' })).toBeInTheDocument();
    const filterButton = screen.getByRole('button', { name: 'gallery.filters' });
    fireEvent.pointerDown(filterButton);
    fireEvent.click(filterButton);
    expect(screen.queryByRole('button', { name: 'photoSort.dateTaken' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'gallery.filters' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(sortButton);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'photoSort.dateTaken' })).toBeNull();
    expect(sortButton).toHaveFocus();
  });

  it('keeps only one of Sort and Filters open when driven by keyboard', () => {
    render(
      <GalleryToolbar
        search={search}
        sort={sort}
        filters={{ activeCount: 0, render: () => <p>panel body</p> }}
        selection={selection()}
      />,
    );
    const sortButton = screen.getByRole('button', { name: 'gallery.sortByDate' });
    const filterButton = screen.getByRole('button', { name: 'gallery.filters' });
    fireEvent.click(sortButton);
    filterButton.focus();
    fireEvent.click(filterButton);
    expect(screen.queryByRole('button', { name: 'photoSort.dateTaken' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'gallery.filters' })).toBeInTheDocument();
    sortButton.focus();
    fireEvent.click(sortButton);
    expect(screen.getByRole('button', { name: 'photoSort.dateTaken' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('hands focus back to Filters when the panel closes itself under it', () => {
    render(
      <GalleryToolbar
        search={search}
        filters={{ activeCount: 0, render: (close) => <button type="button" onClick={close}>select these</button> }}
        selection={selection({ isSelectionMode: true, selectedCount: 2 })}
      />,
    );
    const filterButton = screen.getByRole('button', { name: 'gallery.filters' });
    fireEvent.click(filterButton);
    const inside = screen.getByRole('button', { name: 'select these' });
    inside.focus();
    fireEvent.click(inside);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(filterButton).toHaveFocus();
  });

  it('leaves an Escape inside something else, like the lightbox, alone', () => {
    render(
      <div>
        <GalleryToolbar
          search={search}
          sort={sort}
          filters={{ activeCount: 0, render: () => <p>panel body</p> }}
          selection={selection()}
        />
        <textarea aria-label="comment" />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'gallery.filters' }));
    const field = screen.getByRole('textbox', { name: 'comment' });
    field.focus();
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'gallery.filters' })).toBeInTheDocument();
    expect(field).toHaveFocus();
  });

  it('lets the sort menu scroll within the room under its button', () => {
    render(<GalleryToolbar search={search} sort={sort} selection={selection()} />);
    fireEvent.click(screen.getByRole('button', { name: 'gallery.sortByDate' }));
    const menu = screen.getByRole('button', { name: 'photoSort.dateTaken' }).parentElement!;
    expect(menu.className).toContain('overflow-y-auto');
    expect(menu.style.maxHeight).toMatch(/px$/);
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

  it('wraps the browse buttons rather than crushing the search box', () => {
    render(<GalleryToolbar search={search} sort={sort} selection={selection()} />);
    const row = screen.getByRole('toolbar', { name: 'gallery.toolbar.browse' });
    expect(row.className).toContain('flex-wrap');
    const box = screen.getByRole('textbox', { name: 'gallery.searchPhotos' });
    expect(box.closest('.min-w-\\[9rem\\]')).not.toBeNull();
    expect(box.closest('.md\\:min-w-\\[14rem\\]')).not.toBeNull();
  });

  it('has no Select button where picking is not offered', () => {
    render(<GalleryToolbar search={search} selection={selection({ available: false })} />);
    expect(screen.queryByRole('button', { name: 'gallery.selectPhotos' })).toBeNull();
  });

  describe('on a phone (E5)', () => {
    beforeEach(() => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === '(max-width: 639px)',
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('keeps browsing in the top bar and puts the batch actions in a bottom bar', () => {
      const download = vi.fn();
      render(
        <GalleryToolbar
          search={search}
          sort={sort}
          selection={selection({
            isSelectionMode: true,
            selectedCount: 3,
            download: { onClick: download },
            tray: { photos: [{ id: 1 }, { id: 2 }, { id: 3 }] as never, onRemove: vi.fn() },
          })}
          copyFilenames={{ count: 3, onClick: vi.fn() }}
        />,
      );
      // The search stays up top; the Select button goes, selection is on.
      expect(screen.getByRole('textbox', { name: 'gallery.searchPhotos' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'gallery.selectPhotos' })).toBeNull();

      const bar = screen.getByTestId('gallery-selection-bar');
      expect(bar).toHaveAttribute('role', 'toolbar');
      expect(bar.style.paddingBottom).toContain('safe-area-inset-bottom');
      // Rendered at the end of the page, not inside the sticky top bar.
      expect(screen.getByTestId('gallery-toolbar').contains(bar)).toBe(false);
      expect(bar).toHaveTextContent('gallery.photosSelected:3');
      // One copy of each action, in the bottom bar.
      expect(screen.getAllByRole('button', { name: 'gallery.copyFilenames.button (3)' })).toHaveLength(1);
      expect(bar.contains(screen.getByRole('button', { name: 'gallery.copyFilenames.button (3)' }))).toBe(true);
      fireEvent.click(screen.getAllByText('common.download (3)')[0]);
      expect(download).toHaveBeenCalledTimes(1);
    });

    it('publishes its height for the floating pills, and withdraws it when it goes', () => {
      const { unmount } = render(
        <GalleryToolbar search={search} selection={selection({ isSelectionMode: true, selectedCount: 1 })} />,
      );
      expect(document.documentElement.style.getPropertyValue('--gallery-bottom-bar')).toMatch(/px$/);
      unmount();
      expect(document.documentElement.style.getPropertyValue('--gallery-bottom-bar')).toBe('');
    });

    it('lets both bottom bar rows wrap on a narrow screen', () => {
      render(<GalleryToolbar search={search} selection={selection({ isSelectionMode: true, selectedCount: 1 })} />);
      const rows = Array.from(screen.getByTestId('gallery-selection-bar').children).filter((el) => el.tagName === 'DIV');
      expect(rows.length).toBeGreaterThanOrEqual(2);
      rows.slice(0, 2).forEach((row) => expect(row.className).toContain('flex-wrap'));
    });

    it('holds the phone layout while a sheet is open across a breakpoint change', () => {
      let listener: () => void = () => {};
      let phone = true;
      vi.stubGlobal('matchMedia', (query: string) => ({
        get matches() { return query === '(max-width: 639px)' && phone; },
        media: query,
        addEventListener: (_type: string, cb: () => void) => { listener = cb; },
        removeEventListener: () => {},
      }));
      render(
        <GalleryToolbar
          search={search}
          filters={{ activeCount: 0, render: () => <p>panel body</p> }}
          selection={selection({ isSelectionMode: true, selectedCount: 1 })}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'gallery.filters' }));
      expect(screen.getByRole('dialog', { name: 'gallery.filters' })).toHaveAttribute('aria-modal', 'true');
      phone = false;
      act(() => listener());
      // Still the sheet, and still the bottom bar.
      expect(screen.getByRole('dialog', { name: 'gallery.filters' })).toHaveAttribute('aria-modal', 'true');
      expect(screen.getByTestId('gallery-selection-bar')).toBeInTheDocument();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByTestId('gallery-selection-bar')).toBeNull();
      expect(screen.getByTestId('gallery-toolbar')).toHaveAttribute('data-mode', 'selection');
    });

    it('hands focus to the desktop Filters when the held layout swaps on close', () => {
      let listener: () => void = () => {};
      let phone = true;
      vi.stubGlobal('matchMedia', (query: string) => ({
        get matches() { return query === '(max-width: 639px)' && phone; },
        media: query,
        addEventListener: (_type: string, cb: () => void) => { listener = cb; },
        removeEventListener: () => {},
      }));
      render(
        <GalleryToolbar
          search={search}
          filters={{ activeCount: 0, render: () => <p>panel body</p> }}
          selection={selection({ isSelectionMode: true, selectedCount: 1 })}
        />,
      );
      const phoneButton = screen.getByRole('button', { name: 'gallery.filters' });
      phoneButton.focus();
      fireEvent.click(phoneButton);
      phone = false;
      act(() => listener());
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByTestId('gallery-selection-bar')).toBeNull();
      expect(screen.getByRole('button', { name: 'gallery.filters' })).toHaveFocus();
    });

    it('holds the desktop layout while the inline rating asks for name and email', () => {
      let listener: () => void = () => {};
      let phone = false;
      vi.stubGlobal('matchMedia', (query: string) => ({
        get matches() { return query === '(max-width: 639px)' && phone; },
        media: query,
        addEventListener: (_type: string, cb: () => void) => { listener = cb; },
        removeEventListener: () => {},
      }));
      render(
        <GalleryToolbar
          search={search}
          selection={selection({ isSelectionMode: true, selectedCount: 2, bulkRating: { slug: 's', photoIds: [1, 2] } })}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'identity open' }));
      phone = true;
      act(() => listener());
      expect(screen.getByTestId('gallery-toolbar')).toHaveAttribute('data-mode', 'selection');
      expect(screen.queryByTestId('gallery-selection-bar')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'identity closed' }));
      expect(screen.getByTestId('gallery-selection-bar')).toBeInTheDocument();
    });

    it('has no bottom bar while nothing is selected', () => {
      render(<GalleryToolbar search={search} selection={selection()} />);
      expect(screen.queryByTestId('gallery-selection-bar')).toBeNull();
    });

    it('opens the filter panel as a bottom sheet and hands focus back on Escape', () => {
      render(
        <GalleryToolbar
          search={search}
          filters={{ activeCount: 0, render: (_close, withSearch) => <p>panel body {String(withSearch)}</p> }}
          selection={selection()}
        />,
      );
      const button = screen.getByRole('button', { name: 'gallery.filters' });
      button.focus();
      fireEvent.click(button);
      const sheet = screen.getByRole('dialog', { name: 'gallery.filters' });
      expect(sheet).toHaveAttribute('aria-modal', 'true');
      // The top bar keeps its search on a phone, so the panel does not repeat it.
      expect(sheet).toHaveTextContent('panel body false');
      expect(screen.getByTestId('gallery-toolbar').contains(sheet)).toBe(false);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(button).toHaveFocus();
    });

    it('rates the selection from a sheet', () => {
      render(
        <GalleryToolbar
          selection={selection({ isSelectionMode: true, selectedCount: 2, bulkRating: { slug: 'g', photoIds: [4, 5] } })}
        />,
      );
      expect(screen.queryByTestId('bulk-rating')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'feedback.rateSelected' }));
      expect(screen.getByRole('dialog', { name: 'feedback.rateSelected' })).toContainElement(screen.getByTestId('bulk-rating'));
    });

    it('opens the selection list as a sheet', () => {
      render(
        <GalleryToolbar
          selection={selection({
            isSelectionMode: true,
            selectedCount: 1,
            tray: { photos: [{ id: 9 }] as never, onRemove: vi.fn() },
          })}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'gallery.selectionTray.title:1' }));
      expect(screen.getByRole('dialog', { name: 'gallery.selectionTray.title:1' })).toContainElement(screen.getByTestId('tray'));
    });
  });
});
