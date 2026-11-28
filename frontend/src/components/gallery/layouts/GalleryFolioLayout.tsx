import React, { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { parseISO } from 'date-fns';
import { MasonryPhotoAlbum } from 'react-photo-album';
import type { RenderPhotoContext } from 'react-photo-album';
import 'react-photo-album/masonry.css';
import { ArrowDown, CheckSquare, ClipboardList, Download, LogOut, Package, Play, Shield, Upload, X } from 'lucide-react';

import type { BaseGalleryLayoutProps } from './BaseGalleryLayout';
import type { Photo } from '../../../types';
import { ActionMenu, AuthenticatedImage, PoweredBy, type ActionMenuItem } from '../../common';
import { LANE_CONTROL_BOX, PhotoCard } from '../PhotoCard';
import { BackToAccountLink } from '../BackToAccountLink';
import { BulkRatingPopover } from '../BulkRatingPopover';
import { ClientVisibilityToggle, isHiddenFromGuests } from '../ClientVisibilityToggle';
import { DownloadQuotaNotice } from '../DownloadQuotaNotice';
import { GalleryEmptyMessage, LikedOnlyEmptyMessage } from '../GalleryEmptyMessage';
import { heroImageUrl } from '../heroImage';
import { GallerySecondaryText, useGallerySecondaryText } from '../../../hooks/useGalleryText';
import { useOptionalTheme } from '../../../contexts/ThemeContext';
import { useDownloadQuota } from '../../../contexts/DownloadQuotaContext';
import { PhotoSalesCartButton } from '../../../features/photo-sales/PhotoSalesCartButton';
import { isVideoItem, selectLabel } from '../../../utils/mediaCounts';
import { useLazyBands } from './lazyBands';
import { useViewerLikes } from './optimisticLikes';
import { boxStyle, type TileBox } from './measuredWindow';
import { WINDOW_MIN_PHOTOS } from './rowWindow';
import { PremiumWindowedAlbum } from './PremiumWindowedAlbum';
import { useDownloadAll } from './useDownloadAll';
import { FullPageEmptyState } from './FullPageEmptyState';
import { FOLIO_GAPS, FOLIO_WIDE_NAV_QUERY, folioColumnsForWidth, folioPaletteStyle, folioSettings } from './folioSettings';
import { LikedNavButton } from './LikedNavButton';
import { useFullPageLabels, useSelectionControls } from './fullPageNav';

import './GalleryFolioLayout.css';

const EMPTY_SELECTION: Set<number> = new Set();

interface GalleryFolioLayoutProps extends BaseGalleryLayoutProps {
  heroPhotoOverride?: Photo | null;
  welcomeMessage?: string;
  /** The event's hero focal point ("X% Y%" or a keyword), for the cover. */
  heroImageAnchor?: string;
}

type AlbumPhoto = { src: string; width: number; height: number; key: string; index: number; photo: Photo };

/**
 * Whether the nav row shows its secondary actions or the menu holds them.
 * Without matchMedia (no browser) the row does, as on a desktop.
 */
function useWideNav(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia?.(FOLIO_WIDE_NAV_QUERY);
      query?.addEventListener?.('change', onChange);
      return () => query?.removeEventListener?.('change', onChange);
    },
    () => window.matchMedia?.(FOLIO_WIDE_NAV_QUERY).matches ?? true,
    () => true,
  );
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Gallery Folio (issue 2617): a quiet, image-first client gallery. A
 * photographic cover, a slim nav with the gallery's actions, and the photos
 * in their own proportions. It opens the shared PhotoLightbox and uses the
 * shared tile (PhotoCard), so feedback, downloads, selection and the client's
 * controls behave as they do in the standard layouts.
 */
