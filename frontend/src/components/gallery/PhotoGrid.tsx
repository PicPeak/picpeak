import React, { useState, useEffect } from 'react';
import { Download, Maximize2, Check, Package, MessageSquare, Star, Play } from 'lucide-react';
import { useInView } from 'react-intersection-observer';
import { toast as toastify } from 'react-toastify';
import { useTranslation } from 'react-i18next';

import type { Photo } from '../../types';
import { useDownloadPhoto } from '../../hooks/useGallery';
import { PhotoLightbox } from './PhotoLightbox';
import { Button, AuthenticatedImage } from '../common';
import { galleryService } from '../../services/gallery.service';
import { analyticsService } from '../../services/analytics.service';

interface PhotoGridProps {
  photos: Photo[];
  slug: string;
  categoryId?: number | null;
  feedbackEnabled?: boolean;
  allowDownloads?: boolean;
  protectionLevel?: 'basic' | 'standard' | 'enhanced' | 'maximum';
  useEnhancedProtection?: boolean;
  useCanvasRendering?: boolean;
  disableRightClick?: boolean;
  enableDevtoolsProtection?: boolean;
}

export const PhotoGrid: React.FC<PhotoGridProps> = ({
  photos,
  slug,
  categoryId,
  feedbackEnabled = false,
  allowDownloads = true,
  protectionLevel = 'standard',
  useEnhancedProtection = false,
  useCanvasRendering = false,
  disableRightClick = false,
  enableDevtoolsProtection = false
}) => {
  const { t } = useTranslation();
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState<number | null>(null);
  const [selectedPhotos, setSelectedPhotos] = useState<Set<number>>(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const downloadPhotoMutation = useDownloadPhoto();

  // Clear selection when category changes
  useEffect(() => {
    setSelectedPhotos(new Set());
  }, [categoryId]);

  const handlePhotoClick = (index: number, e?: React.MouseEvent) => {
    // Check for ctrl/cmd+click for quick selection
    if (e && (e.ctrlKey || e.metaKey)) {
      if (!isSelectionMode) {
        setIsSelectionMode(true);
      }
      const newSelected = new Set(selectedPhotos);
      if (newSelected.has(photos[index].id)) {
        newSelected.delete(photos[index].id);
      } else {
        newSelected.add(photos[index].id);
      }
      setSelectedPhotos(newSelected);
    } else if (isSelectionMode) {
      const newSelected = new Set(selectedPhotos);
      if (newSelected.has(photos[index].id)) {
        newSelected.delete(photos[index].id);
      } else {
        newSelected.add(photos[index].id);
      }
      setSelectedPhotos(newSelected);
    } else {
      setSelectedPhotoIndex(index);
    }
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

  const toggleSelectionMode = () => {
    setIsSelectionMode(!isSelectionMode);
    setSelectedPhotos(new Set());
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
    } catch (error) {
      toastify.error(t('gallery.downloadError'));
    } finally {
      setSelectedPhotos(new Set());
      setIsSelectionMode(false);
    }
  };

  if (photos.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-theme">{t('gallery.noPhotosFound')}</p>
      </div>
    );
  }

  return (
    <>
      {/* Selection Mode Controls */}
      {photos.length > 1 && (
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
                  setIsSelectionMode(true);
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

      {/* Photo Grid */}
      <div className="gallery-grid">
        {photos.map((photo, index) => (
          <PhotoThumbnail
            key={photo.id}
            photo={photo}
            isSelected={selectedPhotos.has(photo.id)}
            isSelectionMode={isSelectionMode}
            onClick={(e) => handlePhotoClick(index, e)}
            onDownload={(e) => handleDownload(photo, e)}
            allowDownloads={allowDownloads}
            protectionLevel={protectionLevel}
            useEnhancedProtection={useEnhancedProtection}
            useCanvasRendering={useCanvasRendering}
            slug={slug}
            feedbackEnabled={feedbackEnabled}
          />
        ))}
      </div>

      {/* Lightbox */}
      {selectedPhotoIndex !== null && (
        <PhotoLightbox
          photos={photos}
          initialIndex={selectedPhotoIndex}
          onClose={() => setSelectedPhotoIndex(null)}
          slug={slug}
          feedbackEnabled={feedbackEnabled}
          allowDownloads={allowDownloads}
          protectionLevel={protectionLevel}
          useEnhancedProtection={useEnhancedProtection}
          disableRightClick={disableRightClick}
          enableDevtoolsProtection={enableDevtoolsProtection}
        />
      )}
    </>
  );
};

interface PhotoThumbnailProps {
  photo: Photo;
  isSelected: boolean;
  isSelectionMode: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDownload: (e: React.MouseEvent) => void;
  allowDownloads?: boolean;
  protectionLevel?: 'basic' | 'standard' | 'enhanced' | 'maximum';
  useEnhancedProtection?: boolean;
  useCanvasRendering?: boolean;
  slug: string; // Add slug as required prop
  feedbackEnabled?: boolean;
}

const PhotoThumbnail: React.FC<PhotoThumbnailProps> = ({
  photo,
  isSelected,
  isSelectionMode,
  onClick,
  onDownload,
  allowDownloads = true,
  protectionLevel = 'standard',
  useEnhancedProtection = false,
  useCanvasRendering = false,
  slug,
  feedbackEnabled = false
}) => {
  const { ref, inView } = useInView({
    triggerOnce: true,
    threshold: 0.1,
  });

  return (
    <div
      ref={ref}
      className="relative group cursor-pointer aspect-square"
      onClick={(e) => onClick(e)}
    >
      {inView ? (
        <>
          <AuthenticatedImage
            src={photo.thumbnail_url || photo.url}
            alt={photo.filename}
            className="w-full h-full object-cover rounded-lg transition-transform duration-200 group-hover:scale-105"
            loading="lazy"
            isGallery={true}
            slug={slug}
            photoId={photo.id}
            requiresToken={photo.requires_token}
            secureUrlTemplate={photo.secure_url_template}
            protectFromDownload={!allowDownloads || useEnhancedProtection}
            protectionLevel={protectionLevel}
            useEnhancedProtection={useEnhancedProtection}
            useCanvasRendering={useCanvasRendering || protectionLevel === 'maximum'}
            fragmentGrid={protectionLevel === 'enhanced' || protectionLevel === 'maximum'}
            blockKeyboardShortcuts={useEnhancedProtection}
            detectPrintScreen={useEnhancedProtection}
            detectDevTools={protectionLevel === 'maximum'}
            watermarkText={useEnhancedProtection ? 'Protected' : undefined}
            onProtectionViolation={(violationType) => {
              // Track analytics
              if (typeof window !== 'undefined' && (window as any).umami) {
                (window as any).umami.track('thumbnail_protection_violation', {
                  photoId: photo.id,
                  violationType,
                  protectionLevel
                });
              }
            }}
          />
          
          {/* Feedback Indicators */}
          {feedbackEnabled && (photo.has_feedback || (photo.average_rating ?? 0) > 0 || (photo.comment_count ?? 0) > 0) && (
            <div className="absolute top-2 left-2 flex gap-1 z-10">
              {(photo.comment_count ?? 0) > 0 && (
                <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1" title={`${photo.comment_count ?? 0} comments`}>
                  <MessageSquare className="w-3.5 h-3.5 text-accent" fill="currentColor" />
                  <span className="text-xs font-medium text-muted-theme">{photo.comment_count ?? 0}</span>
                </div>
              )}
              {(photo.average_rating ?? 0) > 0 && (
                <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1" title={`Rating: ${Number(photo.average_rating ?? 0).toFixed(1)}`}>
                  <Star className="w-3.5 h-3.5 text-yellow-500" fill="currentColor" />
                  <span className="text-xs font-medium text-muted-theme">{Number(photo.average_rating ?? 0).toFixed(1)}</span>
                </div>
              )}
            </div>
          )}
          
          {/* Overlay on hover/tap - Always visible on mobile for better UX */}
          <div className="absolute inset-0 bg-black/40 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-200 rounded-lg flex items-center justify-center gap-2">
            {!isSelectionMode && (
              <>
                <button
                  className="p-2 sm:p-2 bg-white/90 rounded-full hover:bg-white transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClick(e);
                  }}
                  aria-label="View full size"
                >
                  <Maximize2 className="w-5 h-5 text-theme" />
                </button>
                {allowDownloads && (
                  <button
                    className="p-2 sm:p-2 bg-white/90 rounded-full hover:bg-white transition-colors"
                    onClick={onDownload}
                    aria-label="Download photo"
                  >
                    <Download className="w-5 h-5 text-theme" />
                  </button>
                )}
              </>
            )}
          </div>

          {/* Selection checkbox - Larger on mobile for easier tapping */}
          {isSelectionMode && (
            <div className={`absolute top-2 right-2 ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 sm:opacity-0 sm:group-hover:opacity-100'} transition-opacity`}>
              <div className={`w-7 h-7 sm:w-6 sm:h-6 rounded-full border-2 ${isSelected ? 'bg-accent-dark border-accent-dark' : 'bg-white/80 border-white'} flex items-center justify-center transition-colors`}>
                {isSelected && <Check className="w-4 h-4 text-white" />}
              </div>
            </div>
          )}

          {/* Media type badges */}
          <div className="absolute bottom-2 left-2 flex gap-2">
            {photo.type === 'collage' && (
              <span className="px-2 py-1 bg-black/60 text-white text-xs rounded">
                Collage
              </span>
            )}
            {photo.media_type === 'video' && (
              <span className="px-2 py-1 bg-black/60 text-white text-xs rounded flex items-center gap-1">
                <Play className="w-3 h-3" fill="white" />
                Video
                {photo.duration && (
                  <span className="ml-1">
                    {Math.floor(photo.duration / 60)}:{String(photo.duration % 60).padStart(2, '0')}
                  </span>
                )}
              </span>
            )}
          </div>
        </>
      ) : (
        <div className="skeleton aspect-square w-full" />
      )}
    </div>
  );
};
