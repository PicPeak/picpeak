import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckSquare, ClipboardList, Filter, ListChecks, Package, Search, Star, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '../common';
import type { Photo } from '../../types';
import type { QuotaPhoto } from '../../utils/downloadLimit';
import { selectLabel } from '../../utils/mediaCounts';
import { BulkRating } from './BulkRating';
import { DownloadQuotaNotice } from './DownloadQuotaNotice';
import { GallerySidebarSelectionTray } from './GallerySidebarSelectionTray';
import { GallerySortMenu, type GallerySortBy } from './GallerySortMenu';
import { GalleryBottomSheet } from './GalleryBottomSheet';
import { useIsPhone } from './hooks/useIsPhone';

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
   * both faces: while the bar shows the selection face, its search box is
   * gone, so the panel carries it then (`withSearch`).
   */
  filters?: { activeCount: number; render: (close: () => void, withSearch: boolean) => React.ReactNode };
  /** View controls (grid density and the like) sit between sort and select. */
  viewControls?: React.ReactNode;
  /** Filename list (A3d): the selection, or the favourites outside it. */
  copyFilenames?: { count: number; onClick: () => void };
  selection?: GalleryToolbarSelection;
  /** Shown next to the browse controls. */
  photoCount?: number;
  className?: string;
}

type Popover = 'filters' | 'tray' | 'rate' | null;

// Focus in the bar or its popover, or nowhere in particular.
function focusIsOurs(root: HTMLElement | null): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !!root?.contains(active);
}

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

// The bar's own height, which the popover under it has to leave room for.
function useHeight(ref: React.RefObject<HTMLElement>): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setHeight(Math.round(el.getBoundingClientRect().height));
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}