export const GalleryFolioLayout: React.FC<GalleryFolioLayoutProps> = ({
  photos,
  slug,
  onPhotoClick,
  onFeedbackChange,
  onDownload,
  selectedPhotos,
  isSelectionMode = false,
  onPhotoSelect,
  onSelectMany,
  onDeselectAll,
  onToggleSelectionMode,
  onDownloadSelected,
  selectionQuotaPhotos,
  eventName,
  eventDate,
  allowDownloads = true,
  suppressEmptyState = false,
  emptyIsFiltered = false,
  afterGrid,
  beforeGrid,
  onDownloadEverything,
  onCopyFilenames,
  copyFilenamesCount = 0,
  likedOnly = false,
  onToggleLikedOnly,
  downloadChoices,
  onPickResolution,
  feedbackEnabled = false,
  feedbackOptions,
  heroPhotoOverride,
  welcomeMessage,
  heroImageAnchor = 'center',
  onLogout,
  showBackToAccount = false,
  onManageGallery,
  clientModeBusy,
  onUploadClick,
  isClient = false,
  onToggleVisibility,
}) => {
  const { t, i18n } = useTranslation();
  const secondaryWelcome = useGallerySecondaryText().welcome;
  const theme = useOptionalTheme()?.theme;
  const folio = folioSettings(theme?.gallerySettings);
  const paletteStyle = folioPaletteStyle(folio.palette);
  const wideNav = useWideNav();
  const bands = useLazyBands();
  const downloadQuota = useDownloadQuota();

  // Per-viewer is_liked is the server's truth (#590): the set follows each
  // payload and a toggle holds until one confirms it (issue 2561).
  const [likedPhotoIds, toggleLiked, likeSettled, likeFailed] = useViewerLikes(photos, onFeedbackChange, slug);
  // The identity one tile asked for is reused by every other tile.
  const [savedIdentity, setSavedIdentity] = useState<{ name: string; email: string } | null>(null);

  const { downloadAll, canDownloadAll } = useDownloadAll({
    photos, slug, allowDownloads, onDownloadEverything, downloadChoices, onPickResolution,
  });

  const toolbar = typeof beforeGrid === 'function' ? beforeGrid(photos) : beforeGrid;

  // Selection (issue 1716): the container owns the mode and the set.
  const selected = selectedPhotos ?? EMPTY_SELECTION;
  const selectionAvailable = Boolean(onToggleSelectionMode && onPhotoSelect);
  // More than one photo, or the only way out of a one-photo selection would
  // be a reload.
  const canSelect = selectionAvailable && photos.length > 1;
  const hasVideos = photos.some(isVideoItem);
  const likesAllowed = feedbackEnabled && !!feedbackOptions?.allowLikes;
  const ratingsAllowed = feedbackEnabled && !!feedbackOptions?.allowRatings && !!slug;
  const selectedPhotoList = useMemo(
    () => selectionQuotaPhotos ?? photos.filter((photo) => selected.has(photo.id)),
    [selectionQuotaPhotos, photos, selected]
  );

  const { allVisibleSelected, toggleSelectionMode, selectAllVisible } = useSelectionControls({
    visiblePhotos: photos, selected, isSelectionMode, onDeselectAll, onToggleSelectionMode, onSelectMany,
  });
  const labels = useFullPageLabels({ isClient, hasVideos, isSelectionMode, copyFilenamesCount });

  const navRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const scrollToPhotos = useCallback(() => {
    const main = mainRef.current;
    if (!main) return;
    // To just under the sticky nav, at the height it has now: the selection
    // row makes it taller, and a fixed offset would hide the first photos.
    const top = main.getBoundingClientRect().top + window.scrollY - (navRef.current?.offsetHeight ?? 0);
    window.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    main.focus({ preventScroll: true });
  }, []);
  const scrollToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, []);

  // The photos in their own proportions; a photo without stored dimensions
  // takes 3:2 rather than a square.
  const albumPhotos = useMemo<AlbumPhoto[]>(() => photos.map((photo, index) => ({
    src: photo.thumbnail_url || photo.url,
    width: photo.width || 1200,
    height: photo.height || 800,
    key: String(photo.id),
    index,
    photo,
  })), [photos]);
  const { mobile, desktop } = folio.columns;
  const albumColumns = useMemo(() => folioColumnsForWidth({ mobile, desktop }), [mobile, desktop]);
  const gap = FOLIO_GAPS[folio.spacing];
  // A large gallery mounts only the tiles near the viewport (issue 2193).
  const largeGallery = photos.length >= WINDOW_MIN_PHOTOS;
  const tileFeedbackOptions = useMemo(() => feedbackOptions && ({
    ...feedbackOptions,
    // A quiet tile: like and download on hover; ratings and comments live in
    // the lightbox, one click away.
    allowRatings: false,
    allowComments: false,
  }), [feedbackOptions]);

  const renderTile = ({ photo: albumPhoto, height }: RenderPhotoContext<AlbumPhoto>, box?: TileBox) => {
    const { photo, index } = albumPhoto;
    const showToggle = isClient && Boolean(onToggleVisibility);
    const dimmed = showToggle && isHiddenFromGuests(photo);
    return (
      <PhotoCard
        key={photo.id}
        photo={photo}
        isSelected={selected.has(photo.id)}
        isSelectionMode={isSelectionMode}
        onClick={() => onPhotoClick(index)}
        onDownload={(e) => onDownload(photo, e)}
        onToggleSelect={() => onPhotoSelect?.(photo.id)}
        // Every mark and control in one row along the bottom (PhotoCard's
        // lane): nothing can land on anything else on a narrow two-column
        // tile or a panorama only 50 px high.
        lane
        laneMarks={isVideoItem(photo) ? (
          <span className="folio-video-mark">
            <Play className="w-3 h-3" aria-hidden="true" fill="currentColor" />
            <span className="sr-only">{t('common.video', 'Video')}</span>
          </span>
        ) : undefined}
        className="folio-tile photo-card group"
        style={{ width: '100%', height, ...boxStyle(box) }}
        lazy
        inViewRootMargin={bands.load}
        releaseRootMargin={bands.keep}
        skeletonClassName="folio-tile-placeholder"
        imageProps={{
          src: photo.thumbnail_url || photo.url,
          alt: photo.filename,
          className: `folio-tile-image${dimmed ? ' opacity-40' : ''}`,
          loading: 'lazy',
          isGallery: true,
          slug,
        }}
        overlayBaseClassName="folio-tile-overlay"
        allowDownloads={allowDownloads}
        feedbackEnabled={feedbackEnabled}
        feedbackOptions={tileFeedbackOptions}
        slug={slug}
        onFeedbackChange={likeSettled}
        liked={likedPhotoIds.has(photo.id)}
        onLikeSuccess={() => toggleLiked(photo.id)}
        onLikeRefused={() => likeFailed(photo.id)}
        identityMode="self"
        savedIdentity={savedIdentity}
        onIdentitySaved={setSavedIdentity}
        likeToggleLabels
        checkboxTestId
        topLeftControl={showToggle && onToggleVisibility
          ? <ClientVisibilityToggle photo={photo} onToggle={onToggleVisibility} className={`inline-flex ${LANE_CONTROL_BOX}`} />
          : undefined}
      />
    );
  };

  // #1160: nothing in scope and no folder tiles to explain it. A search or
  // filter that left nothing keeps the page (issue 2543), so the toolbox
  // that set it stays put.
  if (photos.length === 0 && !suppressEmptyState && !emptyIsFiltered) {
    return (
      <div className="gallery-folio gallery-folio--empty" style={paletteStyle}>
        <FullPageEmptyState
          toolbar={toolbar}
          toolbarClassName="folio-toolbar folio-toolbar--empty"
          showBackToAccount={showBackToAccount}
          onManageGallery={onManageGallery}
          clientModeBusy={clientModeBusy}
          isClient={isClient}
          likedOnly={likedOnly}
          onToggleLikedOnly={onToggleLikedOnly}
          emptyIsFiltered={emptyIsFiltered}
          onUploadClick={onUploadClick}
          onCopyFilenames={onCopyFilenames}
          copyFilenamesCount={copyFilenamesCount}
        />
      </div>
    );
  }

  const title = eventName || t('gallery.photoGallery', 'Photo Gallery');
  // Long form, in the gallery's language. parseISO: a bare yyyy-MM-dd read by
  // `new Date` is UTC midnight, the day before west of UTC.
  const formattedDate = eventDate
    ? parseISO(eventDate).toLocaleDateString(i18n.language, { year: 'numeric', month: 'long', day: 'numeric' })
    : null;
  // A video has no preview to show as an image: its poster stands in, and
  // without one the cover keeps to the title. A hero the container picked
  // (a video-only gallery hands over its first video) goes through the same.
  const coverSource = (photo: Photo) => (isVideoItem(photo) ? photo.thumbnail_url || null : heroImageUrl(photo, true));
  const firstPhoto = photos.find((photo) => !isVideoItem(photo));
  const coverSrc = (heroPhotoOverride && coverSource(heroPhotoOverride))
    || (firstPhoto && coverSource(firstPhoto))
    || null;
  const coverVariant = coverSrc ? folio.cover : 'plain';
  // The phone's menu: the same secondary actions as the row, logout last.
  const secondaryActions: ActionMenuItem[] = [
    ...(onUploadClick ? [{ key: 'upload', label: labels.upload, icon: <Upload />, onSelect: onUploadClick }] : []),
    ...(onCopyFilenames && copyFilenamesCount > 0
      ? [{ key: 'filenames', label: labels.copyFilenames, icon: <ClipboardList />, onSelect: onCopyFilenames }]
      : []),
    ...(onManageGallery
      ? [{ key: 'manage', label: labels.manage, icon: <Shield />, disabled: clientModeBusy, onSelect: onManageGallery }]
      : []),
    ...(onLogout ? [{ key: 'logout', label: t('common.logout', 'Logout'), icon: <LogOut />, onSelect: onLogout }] : []),
  ];

  return (
    <div
      className="gallery-folio"
      data-type={folio.type}
      data-spacing={folio.spacing}
      style={paletteStyle}
    >
      <header className={`folio-cover folio-cover--${coverVariant}`}>
        {coverSrc && (
          <div className="folio-cover-media">
            {/* The uncropped preview, so the event's focal point picks the
                crop at every shape the cover takes. Decorative: the title
                below names the gallery. */}
            <AuthenticatedImage
              src={coverSrc}
              alt=""
              className="folio-cover-image"
              style={{ objectPosition: heroImageAnchor }}
              isGallery
              slug={slug}
              queuePriority="high"
            />
          </div>
        )}
        <div className="folio-cover-text">
          {formattedDate && <p className="folio-cover-date">{formattedDate}</p>}
          <h1 className="folio-cover-title">
            {title}
            <GallerySecondaryText kind="title" />
          </h1>
          {photos.length > 0 && (
            <button type="button" className="folio-cover-enter" onClick={scrollToPhotos}>
              {t('gallery.folio.viewGallery', 'View the gallery')}
              <ArrowDown className="w-4 h-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      <nav ref={navRef} className="folio-nav" aria-label={t('gallery.folio.navLabel', 'Gallery')}>
        <div className="folio-nav-row">
          <div className="folio-nav-start">
            {showBackToAccount && <BackToAccountLink className="folio-nav-btn folio-nav-back" />}
            <span className="folio-nav-label">{folio.studioLabel || title}</span>
          </div>
          <div className="folio-nav-actions">
            <PhotoSalesCartButton />
            {/* Guest upload: no gallery header here, which is where the
                other layouts offer it. The secondary actions (upload, copy
                filenames, manage, logout) stay in the row from 640 px and
                move into the menu at the end below that. */}
            {onUploadClick && (
              <button
                type="button"
                className="folio-nav-btn folio-nav-secondary"
                onClick={onUploadClick}
                aria-label={labels.upload}
                title={labels.upload}
                data-testid="folio-nav-upload"
                // The control a remount hands focus to (PhotoGridWithLayouts)
                // must be one on screen: on a phone that is the menu.
                data-gallery-focus={wideNav ? 'upload' : undefined}
              >
                <Upload className="w-[18px] h-[18px]" />
              </button>
            )}
            {canSelect && (
              <button
                type="button"
                className={`folio-nav-btn${isSelectionMode ? ' is-active' : ''}`}
                onClick={toggleSelectionMode}
                aria-pressed={isSelectionMode}
                aria-label={labels.select}
                title={labels.select}
                data-testid="folio-nav-select"
              >
                <CheckSquare className="w-[18px] h-[18px]" />
              </button>
            )}
            {likesAllowed && (
              <LikedNavButton
                className="folio-nav-btn"
                activeClassName="is-active"
                countClassName="folio-nav-count"
                iconClassName="w-[18px] h-[18px]"
                // Not "Favorites": here those are the lightbox's bookmarks.
                title={t('gallery.showLikedOnly', 'Show only photos I liked')}
                testId="folio-nav-liked"
                likedOnly={likedOnly}
                onToggleLikedOnly={onToggleLikedOnly}
                likedCount={likedPhotoIds.size}
              />
            )}
            {onCopyFilenames && copyFilenamesCount > 0 && (
              <button
                type="button"
                className="folio-nav-btn folio-nav-secondary"
                onClick={onCopyFilenames}
                aria-label={labels.copyFilenames}
                title={labels.copyFilenames}
                data-testid="folio-nav-copy-filenames"
              >
                <ClipboardList className="w-[18px] h-[18px]" aria-hidden="true" />
              </button>
            )}
            {canDownloadAll && (
              <button
                type="button"
                className="folio-nav-btn folio-nav-download"
                onClick={() => { void downloadAll(); }}
                aria-label={labels.downloadAll}
                title={labels.downloadAll}
                data-testid="folio-nav-download-all"
              >
                <Download className="w-[18px] h-[18px]" aria-hidden="true" />
                <span className="folio-nav-download-label" aria-hidden="true">{t('common.download', 'Download')}</span>
              </button>
            )}
            {onManageGallery && (
              <button
                type="button"
                className="folio-nav-btn folio-nav-secondary"
                onClick={onManageGallery}
                disabled={clientModeBusy}
                aria-label={labels.manage}
                title={labels.manage}
              >
                <Shield className="w-[18px] h-[18px]" />
              </button>
            )}
            {/* Secondary on purpose: last, quieter, and set apart. */}
            {onLogout && (
              <button
                type="button"
                className="folio-nav-btn folio-nav-secondary folio-nav-logout"
                onClick={onLogout}
                aria-label={t('common.logout', 'Logout')}
                title={t('common.logout', 'Logout')}
              >
                <LogOut className="w-[18px] h-[18px]" aria-hidden="true" />
              </button>
            )}
            <ActionMenu
              className="folio-nav-more"
              items={secondaryActions}
              triggerProps={!wideNav && onUploadClick ? { 'data-gallery-focus': 'upload' } : undefined}
            />
          </div>
        </div>

        {/* Selection (issue 1716): a second row of the sticky nav. Download
            goes through the container's handler, so the resolution picker
            and the download limit apply as everywhere else. */}
        {isSelectionMode && selectionAvailable && (
          <div className="folio-selection" role="region" aria-label={selectLabel(t, hasVideos)}>
            <span className="folio-selection-count" aria-live="polite">
              {t('gallery.photosSelected', { count: selected.size })}
            </span>
            <div className="folio-selection-actions">
              <button type="button" className="folio-pill" onClick={selectAllVisible}>
                {allVisibleSelected ? t('gallery.deselectAll', 'Deselect All') : t('gallery.selectAll', 'Select All')}
              </button>
              {ratingsAllowed && selected.size > 0 && (
                <BulkRatingPopover
                  slug={slug}
                  photoIds={Array.from(selected)}
                  requireNameEmail={feedbackOptions?.requireNameEmail}
                  className="folio-rate"
                  triggerClassName="folio-pill"
                  popoverClassName="folio-rate-popover"
                >
                  <span className="hidden sm:inline">{t('feedback.rateSelected', 'Rate selected')}</span>
                </BulkRatingPopover>
              )}
              {allowDownloads && onDownloadSelected && selected.size > 0 && (
                <button
                  type="button"
                  className="folio-pill folio-pill--primary"
                  onClick={() => { void onDownloadSelected(); }}
                  disabled={!downloadQuota.allows(selectedPhotoList)}
                  data-testid="folio-download-selected"
                >
                  <Package className="w-3.5 h-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">{t('gallery.downloadSelected', { count: selected.size })}</span>
                  <span className="sm:hidden">{t('common.download', 'Download')} ({selected.size})</span>
                </button>
              )}
              <button
                type="button"
                className="folio-pill"
                onClick={toggleSelectionMode}
                aria-label={t('gallery.cancelSelection', 'Cancel Selection')}
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">{t('common.cancel', 'Cancel')}</span>
              </button>
            </div>
          </div>
        )}
      </nav>

      <main ref={mainRef} className="folio-main" tabIndex={-1}>
        {(welcomeMessage || secondaryWelcome) && (
          <p className="folio-intro">{welcomeMessage}<GallerySecondaryText kind="welcome" /></p>
        )}
        {toolbar && <div className="folio-toolbar">{toolbar}</div>}
        {/* Download limit (issue 1560): the client's counter, or a guest's
            preview-size note. */}
        {allowDownloads && (downloadQuota.limited || downloadQuota.previewOnly) && (
          <div className="folio-quota"><DownloadQuotaNotice /></div>
        )}
        {photos.length === 0 && emptyIsFiltered && (
          <div className="folio-empty">
            {likedOnly
              ? <LikedOnlyEmptyMessage onShowAll={onToggleLikedOnly} />
              : <GalleryEmptyMessage filtered />}
          </div>
        )}
        {photos.length > 0 && (largeGallery ? (
          <PremiumWindowedAlbum
            photos={albumPhotos}
            renderTile={renderTile}
            columns={albumColumns}
            spacing={gap}
            tileClassName="folio-tile"
          />
        ) : (
          <MasonryPhotoAlbum
            photos={albumPhotos}
            render={{ photo: (_props, context) => renderTile(context) }}
            columns={albumColumns}
            spacing={gap}
          />
        ))}
      </main>

      {afterGrid && <div className="folio-after-grid">{afterGrid}</div>}

      <footer className="folio-footer">
        <p className="folio-footer-label">{folio.studioLabel || title}</p>
        <button type="button" className="folio-footer-top" onClick={scrollToTop}>
          {t('gallery.folio.backToTop', 'Back to top')}
        </button>
        <PoweredBy />
      </footer>
    </div>
  );
};
