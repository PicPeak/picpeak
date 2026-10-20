import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { GalleryEmptyMessage } from './GalleryEmptyMessage';
import { toast as toastify } from 'react-toastify';
import { useTranslation } from 'react-i18next';

import type { Photo, DownloadResolutionChoice, GalleryPerson } from '../../types';
import { useDownloadPhoto } from '../../hooks/useGallery';
import { isPhotoDownloadPending } from '../../hooks/usePhotoDownloadPending';
import { PhotoLightbox } from './PhotoLightbox';
import { DownloadResolutionModal } from './DownloadResolutionModal';
import { galleryService } from '../../services/gallery.service';
import { analyticsService } from '../../services/analytics.service';
import { useTheme } from '../../contexts/ThemeContext';
import { useDownloadQuota } from '../../contexts/DownloadQuotaContext';
import { useDownloadChoice } from '../../contexts/DownloadChoiceContext';
import { isDownloadLimitError, isSelectionTooLargeError, showDownloadLimitReached, type QuotaPhoto } from '../../utils/downloadLimit';
import type { LightboxPhotoChangeHandler } from './photoLink';

// Import all layouts
import {
  GridGalleryLayout,
  MasonryGalleryLayout,
  CarouselGalleryLayout,
  TimelineGalleryLayout,
  MosaicGalleryLayout,
  GalleryPremiumLayout,
  GalleryStoryLayout,
} from './layouts';
import { HeroHeader } from './HeroHeader';
import type { HeaderStyleType, HeroDividerStyle } from '../../types/theme.types';

interface PhotoGridWithLayoutsProps {
  photos: Photo[];
  slug: string;
  categoryId?: number | string | null;
  // When provided, the hero layout will use this photo
  // instead of deriving from the filtered photo list.
  heroPhotoOverride?: Photo | null;
  isSelectionMode?: boolean;
  selectedPhotos?: Set<number>;
  onSelectionChange?: (photos: Set<number>) => void;
  onToggleSelectionMode?: () => void;
  eventName?: string;
  eventLogo?: string | null;
  eventDate?: string | null;
  expiresAt?: string | null;
  feedbackEnabled?: boolean;
  allowDownloads?: boolean;
  // Resolution picker choices (#858). Empty/absent = no picker, download
  // straight at the gallery's standard size.
  downloadChoices?: DownloadResolutionChoice[];
  downloadStandard?: string;
  protectionLevel?: 'basic' | 'standard' | 'enhanced' | 'maximum';
  useEnhancedProtection?: boolean;
  useCanvasRendering?: boolean;
  disableRightClick?: boolean;
  enableDevtoolsProtection?: boolean;
  feedbackOptions?: {
    allowLikes?: boolean;
    allowFavorites?: boolean;
    allowRatings?: boolean;
    allowComments?: boolean;
    allowReactions?: boolean;
    requireNameEmail?: boolean;
  };
  onFeedbackChange?: (toggledPhotoId?: number) => void;
  // Hero logo customization options
  heroLogoVisible?: boolean;
  heroLogoSize?: 'small' | 'medium' | 'large' | 'xlarge';
  heroLogoPosition?: 'top' | 'center' | 'bottom';
  // Header style (decoupled from layout)
  headerStyle?: HeaderStyleType;
  heroDividerStyle?: HeroDividerStyle;
  // Hero image anchor position (#162) – keyword or "X% Y%" focal point
  heroImageAnchor?: string;
  // Welcome message (per-event) for layouts that display it
  welcomeMessage?: string;
  // Logout callback for full-page layouts
  onLogout?: () => void;
  // Guest upload for full-page layouts (they have no gallery header)
  onUploadClick?: () => void;
  // Client visibility controls (#172)
  isClient?: boolean;
  onToggleVisibility?: (photoId: number, currentVisibility: string) => void;
  // Mirror of the admin original-filename toggle (#508). When true, the
  // lightbox bottom toolbar surfaces each photo's original camera name.
  showOriginalFilename?: boolean;
  // People in this gallery (#1074) — forwarded to the lightbox so it can
  // show "In this photo: …". Undefined when the feature is off.
  people?: GalleryPerson[];
  onSelectPerson?: (personId: number) => void;
  /**
   * Suppress the "no photos found" message (#1160). A gallery whose photos all
   * live in folders has an empty root grid while its folder tiles sit directly
   * above — printing "no photos" there contradicts the tiles. Only the message
   * is suppressed: the full-page layouts render their hero, title, logout and
   * download controls from inside this component, so unmounting it would strip
   * the whole gallery shell.
   */
  suppressEmptyState?: boolean;
  /** The scope has photos, but the search or filters leave none on screen. */
  emptyIsFiltered?: boolean;
  /** #1160: event-wide count + whole-gallery download for layout chrome. */
  eventPhotoCount?: number;
  onDownloadEverything?: () => void;
  // Copyable filename list (issue 1733, A3d): the selection, or the viewer's
  // favourites when nothing is selected. Hidden at zero. The full-page
  // layouts render the button; the others get it from the gallery toolbar.
  onCopyFilenames?: () => void;
  copyFilenamesCount?: number;
  /** Premium / Story nav heart — see BaseGalleryLayoutProps. */
  likedOnly?: boolean;
  onToggleLikedOnly?: () => void;
  /** Link to a single photo (issue 1733) — see BaseGalleryLayoutProps. */
  openPhotoId?: number | null;
  /** After the photos, before a full-page layout's footer (issue 1562). */
  afterGrid?: React.ReactNode;
  onLightboxPhotoChange?: LightboxPhotoChangeHandler;
  /**
   * The container's event-wide id lookup, so the download limit prices the
   * whole selection: a search or filter applied after selecting hides
   * photos, it does not unselect them, and they are still downloaded.
   */
  photosForIds?: (ids: number[]) => QuotaPhoto[];
}

