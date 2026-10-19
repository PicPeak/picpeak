import React, { useEffect, useId, useRef, useState } from 'react';
import { CheckSquare, ClipboardList, Filter, ListChecks, Package, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '../common';
import type { Photo } from '../../types';
import type { QuotaPhoto } from '../../utils/downloadLimit';
import { selectLabel } from '../../utils/mediaCounts';
import { BulkRating } from './BulkRating';
import { DownloadQuotaNotice } from './DownloadQuotaNotice';
import { GallerySidebarSelectionTray } from './GallerySidebarSelectionTray';
import { GallerySortMenu, type GallerySortBy } from './GallerySortMenu';

type TrayPhoto = Pick<Photo, 'id' | 'filename' | 'original_filename' | 'thumbnail_url' | 'url'>;

export interface GalleryToolbarSelection {
  /** False where picking is not offered (a carousel, a single photo). */
  available: boolean;
  hasVideos: boolean;
  isSelectionMode: boolean;
  selectedCount: number;
  /** What the filters leave on screen: "Select all" picks these. */
  visibleCount: number;
  onStart: () => void;
  /** Leaves selection mode and drops the selection. */
  onCancel: () => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  download?: {
    onClick: () => void;
    disabled?: boolean;
    isLoading?: boolean;
    /** The selection, for the download-limit notice (issue 1560). */
    quotaPhotos?: QuotaPhoto[];
  };
  /** Rate the selection (issue 1733); absent while ratings are off. */
  bulkRating?: { slug: string; photoIds: number[]; requireNameEmail?: boolean };
  /** The selection as a list (issue 1733, A3e). */
  tray?: { photos: ReadonlyArray<TrayPhoto>; onRemove: (photoId: number) => void; slug?: string };
}

export interface GalleryToolbarProps {
  search?: { value: string; onChange: (term: string) => void };
  sort?: {
    sortBy: GallerySortBy;
    onSortChange: (sort: GallerySortBy) => void;
    sortDesc?: boolean;
    onSortDescChange?: (desc: boolean) => void;
  };
  /**
   * The filter panel (issue 1733, E7); `close` hides it again. It opens from
   * both faces: while selecting, the search box is gone from the bar, so the
   * panel carries it then (`selecting`).
   */
  filters?: { activeCount: number; render: (close: () => void, selecting: boolean) => React.ReactNode };
  /** View controls (grid density and the like) sit between sort and select. */
  viewControls?: React.ReactNode;
  /** Filename list (A3d): the selection, or the favourites outside it. */
  copyFilenames?: { count: number; onClick: () => void };
  selection?: GalleryToolbarSelection;
  /** Shown next to the browse controls. */
  photoCount?: number;
  className?: string;
}

type Popover = 'filters' | 'tray' | null;

// The gallery header is sticky at the top too (GalleryLayout); the toolbar
// sticks right under it, and under the notch where there is no header.
function useHeaderOffset(ref: React.RefObject<HTMLElement>): number {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const header = ref.current?.closest('.gallery-page')?.querySelector<HTMLElement>('.gallery-header');
    if (!header) return;
    const update = () => setOffset(Math.round(header.getBoundingClientRect().height));
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => observer.disconnect();
  }, [ref]);
  return offset;
}

/**
 * The gallery toolbar (issue 1733, E8). It stays on screen while the guest
 * scrolls, and it is one bar with two faces: browse actions (search, filters,
 * sort, select) while nothing is selected, the batch actions for the
 * selection ("N selected", select all, rate, copy filenames, the list,
 * download) as soon as selection mode is on or anything is selected.
 */
