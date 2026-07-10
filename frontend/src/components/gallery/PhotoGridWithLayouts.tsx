import React, { useState, useEffect } from 'react';
import { Package } from 'lucide-react';
import { toast as toastify } from 'react-toastify';
import { useTranslation } from 'react-i18next';

import type { Photo } from '../../types';
import { useDownloadPhoto } from '../../hooks/useGallery';
import { PhotoLightbox } from './PhotoLightbox';
import { Button } from '../common';
import { galleryService } from '../../services/gallery.service';
import { analyticsService } from '../../services/analytics.service';
import { useTheme } from '../../contexts/ThemeContext';

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
  showSelectionControls?: boolean;
  eventName?: string;
  eventLogo?: string | null;
  eventDate?: string | null;
  expiresAt?: string | null;
  feedbackEnabled?: boolean;
  allowDownloads?: boolean;
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
    requireNameEmail?: boolean;
  };
  onFeedbackChange?: () => void;
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
  // Client visibility controls (#172)
  isClient?: boolean;
  onToggleVisibility?: (photoId: number, currentVisibility: string) => void;
  // Mirror of the admin original-filename toggle (#508). When true, the
  // lightbox bottom toolbar surfaces each photo's original camera name.
  showOriginalFilename?: boolean;
}

export const PhotoGridWithLayouts: React.FC<PhotoGridWithLayoutsProps> = ({
  photos,
  slug,
  categoryId,
  heroPhotoOverride,
  isSelectionMode: parentSelectionMode,
  selectedPhotos: parentSelectedPhotos,
  feedbackEnabled,
  feedbackOptions,
  onFeedbackChange,
  allowDownloads = true,
  protectionLevel = 'standard',
  useEnhancedProtection = false,
  useCanvasRendering = false,
  disableRightClick = false,
  enableDevtoolsProtection = false,
  onSelectionChange,
  onToggleSelectionMode: parentToggleSelectionMode,
  showSelectionControls = true,
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
  isClient = false,
  onToggleVisibility,
  showOriginalFilename = false,
}) => {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState<number | null>(null);
  const [openFeedbackInitially, setOpenFeedbackInitially] = useState<boolean>(false);
  const [localSelectedPhotos, setLocalSelectedPhotos] = useState<Set<number>>(new Set());
  const [localSelectionMode, setLocalSelectionMode] = useState(false);
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

  const handlePhotoClick = (index: number) => {
    setOpenFeedbackInitially(false);
    setSelectedPhotoIndex(index);
  };

  const handleOpenWithFeedback = (index: number) => {
    setOpenFeedbackInitially(true);
    setSelectedPhotoIndex(index);
  };

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

  const handleDownload = (photo: Photo, e: React.MouseEvent) => {
    e.stopPropagation();
    
    // Track individual photo download
    analyticsService.trackDownload(photo.id, slug, false);
    
    downloadPhotoMutation.mutate({
      slug,
      photoId: photo.id,
      filename: photo.filename,
    });
  };


  const selectAll = () => {
    setSelectedPhotos(new Set(photos.map(p => p.id)));
  };

  const deselectAll = () => {
    setSelectedPhotos(new Set());
  };

  const handleDownloadSelected = async () => {
    if (selectedPhotos.size === 0) return;
    const ids = Array.from(selectedPhotos);
    toastify.info(t('gallery.downloading', { count: ids.length }));

    try {
      await galleryService.downloadSelectedPhotos(slug, ids);
      analyticsService.trackGalleryEvent('bulk_download', { gallery: slug, photo_count: ids.length });
    } catch {
      toastify.error(t('gallery.downloadError'));
    } finally {
      setSelectedPhotos(new Set());
      if (parentToggleSelectionMode) {
        parentToggleSelectionMode();
      } else {
        setLocalSelectionMode(false);
      }
    }
  };

  if (photos.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-theme">{t('gallery.noPhotosFound')}</p>
      </div>
    );
  }

  // Get the current layout from theme
  const galleryLayout = theme.galleryLayout || 'grid';
  
  // Select the appropriate layout component
  const layoutProps = {
    photos,
    slug,
    onPhotoClick: handlePhotoClick,
    onOpenPhotoWithFeedback: handleOpenWithFeedback,
    onFeedbackChange: onFeedbackChange,
    onDownload: handleDownload,
    heroPhotoOverride,
    selectedPhotos,
    allowDownloads,
    protectionLevel,
    useEnhancedProtection,
    useCanvasRendering,
    isSelectionMode,
    onPhotoSelect: handlePhotoSelect,
    onSelectAll: selectAll,
    onDeselectAll: deselectAll,
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
          protectionLevel={protectionLevel}
          useEnhancedProtection={useEnhancedProtection}
          useCanvasRendering={useCanvasRendering}
          heroImageAnchor={heroImageAnchor}
        />
      )}

      {/* Welcome Message - shown for non-fullpage layouts when set */}
      {!isFullPageLayout && welcomeMessage && (
        <div className="mb-6 px-4 py-3 rounded-lg bg-card-theme/50 border border-border-theme text-center">
          <p className="text-sm text-muted-theme whitespace-pre-line">{welcomeMessage}</p>
        </div>
      )}

      {/* Selection Mode Controls - Not shown for carousel, full-page layouts, or when controls are hidden */}
      {showSelectionControls && photos.length > 1 && galleryLayout !== 'carousel' && !isFullPageLayout && (
        <div className="mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={toggleSelectionMode}
              title={t('gallery.selectPhotosHint')}
              className="text-xs sm:text-sm"
            >
              {isSelectionMode ? t('gallery.cancelSelection') : t('gallery.selectPhotos')}
            </Button>
            {!isSelectionMode && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  toggleSelectionMode();
                  selectAll();
                }}
                className="text-xs sm:text-sm"
              >
                {t('gallery.selectAll')}
              </Button>
            )}
          </div>
          
          {isSelectionMode && (
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-3">
              <span className="text-xs sm:text-sm text-muted-theme">
                {t('gallery.photosSelected', { count: selectedPhotos.size })}
              </span>
              <div className="flex items-center gap-2 flex-wrap">
                <Button variant="ghost" size="sm" onClick={selectAll} className="text-xs sm:text-sm">
                  {t('gallery.selectAll')}
                </Button>
                <Button variant="ghost" size="sm" onClick={deselectAll} className="text-xs sm:text-sm">
                  {t('gallery.deselectAll')}
                </Button>
                {selectedPhotos.size > 0 && (
                  <Button
                    variant="primary"
                    size="sm"
                    leftIcon={<Package className="w-4 h-4" />}
                    onClick={handleDownloadSelected}
                    className="text-xs sm:text-sm"
                  >
                    <span className="hidden sm:inline">{t('gallery.downloadSelected', { count: selectedPhotos.size })}</span>
                    <span className="sm:hidden">{t('common.download')} ({selectedPhotos.size})</span>
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Render the selected layout */}
      <LayoutComponent {...layoutProps} />

      {/* Lightbox - skip for full-page layouts which have their own lightbox */}
      {selectedPhotoIndex !== null && !isFullPageLayout && (
        <PhotoLightbox
          photos={photos}
          initialIndex={selectedPhotoIndex}
          onClose={() => setSelectedPhotoIndex(null)}
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
        />
      )}
    </>
  );
};