export const PhotoGridWithLayouts: React.FC<PhotoGridWithLayoutsProps> = ({
  photos,
  suppressEmptyState = false,
  emptyIsFiltered = false,
  eventPhotoCount,
  onDownloadEverything,
  onCopyFilenames,
  copyFilenamesCount = 0,
  likedOnly = false,
  onToggleLikedOnly,
  openPhotoId,
  onLightboxPhotoChange,
  photosForIds,
  afterGrid,
  slug,
  categoryId,
  heroPhotoOverride,
  isSelectionMode: parentSelectionMode,
  selectedPhotos: parentSelectedPhotos,
  feedbackEnabled,
  feedbackOptions,
  onFeedbackChange,
  allowDownloads = true,
  downloadChoices,
  downloadStandard,
  protectionLevel = 'standard',
  useEnhancedProtection = false,
  useCanvasRendering = false,
  disableRightClick = false,
  enableDevtoolsProtection = false,
  onSelectionChange,
  onToggleSelectionMode: parentToggleSelectionMode,
  eventName,
  eventLogo,
  eventDate,
  expiresAt,
  heroLogoVisible = true,
  heroLogoSize = 'medium',
  heroLogoPosition = 'top',
  headerStyle,
  heroDividerStyle = 'wave',
  heroImageAnchor = 'center',
  welcomeMessage,
  onLogout,
  onUploadClick,
  isClient = false,
  onToggleVisibility,
  showOriginalFilename = false,
  people,
  onSelectPerson,
}) => {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState<number | null>(null);
  const [openFeedbackInitially, setOpenFeedbackInitially] = useState<boolean>(false);
  const [localSelectedPhotos, setLocalSelectedPhotos] = useState<Set<number>>(new Set());
  const [localSelectionMode, setLocalSelectionMode] = useState(false);
  // Non-null while the resolution picker is open (#858); holds the ids it applies to.
  const [resolutionPickerIds, setResolutionPickerIds] = useState<number[] | null>(null);
  const downloadPhotoMutation = useDownloadPhoto();
  
  // Use parent state if provided, otherwise use local state
  const selectedPhotos = parentSelectedPhotos ?? localSelectedPhotos;
  const isSelectionMode = parentSelectionMode ?? localSelectionMode;
  const setSelectedPhotos = onSelectionChange ?? setLocalSelectedPhotos;
  const toggleSelectionMode = parentToggleSelectionMode ?? (() => setLocalSelectionMode(!localSelectionMode));

  // Clear selection when category changes
  useEffect(() => {
    setSelectedPhotos(new Set());
  }, [categoryId, setSelectedPhotos]);

  // The photo a layout-owned lightbox (Gallery Premium / Story) is on, as it
  // reports it; null while that lightbox is closed.
  const lightboxPhotoIdRef = useRef<number | null>(null);

  const handlePhotoClick = (index: number) => {
    setOpenFeedbackInitially(false);
    setSelectedPhotoIndex(index);
    if (photos[index]) onLightboxPhotoChange?.(photos[index].id, 'open');
  };

  const handleOpenWithFeedback = (index: number) => {
    setOpenFeedbackInitially(true);
    setSelectedPhotoIndex(index);
    if (photos[index]) onLightboxPhotoChange?.(photos[index].id, 'open');
  };

  const handleLightboxClose = () => {
    setSelectedPhotoIndex(null);
    onLightboxPhotoChange?.(null, 'close');
  };

  // Gallery Premium and Gallery Story mount their own lightbox and report
  // its moves through this wrapper, so the id it is on is known here too.
  const layoutOwnsLightbox = theme.galleryLayout === 'gallery-premium' || theme.galleryLayout === 'gallery-story';
  // Premium and Story render their own empty state; the key remounts them
  // when the list empties or fills, so their own lightbox state goes with it
  // as it did when this component returned its empty message instead.
  const layoutKey = layoutOwnsLightbox && photos.length === 0 ? 'empty' : 'photos';
  // The remount drops whatever had focus in the old layout: the empty
  // state's upload button once the first upload's refetch fills the gallery.
  // A control marked `data-gallery-focus="<role>"` hands focus to the new
  // layout's control with the same role rather than to <body>. Read during
  // render, while the old layout (and the focused control) is still in the
  // document.
  const renderedLayoutKeyRef = useRef(layoutKey);
  const refocusRoleRef = useRef<string | null>(null);
  if (renderedLayoutKeyRef.current !== layoutKey) {
    renderedLayoutKeyRef.current = layoutKey;
    refocusRoleRef.current = (document.activeElement as HTMLElement | null)
      ?.closest?.('[data-gallery-focus]')?.getAttribute('data-gallery-focus') ?? null;
  }
  useEffect(() => {
    const role = refocusRoleRef.current;
    if (!role) return;
    refocusRoleRef.current = null;
    document.querySelector<HTMLElement>(`[data-gallery-focus="${role}"]`)?.focus();
  }, [layoutKey]);
  const reportLayoutLightbox: LightboxPhotoChangeHandler = (photoId, reason) => {
    lightboxPhotoIdRef.current = reason === 'close' ? null : photoId;
    onLightboxPhotoChange?.(photoId, reason);
  };

  // The list emptied under an open lightbox (unliking the last Liked photo,
  // a filter change): this component returns its empty state, or remounts
  // a full-page layout into its own, and the lightbox unmounts without a close, leaving
  // `?photo=` and the pushed history entry behind. Report the close here.
  // Only the EMPTY list: while photos remain, the lightbox clamps onto a
  // neighbour in an effect of its own and reports that step a render later;
  // closing from here first would shut it on a list that still has photos.
  useEffect(() => {
    if (photos.length > 0) return;
    if (layoutOwnsLightbox) {
      if (lightboxPhotoIdRef.current === null) return;
      lightboxPhotoIdRef.current = null;
      onLightboxPhotoChange?.(null, 'close');
      return;
    }
    if (selectedPhotoIndex === null) return;
    handleLightboxClose();
    // handleLightboxClose is recreated every render; the inputs that matter
    // are the list and whether a lightbox is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos, selectedPhotoIndex, layoutOwnsLightbox]);

  // Link to a single photo (issue 1733): the URL asks for a photo — open on
  // it, or close on null. Only against `photos`, the list this viewer sees;
  // an id not in it opens nothing. Re-runs when the list changes so a deep
  // link resolves once the container has switched folder or cleared filters.
  useEffect(() => {
    if (openPhotoId === undefined) return;
    if (openPhotoId === null) {
      setSelectedPhotoIndex(null);
      return;
    }
    const index = photos.findIndex((photo) => photo.id === openPhotoId);
    if (index >= 0) {
      setOpenFeedbackInitially(false);
      setSelectedPhotoIndex(index);
    }
  }, [openPhotoId, photos]);

  const handlePhotoSelect = (photoId: number) => {
    // Auto-enable selection mode when selecting via checkbox
    if (!isSelectionMode) {
      if (parentToggleSelectionMode) {
        parentToggleSelectionMode();
      } else {
        setLocalSelectionMode(true);
      }
    }
    const newSelected = new Set(selectedPhotos);
    if (newSelected.has(photoId)) {
      newSelected.delete(photoId);
    } else {
      newSelected.add(photoId);
    }
    setSelectedPhotos(newSelected);
  };

  // Download limit (issue 1560).
  const downloadQuota = useDownloadQuota();
  const downloadChoice = useDownloadChoice();
  // Priced by id, not by what is on screen: the selection can hold photos a
  // search hides, and the download sends them all. Without the container's
  // lookup, an id this list lacks counts as a new download.
  const quotaPhotosFor = useCallback((ids: number[]): QuotaPhoto[] => {
    if (photosForIds) return photosForIds(ids);
    const byId = new Map(photos.map((photo) => [photo.id, photo]));
    return ids.map((id) => byId.get(id) ?? { id });
  }, [photos, photosForIds]);
  const selectedPhotoList = useMemo(
    () => quotaPhotosFor(Array.from(selectedPhotos)),
    [quotaPhotosFor, selectedPhotos]
  );

  const handleDownload = (photo: Photo, e: React.MouseEvent) => {
    e.stopPropagation();
    // Issue 2043: a repeated tap while this photo is still being prepared.
    if (isPhotoDownloadPending(photo.id)) return;
    // Download limit (issue 1560): say why instead of sending a request the
    // server is bound to refuse.
    if (!downloadQuota.canDownload(photo)) {
      showDownloadLimitReached({ remaining: 0 });
      return;
    }

    // The download menu (issue 1733, E2) asks for a size first where the
    // gallery offers one.
    downloadChoice.choose(photo, (resolution) => {
      // Track individual photo download
      analyticsService.trackDownload(photo.id, slug, false);

      downloadPhotoMutation.mutate({
        slug,
        photoId: photo.id,
        filename: photo.filename,
        resolution,
      });
    });
  };


  const selectAll = () => {
    setSelectedPhotos(new Set(photos.map(p => p.id)));
  };

  // Issue 1716: a layout's own "select all" over the photos it currently
  // shows (a search may hide some), in one write.
  const selectMany = (photoIds: number[]) => {
    if (!isSelectionMode) {
      if (parentToggleSelectionMode) parentToggleSelectionMode();
      else setLocalSelectionMode(true);
    }
    setSelectedPhotos(new Set([...selectedPhotos, ...photoIds]));
  };

  const deselectAll = () => {
    setSelectedPhotos(new Set());
  };

  const handleDownloadSelected = async () => {
    if (selectedPhotos.size === 0) return;
    const ids = Array.from(selectedPhotos);
    // Download limit (issue 1560): the selection stays, so the guest can
    // trim it to what is left.
    if (!downloadQuota.allows(selectedPhotoList)) {
      showDownloadLimitReached({ remaining: downloadQuota.remaining ?? 0 });
      return;
    }

    // Resolution picker (#858): when the gallery offers a choice, hand off to
    // the modal — it drives the job build and does the download itself.
    if (downloadChoices && downloadChoices.length > 1) {
      setResolutionPickerIds(ids);
      return;
    }

    toastify.info(t('gallery.downloading', { count: ids.length }));

    // Over the server's per-download cap the selection stays too, to trim.
    let keepSelection = false;
    try {
      await galleryService.downloadSelectedPhotos(slug, ids);
      analyticsService.trackGalleryEvent('bulk_download', { gallery: slug, photo_count: ids.length });
    } catch (error) {
      // A download-limit refusal keeps the selection, as the pre-check
      // above does, so the guest can trim it to what is left; so does a
      // selection over the server's per-download cap.
      keepSelection = isDownloadLimitError(error) || isSelectionTooLargeError(error);
      if (!isDownloadLimitError(error)) toastify.error(t('gallery.downloadError'));
    } finally {
      if (!keepSelection) {
        setSelectedPhotos(new Set());
        if (parentToggleSelectionMode) {
          parentToggleSelectionMode();
        } else {
          setLocalSelectionMode(false);
        }
      }
    }
  };

  // Premium and Story render their own empty state (with the upload button
  // and their way back from a filter), so only the other layouts stop here.
  if (photos.length === 0 && !layoutOwnsLightbox) {
    // Suppressed (#1160): a folder-only root has folder tiles above proving the
    // gallery isn't empty, so the message would contradict them.
    if (!suppressEmptyState) {
      return (
        <div className="text-center py-12">
          <GalleryEmptyMessage filtered={emptyIsFiltered} />
        </div>
      );
    }
  }

  // Get the current layout from theme
  const galleryLayout = theme.galleryLayout || 'grid';
  
  // Select the appropriate layout component
  const layoutProps = {
    photos,
    // Forwarded so the full-bleed layouts, which render their OWN
    // noPhotosFound return, don't contradict the folder tiles above them on a
    // folder-only root (#1160).
    suppressEmptyState,
    emptyIsFiltered,
    eventPhotoCount,
    onDownloadEverything,
    onCopyFilenames,
    copyFilenamesCount,
    likedOnly,
    onToggleLikedOnly,
    afterGrid,
    slug,
    // Face data (#1074) must reach the full-page layouts too — they render
    // their OWN lightbox rather than the one below, so without this the
    // "In this photo" chips silently vanish on gallery-premium and
    // gallery-story even when the feature is fully enabled.
    people,
    onSelectPerson,
    // Full-page layouts own their bulk-download control, so the resolution
    // picker has to reach them too (#858) — otherwise premium/story galleries
    // silently skip the choice the admin enabled.
    downloadChoices,
    onPickResolution: (ids: number[]) => setResolutionPickerIds(ids),
    onPhotoClick: handlePhotoClick,
    onOpenPhotoWithFeedback: handleOpenWithFeedback,
    // Link to a single photo (issue 1733): the full-page layouts mount their
    // own lightbox, so the URL contract has to reach them as well.
    openPhotoId,
    onLightboxPhotoChange: reportLayoutLightbox,
    onFeedbackChange: onFeedbackChange,
    onDownload: handleDownload,
    heroPhotoOverride,
    // Issue 1709: the Story layout reads its grid mode from the theme's
    // gallerySettings, defaulting to the original fixed tiles.
    storyGridMode: theme.gallerySettings?.storyGridMode,
    storyShowFilenames: theme.gallerySettings?.storyShowFilenames === true,
    storyFooterTitle: theme.gallerySettings?.storyFooterTitle,
    storyFooterText: theme.gallerySettings?.storyFooterText,
    selectedPhotos,
    allowDownloads,
    protectionLevel,
    useEnhancedProtection,
    useCanvasRendering,
    isSelectionMode,
    onPhotoSelect: handlePhotoSelect,
    onSelectAll: selectAll,
    onDeselectAll: deselectAll,
    // Issue 1716: the Story layout renders its own selection controls and
    // must drive the same mode, selection and download path as this toolbar.
    onToggleSelectionMode: toggleSelectionMode,
    onSelectMany: selectMany,
    onDownloadSelected: handleDownloadSelected,
    selectionQuotaPhotos: selectedPhotoList,
    eventName,
    eventLogo,
    eventDate,
    expiresAt,
    feedbackEnabled,
    feedbackOptions,
    heroLogoVisible,
    heroLogoSize,
    heroLogoPosition,
    welcomeMessage,
    onLogout,
    onUploadClick,
    isClient,
    onToggleVisibility,
    showOriginalFilename,
  };

  // Determine if we should show hero header (decoupled from layout)
  const effectiveHeaderStyle = headerStyle || theme.headerStyle;
  const showHeroHeader = effectiveHeaderStyle === 'hero';

  let LayoutComponent;
  switch (galleryLayout) {
    case 'masonry':
      LayoutComponent = MasonryGalleryLayout;
      break;
    case 'carousel':
      LayoutComponent = CarouselGalleryLayout;
      break;
    case 'timeline':
      LayoutComponent = TimelineGalleryLayout;
      break;
    case 'mosaic':
      LayoutComponent = MosaicGalleryLayout;
      break;
    case 'gallery-premium':
      LayoutComponent = GalleryPremiumLayout;
      break;
    case 'gallery-story':
      LayoutComponent = GalleryStoryLayout;
      break;
    default:
      LayoutComponent = GridGalleryLayout;
  }

  // Gallery Premium and Gallery Story layouts have their own integrated hero/header
  const isFullPageLayout = galleryLayout === 'gallery-premium' || galleryLayout === 'gallery-story';

  return (
    <>
      {/* Hero Header - shown when headerStyle is 'hero' (skip for full-page layouts with integrated hero) */}
      {showHeroHeader && !isFullPageLayout && (
        <HeroHeader
          photos={photos}
          slug={slug}
          eventName={eventName}
          eventLogo={eventLogo}
          eventDate={eventDate}
          expiresAt={expiresAt}
          heroPhotoOverride={heroPhotoOverride}
          heroLogoVisible={heroLogoVisible}
          heroLogoSize={heroLogoSize}
          heroLogoPosition={heroLogoPosition}
          dividerStyle={heroDividerStyle}
          allowDownloads={allowDownloads}
          useEnhancedProtection={useEnhancedProtection}
          heroImageAnchor={heroImageAnchor}
        />
      )}

      {/* Welcome Message - shown for non-fullpage layouts when set */}
      {!isFullPageLayout && welcomeMessage && (
        <div className="mb-6 px-4 py-3 rounded-lg bg-card-theme/50 border border-border-theme text-center">
          <p className="text-sm text-muted-theme whitespace-pre-line">{welcomeMessage}</p>
        </div>
      )}

      {/* Render the selected layout, keyed by `layoutKey` (see above). */}
      <LayoutComponent key={layoutKey} {...layoutProps} />
      {/* Full-page layouts place it themselves, ahead of their footer. */}
      {!isFullPageLayout && afterGrid}

      {/* Lightbox - skip for full-page layouts which have their own lightbox */}
      {selectedPhotoIndex !== null && !isFullPageLayout && (
        <PhotoLightbox
          photos={photos}
          initialIndex={selectedPhotoIndex}
          onClose={handleLightboxClose}
          slug={slug}
          feedbackEnabled={feedbackEnabled || false}
          allowDownloads={allowDownloads}
          protectionLevel={protectionLevel}
          useEnhancedProtection={useEnhancedProtection}
          useCanvasRendering={useCanvasRendering}
          disableRightClick={disableRightClick}
          enableDevtoolsProtection={enableDevtoolsProtection}
          initialShowFeedback={openFeedbackInitially}
          onFeedbackChange={onFeedbackChange}
          showOriginalFilename={showOriginalFilename}
          people={people}
          onSelectPerson={onSelectPerson}
          onCurrentPhotoChange={(photoId) => onLightboxPhotoChange?.(photoId, 'step')}
        />
      )}

      {/* Download size picker (#858) — drives the job build and the download. */}
      {resolutionPickerIds && downloadChoices && (
        <DownloadResolutionModal
          slug={slug}
          choices={downloadChoices}
          standardResolution={downloadStandard}
          photoIds={resolutionPickerIds}
          quotaPhotos={quotaPhotosFor(resolutionPickerIds)}
          onClose={() => setResolutionPickerIds(null)}
          // Only a download handed over ends the selection. Cancelling, a
          // failed build or a download-limit refusal keeps it to retry or
          // trim, as the direct download path does.
          onDownloaded={() => {
            setSelectedPhotos(new Set());
            // A layout's Download All opens the picker outside selection
            // mode too; the parent's toggle would switch it on.
            if (!isSelectionMode) return;
            if (parentToggleSelectionMode) {
              parentToggleSelectionMode();
            } else {
              setLocalSelectionMode(false);
            }
          }}
        />
      )}
    </>
  );
};