// While the phone's bottom bar is up, the page gets that much room at its
// end, so the last row of photos and the footer can scroll clear of it. The
// height is also published as --gallery-bottom-bar, which the floating pills
// (new photos, upload processing) sit above.
const BOTTOM_BAR_VAR = '--gallery-bottom-bar';
function useBottomBarRoom(ref: React.RefObject<HTMLElement>, active: boolean): void {
  useEffect(() => {
    const bar = ref.current;
    if (!active || !bar) return;
    const body = document.body;
    const root = document.documentElement;
    const original = body.style.paddingBottom;
    const update = () => {
      const height = `${Math.round(bar.getBoundingClientRect().height)}px`;
      body.style.paddingBottom = height;
      root.style.setProperty(BOTTOM_BAR_VAR, height);
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(bar);
    return () => {
      observer?.disconnect();
      body.style.paddingBottom = original;
      root.style.removeProperty(BOTTOM_BAR_VAR);
    };
  }, [ref, active]);
}

/**
 * The gallery toolbar (issue 1733, E8). It stays on screen while the guest
 * scrolls, and it is one bar with two faces: browse actions (search, filters,
 * sort, select) while nothing is selected, the batch actions for the
 * selection ("N selected", select all, rate, copy filenames, the list,
 * download) as soon as selection mode is on or anything is selected.
 *
 * On a phone (E5) the top bar keeps browsing and the batch actions sit in a
 * bar at the bottom of the screen, in thumb reach; the filter panel, the
 * selection list and the rating open as bottom sheets.
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
  const barHeight = useHeight(rootRef);
  const [popover, setPopover] = useState<Popover>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const trayButtonRef = useRef<HTMLButtonElement>(null);
  const selectButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const bottomBarRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  // Held while a popover, a sheet or the rating's name-and-email dialog is
  // open: crossing the breakpoint then (a phone turned sideways) would swap
  // the inline rating for the sheet one or a popover for a sheet, unmounting
  // the focused control, the sheet's return target and a half-filled
  // identity dialog with them. The layout follows once they are closed.
  const livePhone = useIsPhone();
  const [isPhone, setIsPhone] = useState(livePhone);
  const [ratingDialogOpen, setRatingDialogOpen] = useState(false);
  // The name and email given to the rating, kept here: the phone's rating
  // sheet unmounts its BulkRating on every close.
  const [ratingIdentity, setRatingIdentity] = useState<{ name: string; email: string } | null>(null);
  useEffect(() => {
    if (!popover && !ratingDialogOpen) setIsPhone(livePhone);
  }, [livePhone, popover, ratingDialogOpen]);

  const selecting = !!selection && (selection.isSelectionMode || selection.selectedCount > 0);
  const trayShown = selecting && !!selection?.tray && selection.tray.photos.length > 0;
  const rateShown = selecting && !!selection?.bulkRating && selection.selectedCount > 0;
  // The top bar's face: on a phone it keeps browsing while the bottom bar
  // carries the selection.
  const selectionFace = selecting && !isPhone;
  const bottomBarShown = selecting && isPhone;
  useBottomBarRoom(bottomBarRef, bottomBarShown);

  // The list and the rating belong to the selection; ending it closes them.
  const openPopover: Popover = popover === 'filters' && filters
    ? 'filters'
    : popover === 'tray' && trayShown ? 'tray'
    : popover === 'rate' && rateShown && isPhone ? 'rate' : null;

  // A popover whose content went away (the last photo taken off the list, the
  // filters withdrawn) is closed for good, so it does not pop back open by
  // itself the next time that content returns.
  useEffect(() => {
    if (!popover || openPopover) return;
    setPopover(null);
  }, [popover, openPopover]);

  // However a popover closed (its own "Select these N", its content gone),
  // focus that fell to the page with the control it was on goes back to the
  // button that opened it, or to the bar if that went too.
  const lastOpen = useRef<Popover>(null);
  const lastTrigger = useRef<Popover>(null);
  useLayoutEffect(() => {
    const closed = lastOpen.current;
    lastOpen.current = openPopover;
    if (openPopover) lastTrigger.current = openPopover;
    if (!closed || openPopover) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    const trigger = (closed === 'filters' ? filterButtonRef : trayButtonRef).current;
    (trigger ?? rootRef.current?.querySelector<HTMLElement>('button:not([disabled]), input'))?.focus();
  }, [openPopover]);

  // The held layout swaps once a sheet closes, which unmounts the button the
  // sheet has just handed focus back to; its counterpart takes it instead.
  const wasPhone = useRef(isPhone);
  useLayoutEffect(() => {
    if (wasPhone.current === isPhone) return;
    wasPhone.current = isPhone;
    if (document.activeElement && document.activeElement !== document.body) return;
    const trigger = lastTrigger.current === 'filters' ? filterButtonRef.current
      : lastTrigger.current === 'tray' ? trayButtonRef.current : null;
    (trigger ?? cancelButtonRef.current ?? rootRef.current?.querySelector<HTMLElement>('button:not([disabled]), input'))?.focus();
  }, [isPhone]);

  // The swap unmounts the button that started or ended the selection; focus
  // that fell to the page with it moves to its counterpart on the new face.
  const wasSelecting = useRef(selecting);
  useLayoutEffect(() => {
    if (wasSelecting.current === selecting) return;
    wasSelecting.current = selecting;
    if (document.activeElement && document.activeElement !== document.body) return;
    (selecting ? cancelButtonRef : selectButtonRef).current?.focus();
  }, [selecting]);

  // Escape and a press outside close the popover; Escape hands focus back to
  // the button that opened it. A sheet does all of that itself.
  useEffect(() => {
    if (!openPopover || isPhone) return;
    const trigger = openPopover === 'filters' ? filterButtonRef : trayButtonRef;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape inside something else (the lightbox opened by keyboard over
      // the open panel, a field it keeps Escape for) is not for the panel.
      if (!focusIsOurs(rootRef.current)) return;
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
  }, [openPopover, isPhone]);

  const close = () => setPopover(null);
  const toggle = (which: Exclude<Popover, null>) => setPopover((current) => (current === which ? null : which));

  // Icon and count only where the bar is short of room: on a phone, and in
  // the selection face below 2xl, which carries the most actions. The icon
  // goes in as a child, not as leftIcon, so an icon-only button stays centred.
  // The copy button joins the batch actions while selecting: in the top bar's
  // selection face, or in the phone's bottom bar.
  const compactFor = (inSelection: boolean) => (inSelection ? 'text-xs sm:text-sm' : 'text-sm md:text-base px-2.5 md:px-4');
  const compact = compactFor(selectionFace);
  const copyButton = copyFilenames && copyFilenames.count > 0 ? (
    <Button
      variant="outline"
      size={selecting ? 'sm' : 'md'}
      onClick={copyFilenames.onClick}
      className={`${compactFor(selecting)} whitespace-nowrap gap-1.5`}
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
      size={selectionFace ? 'sm' : 'md'}
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
    // Once the buttons (labelled from md) and a usable search box no longer
    // fit on one line, the buttons wrap instead of crushing the search.
    <div className="flex flex-wrap items-center gap-2 md:gap-3" role="toolbar" aria-label={t('gallery.toolbar.browse', 'Gallery tools')}>
      {search && (
        <div className="flex-1 min-w-[9rem] md:min-w-[14rem]">
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
          onOpen={close}
        />
      )}
      {viewControls}
      {photoCount !== undefined && (
        <p className="hidden lg:block text-sm text-muted-theme whitespace-nowrap">
          {photoCount} {t('common.media', 'media')}
        </p>
      )}
      {/* On a phone the bottom bar has its own while selecting. */}
      {!bottomBarShown && copyButton}
      {selection?.available && !selecting && (
        <Button
          ref={selectButtonRef}
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

  const trayButton = (phone: boolean) => trayShown && selection ? (
    <Button
      ref={trayButtonRef}
      variant="outline"
      size="sm"
      onClick={() => toggle('tray')}
      aria-expanded={openPopover === 'tray'}
      aria-controls={openPopover === 'tray' && !phone ? popoverId : undefined}
      aria-label={t('gallery.selectionTray.title', 'Selected ({{count}})', { count: selection.selectedCount })}
      className="text-xs sm:text-sm whitespace-nowrap gap-1.5"
    >
      <ListChecks className="w-4 h-4 shrink-0" aria-hidden="true" />
      {phone
        ? <span>({selection.selectedCount})</span>
        : <span>{t('gallery.selectionTray.title', 'Selected ({{count}})', { count: selection.selectedCount })}</span>}
    </Button>
  ) : null;

  const downloadButton = (phone: boolean) => selection?.download && selection.selectedCount > 0 ? (
    <Button
      variant="primary"
      size="sm"
      leftIcon={<Package className="w-4 h-4" />}
      onClick={selection.download.onClick}
      disabled={selection.download.disabled}
      isLoading={selection.download.isLoading}
      focusableWhileLoading
      className={`text-xs sm:text-sm whitespace-nowrap ${phone ? 'flex-1' : ''}`}
    >
      <span className="hidden xl:inline">{t('gallery.downloadSelected', { count: selection.selectedCount })}</span>
      <span className="xl:hidden">{t('common.download')} ({selection.selectedCount})</span>
    </Button>
  ) : null;

  const cancelButton = selection ? (
    <Button
      ref={cancelButtonRef}
      variant="ghost"
      size="icon-sm"
      onClick={selection.onCancel}
      aria-label={t('gallery.cancelSelection')}
      title={t('gallery.cancelSelection')}
    >
      <X className="w-4 h-4" />
    </Button>
  ) : null;

  const selectedCountLabel = selection ? (
    <span className="text-sm font-medium text-theme whitespace-nowrap" aria-live="polite">
      {t('gallery.photosSelected', { count: selection.selectedCount })}
    </span>
  ) : null;

  const selectAllButtons = selection ? (
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
  ) : null;

  const quotaNotice = selection?.download?.quotaPhotos && selection.selectedCount > 0 ? (
    <DownloadQuotaNotice photos={selection.download.quotaPhotos} className="text-xs sm:text-sm" />
  ) : null;

  const selectionRow = selection && (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 flex-wrap" role="toolbar" aria-label={t('gallery.toolbar.selection', 'Selection')}>
        {cancelButton}
        {selectedCountLabel}
        {selectAllButtons}
        <div className="flex items-center gap-2 flex-wrap ml-auto">
          {filterButton}
          {rateShown && selection.bulkRating && <BulkRating {...selection.bulkRating} onDialogChange={setRatingDialogOpen} identity={ratingIdentity} onIdentityChange={setRatingIdentity} />}
          {copyButton}
          {trayButton(false)}
          {downloadButton(false)}
        </div>
      </div>
      {quotaNotice}
    </div>
  );

  // The phone's selection bar (E5): fixed to the bottom edge, above the home
  // indicator. Two rows: what is selected, then what to do with it.
  const bottomBar = bottomBarShown && selection ? createPortal(
    <div
      ref={bottomBarRef}
      data-testid="gallery-selection-bar"
      role="toolbar"
      aria-label={t('gallery.toolbar.selection', 'Selection')}
      className="gallery-selection-bar fixed inset-x-0 bottom-0 z-40 bg-surface border-t border-border-token shadow-[0_-4px_12px_rgba(0,0,0,0.08)] px-4 pt-2"
      style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.5rem)' }}
    >
      {/* Both rows wrap: a long locale must not push actions off a narrow screen. */}
      <div className="flex items-center gap-x-2 gap-y-1 flex-wrap">
        {cancelButton}
        {selectedCountLabel}
        <div className="ml-auto">{selectAllButtons}</div>
      </div>
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        {rateShown && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => toggle('rate')}
            aria-expanded={openPopover === 'rate'}
            aria-label={t('feedback.rateSelected', 'Rate selected')}
            className="text-xs gap-1.5"
          >
            <Star className="w-4 h-4 shrink-0" aria-hidden="true" />
          </Button>
        )}
        {copyButton}
        {trayButton(true)}
        {downloadButton(true)}
      </div>
      {quotaNotice && <div className="mt-1">{quotaNotice}</div>}
    </div>,
    document.body,
  ) : null;

  const surfaceTitle = openPopover === 'filters'
    ? t('gallery.filters', 'Filters')
    : openPopover === 'rate'
      ? t('feedback.rateSelected', 'Rate selected')
      : t('gallery.selectionTray.title', 'Selected ({{count}})', { count: selection?.selectedCount ?? 0 });

  const surfaceContent = openPopover === 'filters'
    ? filters?.render(close, selectionFace)
    : openPopover === 'tray' && selection?.tray
      ? (
        <GallerySidebarSelectionTray
          photos={selection.tray.photos}
          onRemove={selection.tray.onRemove}
          slug={selection.tray.slug}
          onEmptied={close}
          foldable={false}
        />
      )
      : openPopover === 'rate' && selection?.bulkRating
        ? <BulkRating {...selection.bulkRating} onDialogChange={setRatingDialogOpen} identity={ratingIdentity} onIdentityChange={setRatingIdentity} />
        : null;

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
      {selectionFace ? selectionRow : browseRow}

      {openPopover && !isPhone && (
        <div
          ref={popoverRef}
          id={popoverId}
          role="dialog"
          aria-label={surfaceTitle}
          // Within the screen once the bar has stuck under the header, however
          // tall the bar has grown; the class is the fallback without dvh.
          style={{ maxHeight: `min(70vh, calc(100dvh - max(env(safe-area-inset-top, 0px), ${headerOffset}px) - ${barHeight}px - 1rem))` }}
          className="absolute right-4 sm:right-6 lg:right-8 top-full mt-1 w-[min(32rem,calc(100vw-2rem))] max-h-[70vh] overflow-y-auto rounded-lg border border-border-token bg-surface shadow-lg p-4"
        >
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="text-sm font-semibold text-theme">{surfaceTitle}</h2>
            <button
              type="button"
              onClick={() => {
                close();
                (openPopover === 'filters' ? filterButtonRef : trayButtonRef).current?.focus();
              }}
              aria-label={t('common.close', 'Close')}
              className="p-1 rounded text-muted-theme hover-surface"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          {surfaceContent}
        </div>
      )}

      {isPhone && (
        <GalleryBottomSheet open={!!openPopover} onClose={close} title={surfaceTitle}>
          {surfaceContent}
        </GalleryBottomSheet>
      )}

      {bottomBar}
    </div>
  );
};