export const GalleryToolbar: React.FC<GalleryToolbarProps> = ({
  search,
  sort,
  filters,
  viewControls,
  copyFilenames,
  selection,
  photoCount,
  className = '',
}) => {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const headerOffset = useHeaderOffset(rootRef);
  const [popover, setPopover] = useState<Popover>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const trayButtonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();

  const selecting = !!selection && (selection.isSelectionMode || selection.selectedCount > 0);
  const trayShown = selecting && !!selection?.tray && selection.tray.photos.length > 0;

  // The list belongs to the selection face; a swap back to browsing closes it.
  const openPopover: Popover = popover === 'filters' && filters
    ? 'filters'
    : popover === 'tray' && trayShown ? 'tray' : null;

  // Escape and a press outside close the popover; Escape hands focus back to
  // the button that opened it.
  useEffect(() => {
    if (!openPopover) return;
    const trigger = openPopover === 'filters' ? filterButtonRef : trayButtonRef;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setPopover(null);
      trigger.current?.focus();
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target) || trigger.current?.contains(target)) return;
      setPopover(null);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [openPopover]);

  const close = () => setPopover(null);
  const toggle = (which: Exclude<Popover, null>) => setPopover((current) => (current === which ? null : which));

  // Icon and count only where the bar is short of room: on a phone, and in
  // the selection face below 2xl, which carries the most actions. The icon
  // goes in as a child, not as leftIcon, so an icon-only button stays centred.
  const compact = selecting ? 'text-xs sm:text-sm' : 'text-sm md:text-base px-2.5 md:px-4';
  const copyButton = copyFilenames && copyFilenames.count > 0 ? (
    <Button
      variant="outline"
      size={selecting ? 'sm' : 'md'}
      onClick={copyFilenames.onClick}
      className={`${compact} whitespace-nowrap gap-1.5`}
      aria-label={`${t('gallery.copyFilenames.button', 'Copy filenames')} (${copyFilenames.count})`}
      title={t('gallery.copyFilenames.button', 'Copy filenames')}
    >
      <ClipboardList className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span className={`hidden ${selecting ? '2xl:inline' : 'lg:inline'}`}>{t('gallery.copyFilenames.button', 'Copy filenames')}</span>
      <span>({copyFilenames.count})</span>
    </Button>
  ) : null;

  const filterButton = filters ? (
    <Button
      ref={filterButtonRef}
      variant={filters.activeCount > 0 ? 'primary' : 'outline'}
      size={selecting ? 'sm' : 'md'}
      onClick={() => toggle('filters')}
      aria-expanded={openPopover === 'filters'}
      aria-controls={openPopover === 'filters' ? popoverId : undefined}
      aria-label={filters.activeCount > 0
        ? `${t('gallery.filters', 'Filters')}, ${t('gallery.filterPanel.activeCount', { count: filters.activeCount })}`
        : t('gallery.filters', 'Filters')}
      className={`${compact} whitespace-nowrap gap-1.5`}
    >
      <Filter className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span className="hidden md:inline">{t('gallery.filters', 'Filters')}</span>
      {filters.activeCount > 0 && <span>({filters.activeCount})</span>}
    </Button>
  ) : null;

  const browseRow = (
    <div className="flex items-center gap-2 md:gap-3" role="toolbar" aria-label={t('gallery.toolbar.browse', 'Gallery tools')}>
      {search && (
        <div className="flex-1 min-w-0">
          <Input
            themed
            type="text"
            placeholder={t('gallery.searchPhotos')}
            aria-label={t('gallery.searchPhotos')}
            leftIcon={<Search className="w-5 h-5 text-muted-theme" />}
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            className="text-sm md:text-base"
          />
        </div>
      )}
      {!search && <div className="flex-1" />}
      {filterButton}
      {sort && (
        <GallerySortMenu
          sortBy={sort.sortBy}
          onSortChange={sort.onSortChange}
          sortDesc={sort.sortDesc}
          onSortDescChange={sort.onSortDescChange}
        />
      )}
      {viewControls}
      {photoCount !== undefined && (
        <p className="hidden lg:block text-sm text-muted-theme whitespace-nowrap">
          {photoCount} {t('common.media', 'media')}
        </p>
      )}
      {copyButton}
      {selection?.available && (
        <Button
          variant="outline"
          size="md"
          onClick={selection.onStart}
          title={t('gallery.selectPhotosHint')}
          aria-label={selectLabel(t, selection.hasVideos)}
          className={`${compact} whitespace-nowrap gap-1.5`}
        >
          <CheckSquare className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span className="hidden md:inline">{selectLabel(t, selection.hasVideos)}</span>
        </Button>
      )}
    </div>
  );

  const selectionRow = selection && (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 flex-wrap" role="toolbar" aria-label={t('gallery.toolbar.selection', 'Selection')}>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={selection.onCancel}
          aria-label={t('gallery.cancelSelection')}
          title={t('gallery.cancelSelection')}
        >
          <X className="w-4 h-4" />
        </Button>
        <span className="text-sm font-medium text-theme whitespace-nowrap" aria-live="polite">
          {t('gallery.photosSelected', { count: selection.selectedCount })}
        </span>
        <div className="flex items-center gap-1 flex-wrap">
          <Button
            variant="ghost"
            size="sm"
            onClick={selection.onSelectAll}
            disabled={selection.visibleCount === 0}
            className="text-xs sm:text-sm"
          >
            {t('gallery.selectAll')} ({selection.visibleCount})
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={selection.onDeselectAll}
            disabled={selection.selectedCount === 0}
            className="text-xs sm:text-sm"
          >
            {t('gallery.deselectAll')}
          </Button>
        </div>
        <div className="flex items-center gap-2 flex-wrap ml-auto">
          {filterButton}
          {selection.bulkRating && selection.selectedCount > 0 && (
            <BulkRating {...selection.bulkRating} />
          )}
          {copyButton}
          {trayShown && (
            <Button
              ref={trayButtonRef}
              variant="outline"
              size="sm"
              leftIcon={<ListChecks className="w-4 h-4" />}
              onClick={() => toggle('tray')}
              aria-expanded={openPopover === 'tray'}
              aria-controls={openPopover === 'tray' ? popoverId : undefined}
              className="text-xs sm:text-sm whitespace-nowrap"
            >
              {t('gallery.selectionTray.title', 'Selected ({{count}})', { count: selection.selectedCount })}
            </Button>
          )}
          {selection.download && selection.selectedCount > 0 && (
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Package className="w-4 h-4" />}
              onClick={selection.download.onClick}
              disabled={selection.download.disabled}
              isLoading={selection.download.isLoading}
              focusableWhileLoading
              className="text-xs sm:text-sm whitespace-nowrap"
            >
              <span className="hidden xl:inline">{t('gallery.downloadSelected', { count: selection.selectedCount })}</span>
              <span className="xl:hidden">{t('common.download')} ({selection.selectedCount})</span>
            </Button>
          )}
        </div>
      </div>
      {selection.download?.quotaPhotos && selection.selectedCount > 0 && (
        <DownloadQuotaNotice photos={selection.download.quotaPhotos} className="text-xs sm:text-sm" />
      )}
    </div>
  );

  return (
    <div
      ref={rootRef}
      data-testid="gallery-toolbar"
      data-mode={selecting ? 'selection' : 'browse'}
      className={`gallery-toolbar sticky z-30 -mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 py-3 bg-background border-b border-border-token ${className}`}
      style={{
        top: `max(env(safe-area-inset-top, 0px), ${headerOffset}px)`,
        // The bar changes height when it swaps; scroll anchoring would then
        // shift the page under the guest's finger.
        overflowAnchor: 'none',
      }}
    >
      {selecting ? selectionRow : browseRow}

      {openPopover && (
        <div
          ref={popoverRef}
          id={popoverId}
          role="dialog"
          aria-label={openPopover === 'filters'
            ? t('gallery.filters', 'Filters')
            : t('gallery.selectionTray.title', 'Selected ({{count}})', { count: selection?.selectedCount ?? 0 })}
          className={`absolute right-4 sm:right-6 lg:right-8 top-full mt-1 w-[min(32rem,calc(100vw-2rem))] max-h-[70vh] overflow-y-auto rounded-lg border border-border-token bg-surface shadow-lg ${
            openPopover === 'filters' ? 'p-4' : ''
          }`}
        >
          <button
            type="button"
            onClick={() => {
              close();
              (openPopover === 'filters' ? filterButtonRef : trayButtonRef).current?.focus();
            }}
            aria-label={t('common.close', 'Close')}
            className="absolute top-3 right-3 z-10 p-1 rounded text-muted-theme hover-surface"
          >
            <X className="w-4 h-4" />
          </button>
          {openPopover === 'filters' && (
            <>
              <h2 className="text-sm font-semibold text-theme mb-3 pr-8">{t('gallery.filters', 'Filters')}</h2>
              {filters?.render(close, selecting)}
            </>
          )}
          {/* The list brings its own title, which also folds it. */}
          {openPopover === 'tray' && selection?.tray && (
            <GallerySidebarSelectionTray
              photos={selection.tray.photos}
              onRemove={selection.tray.onRemove}
              slug={selection.tray.slug}
              onEmptied={close}
            />
          )}
        </div>
      )}
    </div>
  );
};
