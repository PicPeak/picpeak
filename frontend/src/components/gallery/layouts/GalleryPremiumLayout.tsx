import React, { useState, useMemo, useCallback } from 'react';
import { MasonryPhotoAlbum } from 'react-photo-album';
import 'react-photo-album/masonry.css';
import Lightbox from 'yet-another-react-lightbox';
import Thumbnails from 'yet-another-react-lightbox/plugins/thumbnails';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import Fullscreen from 'yet-another-react-lightbox/plugins/fullscreen';
import Download from 'yet-another-react-lightbox/plugins/download';
import Captions from 'yet-another-react-lightbox/plugins/captions';
import 'yet-another-react-lightbox/styles.css';
import 'yet-another-react-lightbox/plugins/thumbnails.css';
import 'yet-another-react-lightbox/plugins/captions.css';
import { motion, AnimatePresence } from 'framer-motion';
import { Download as DownloadIcon, Heart, Check, Star, MessageSquare, Package, LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useInView } from 'react-intersection-observer';

import type { BaseGalleryLayoutProps } from './BaseGalleryLayout';
import type { Photo } from '../../../types';
import { AuthenticatedImage } from '../../common';
import { feedbackService } from '../../../services/feedback.service';
import { useGuestIdentityOptional } from '../../../contexts/GuestIdentityContext';
import { FeedbackIdentityModal } from '../FeedbackIdentityModal';
import { galleryService } from '../../../services/gallery.service';
import { analyticsService } from '../../../services/analytics.service';
import { useDownloadPhoto } from '../../../hooks/useGallery';
import { toast } from 'react-toastify';

import './GalleryPremiumLayout.css';

interface PhotoCardProps {
  photo: Photo;
  width: number;
  height: number;
  onClick: () => void;
  onLike: (e: React.MouseEvent) => void;
  onSelect: (e: React.MouseEvent) => void;
  isSelected: boolean;
  isSelectionMode: boolean;
  isLiked: boolean;
  slug: string;
  allowDownloads?: boolean;
  protectionLevel?: 'basic' | 'standard' | 'enhanced' | 'maximum';
  useEnhancedProtection?: boolean;
  useCanvasRendering?: boolean;
  feedbackEnabled?: boolean;
  // #506: track the per-event "allow likes" toggle so the per-photo
  // Like button respects it. `feedbackEnabled` alone isn't enough —
  // an event can have feedback on but likes specifically disabled.
  allowLikes?: boolean;
  index: number;
}

const PhotoCard: React.FC<PhotoCardProps> = ({
  photo,
  width,
  height: _height,
  onClick,
  onLike,
  onSelect,
  isSelected,
  isSelectionMode,
  isLiked,
  slug,
  allowDownloads = true,
  protectionLevel = 'standard',
  useEnhancedProtection = false,
  useCanvasRendering = false,
  feedbackEnabled = false,
  allowLikes = false,
  index
}) => {
  // Note: height is passed but not used as we maintain aspect ratio via width
  void _height;
  const { ref, inView } = useInView({
    triggerOnce: true,
    threshold: 0.1,
  });

  const likeCount = photo.like_count ?? 0;
  const averageRating = photo.average_rating ?? 0;
  const commentCount = photo.comment_count ?? 0;

  return (
    <motion.div
      ref={ref}
      className={`gallery-premium-photo-card group ${isSelected ? 'selected' : ''}`}
      style={{ width: '100%', height: 'auto', display: 'block' }}
      initial={{ opacity: 0, y: 20 }}
      animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
      transition={{ duration: 0.4, delay: Math.min(index * 0.05, 0.3) }}
      onClick={onClick}
      data-testid={`photo-card-${photo.id}`}
    >
      <AuthenticatedImage
        src={photo.thumbnail_url || photo.url}
        alt={photo.filename}
        style={{ width, height: 'auto' }}
        className="w-full h-auto object-cover"
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
      />

      {/* Overlay Gradient */}
      <div className="gallery-premium-photo-overlay" />

      {/* Selection Checkbox */}
      <button
        onClick={onSelect}
        className={`gallery-premium-checkbox ${isSelected || isSelectionMode ? 'visible' : ''} ${isSelected ? 'selected' : ''}`}
      >
        {isSelected && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
      </button>

      {/* Like Button — #506: only when feedback master is on AND the
          per-event "allow likes" sub-toggle is on. */}
      {feedbackEnabled && allowLikes && (
        <button
          onClick={onLike}
          className={`gallery-premium-like-btn ${isLiked ? 'liked' : ''}`}
        >
          <Heart
            className={`w-5 h-5 ${isLiked ? 'fill-current' : ''}`}
          />
        </button>
      )}

      {/* Selection Border */}
      {isSelected && (
        <div className="gallery-premium-selection-border" />
      )}

      {/* Feedback Indicators */}
      {feedbackEnabled && (likeCount > 0 || averageRating > 0 || commentCount > 0 || isLiked) && (
        <div className="gallery-premium-feedback">
          {(likeCount > 0 || isLiked) && (
            <span className="gallery-premium-feedback-indicator" title="Liked">
              <Heart className="w-3.5 h-3.5 text-red-500" fill="currentColor" />
            </span>
          )}
          {averageRating > 0 && (
            <span className="gallery-premium-feedback-indicator" title="Rated">
              <Star className="w-3.5 h-3.5 text-yellow-500" fill="currentColor" />
            </span>
          )}
          {commentCount > 0 && (
            <span className="gallery-premium-feedback-indicator" title="Commented">
              <MessageSquare className="w-3.5 h-3.5 text-blue-500" fill="currentColor" />
            </span>
          )}
        </div>
      )}
    </motion.div>
  );
};

interface GalleryPremiumLayoutProps extends BaseGalleryLayoutProps {
  heroPhotoOverride?: Photo | null;
}

export const GalleryPremiumLayout: React.FC<GalleryPremiumLayoutProps> = ({
  photos,
  slug,
  onPhotoClick: _onPhotoClick,
  onOpenPhotoWithFeedback: _onOpenPhotoWithFeedback,
  onFeedbackChange,
  onDownload: _onDownload,
  selectedPhotos = new Set(),
  isSelectionMode = false,
  onPhotoSelect,
  onSelectAll,
  onDeselectAll,
  eventName,
  eventDate,
  allowDownloads = true,
  protectionLevel = 'standard',
  useEnhancedProtection = false,
  useCanvasRendering = false,
  feedbackEnabled = false,
  feedbackOptions,
  heroPhotoOverride,
  onLogout,
  showOriginalFilename = false,
}) => {
  // These props are passed by parent but we use our own lightbox, so mark as intentionally unused
  void _onPhotoClick;
  void _onOpenPhotoWithFeedback;
  void _onDownload;
  const { t } = useTranslation();
  const downloadPhotoMutation = useDownloadPhoto();
  const [lightboxIndex, setLightboxIndex] = useState(-1);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [likedPhotoIds, setLikedPhotoIds] = useState<Set<number>>(new Set());
  const [savedIdentity, setSavedIdentity] = useState<{ name: string; email: string } | null>(null);
  const guestIdentity = useGuestIdentityOptional();
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [pendingLikePhotoId, setPendingLikePhotoId] = useState<number | null>(null);

  // Get unique categories from photos
  const categories = useMemo(() => {
    const cats = new Set<string>();
    photos.forEach(photo => {
      if (photo.category_name) {
        cats.add(photo.category_name);
      }
    });
    return Array.from(cats);
  }, [photos]);

  // Filter photos by active category
  const filteredPhotos = useMemo(() => {
    if (!activeCategory) return photos;
    return photos.filter(photo => photo.category_name === activeCategory);
  }, [photos, activeCategory]);

  // Get hero photo
  const heroPhoto = heroPhotoOverride || photos[0];

  // Convert photos to react-photo-album format
  const albumPhotos = useMemo(() => {
    return filteredPhotos.map(photo => ({
      src: photo.thumbnail_url || photo.url,
      width: photo.width || 1200,
      height: photo.height || 800,
      key: String(photo.id),
      // Keep original photo data
      _photo: photo
    }));
  }, [filteredPhotos]);

  // Lightbox slides. `title` powers the Captions plugin — only emitted
  // when the admin has flipped the original-filenames toggle (#508).
  const slides = useMemo(() => {
    return filteredPhotos.map(photo => ({
      src: photo.url,
      alt: photo.filename,
      width: photo.width || 1200,
      height: photo.height || 800,
      download: allowDownloads ? photo.url : undefined,
      title: showOriginalFilename
        ? (photo.original_filename || photo.filename)
        : undefined,
    }));
  }, [filteredPhotos, allowDownloads, showOriginalFilename]);

  const handleLike = useCallback(async (photo: Photo, e: React.MouseEvent) => {
    e.stopPropagation();

    if (guestIdentity?.identityMode === 'guest') {
      try {
        await guestIdentity.ensureIdentity();
      } catch {
        return;
      }
      setLikedPhotoIds(prev => {
        const next = new Set(prev);
        next.add(photo.id);
        return next;
      });
      try {
        await feedbackService.submitFeedback(slug, String(photo.id), {
          feedback_type: 'like',
        });
        onFeedbackChange?.();
      } catch (err) {
        console.warn('Like submit failed', err);
      }
      return;
    }

    if (feedbackOptions?.requireNameEmail && !savedIdentity) {
      setPendingLikePhotoId(photo.id);
      setShowIdentityModal(true);
      return;
    }

    // Optimistic update
    setLikedPhotoIds(prev => {
      const next = new Set(prev);
      next.add(photo.id);
      return next;
    });

    try {
      await feedbackService.submitFeedback(slug, String(photo.id), {
        feedback_type: 'like',
        guest_name: savedIdentity?.name,
        guest_email: savedIdentity?.email,
      });
      onFeedbackChange?.();
    } catch (err) {
      console.warn('Like submit failed', err);
    }
  }, [slug, savedIdentity, feedbackOptions, onFeedbackChange, guestIdentity]);

  const handleIdentitySubmit = useCallback(async (name: string, email: string) => {
    setSavedIdentity({ name, email });
    setShowIdentityModal(false);

    if (pendingLikePhotoId) {
      setLikedPhotoIds(prev => {
        const next = new Set(prev);
        next.add(pendingLikePhotoId);
        return next;
      });

      try {
        await feedbackService.submitFeedback(slug, String(pendingLikePhotoId), {
          feedback_type: 'like',
          guest_name: name,
          guest_email: email,
        });
        onFeedbackChange?.();
      } catch (err) {
        console.warn('Like submit failed', err);
      }
      setPendingLikePhotoId(null);
    }
  }, [slug, pendingLikePhotoId, onFeedbackChange]);

  const handleSelectAll = useCallback(() => {
    if (selectedPhotos.size === filteredPhotos.length) {
      onDeselectAll?.();
    } else {
      onSelectAll?.();
    }
  }, [selectedPhotos, filteredPhotos, onSelectAll, onDeselectAll]);

  const handleDownloadSelected = useCallback(async () => {
    if (selectedPhotos.size === 0) return;
    const ids = Array.from(selectedPhotos);
    toast.info(t('gallery.downloading', { count: ids.length }));

    try {
      await galleryService.downloadSelectedPhotos(slug, ids);
      analyticsService.trackGalleryEvent('bulk_download', { gallery: slug, photo_count: ids.length });
    } catch {
      toast.error(t('gallery.downloadError'));
    }
  }, [selectedPhotos, slug, t]);

  const handleDownloadFromLightbox = useCallback((slide: { src?: string }) => {
    if (!allowDownloads || !slide.src) return;

    const photo = filteredPhotos.find(p => p.url === slide.src);
    if (photo) {
      analyticsService.trackDownload(photo.id, slug, false);
      downloadPhotoMutation.mutate({
        slug,
        photoId: photo.id,
        filename: photo.filename,
      });
    }
  }, [allowDownloads, filteredPhotos, slug, downloadPhotoMutation]);

  const formattedDate = eventDate ? new Date(eventDate).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: '2-digit'
  }) : null;

  if (photos.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">{t('gallery.noPhotosFound')}</p>
      </div>
    );
  }

  return (
    <div className="gallery-premium-layout">
      {/* Hero Section */}
      <div className="gallery-premium-hero">
        <div
          className="gallery-premium-hero-bg"
          style={{
            backgroundImage: heroPhoto ? `url(${heroPhoto.hero_url || heroPhoto.url})` : undefined
          }}
        />
        <div className="gallery-premium-hero-overlay" />
        <div className="gallery-premium-hero-content">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.2 }}
          >
            {formattedDate && (
              <p className="gallery-premium-hero-date">
                {formattedDate}
              </p>
            )}
            <h1 className="gallery-premium-hero-title">
              {eventName || t('gallery.photoGallery')}
            </h1>
          </motion.div>
        </div>
      </div>

      {/* Sticky Navigation */}
      <div className="gallery-premium-nav">
        <div className="gallery-premium-nav-inner">
          <div className="gallery-premium-nav-categories">
            <button
              className={`gallery-premium-nav-category ${!activeCategory ? 'active' : ''}`}
              onClick={() => setActiveCategory(null)}
            >
              {t('gallery.allPhotos', 'All Photos')}
            </button>
            {categories.map(cat => (
              <button
                key={cat}
                className={`gallery-premium-nav-category ${activeCategory === cat ? 'active' : ''}`}
                onClick={() => setActiveCategory(cat)}
              >
                {cat}
              </button>
            ))}
          </div>

          <div className="gallery-premium-nav-title">
            {eventName ? eventName.split(' ').map(w => w[0]).join('').slice(0, 3) : 'Gallery'}
          </div>

          <div className="gallery-premium-nav-actions">
            <AnimatePresence>
              {isSelectionMode && selectedPhotos.size > 0 && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="gallery-premium-selection-controls"
                >
                  <button
                    className="gallery-premium-selection-btn"
                    onClick={handleSelectAll}
                  >
                    {selectedPhotos.size === filteredPhotos.length ? t('gallery.deselectAll') : t('gallery.selectAll')}
                  </button>
                  <button
                    className="gallery-premium-download-btn"
                    onClick={handleDownloadSelected}
                  >
                    <Package className="w-3 h-3 mr-1 inline" />
                    {t('common.download')} ({selectedPhotos.size})
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            {feedbackEnabled && feedbackOptions?.allowLikes && (
              <button className="gallery-premium-nav-btn" title={t('gallery.favorites', 'Favorites')}>
                <Heart className="w-4 h-4" />
              </button>
            )}
            {allowDownloads && (
              <button
                className="gallery-premium-nav-btn"
                title={t('common.downloadAll', 'Download All')}
                onClick={() => {
                  filteredPhotos.forEach(p => {
                    if (!selectedPhotos.has(p.id)) {
                      onPhotoSelect?.(p.id);
                    }
                  });
                }}
              >
                <DownloadIcon className="w-4 h-4" />
              </button>
            )}
            {onLogout && (
              <button
                className="gallery-premium-nav-btn"
                title={t('common.logout', 'Logout')}
                onClick={onLogout}
              >
                <LogOut className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Main Gallery */}
      <main className="gallery-premium-main">
        <MasonryPhotoAlbum
          photos={albumPhotos}
          render={{
            photo: (_props, { photo, width, height }) => {
              const originalPhoto = (photo as any)._photo as Photo;
              const photoIndex = filteredPhotos.findIndex(p => p.id === originalPhoto.id);

              return (
                <PhotoCard
                  photo={originalPhoto}
                  width={width}
                  height={height}
                  onClick={() => setLightboxIndex(photoIndex)}
                  onLike={(e) => handleLike(originalPhoto, e)}
                  onSelect={(e) => {
                    e.stopPropagation();
                    onPhotoSelect?.(originalPhoto.id);
                  }}
                  isSelected={selectedPhotos.has(originalPhoto.id)}
                  isSelectionMode={isSelectionMode}
                  isLiked={likedPhotoIds.has(originalPhoto.id) || (originalPhoto.like_count ?? 0) > 0}
                  slug={slug}
                  allowDownloads={allowDownloads}
                  protectionLevel={protectionLevel}
                  useEnhancedProtection={useEnhancedProtection}
                  useCanvasRendering={useCanvasRendering}
                  feedbackEnabled={feedbackEnabled}
                  allowLikes={!!feedbackOptions?.allowLikes}
                  index={photoIndex}
                />
              );
            }
          }}
          columns={(containerWidth) => {
            if (containerWidth < 640) return 1;
            if (containerWidth < 1024) return 2;
            return 3;
          }}
          spacing={16}
        />
      </main>

      {/* Footer */}
      <footer className="gallery-premium-footer">
        <p>{t('gallery.poweredBy', 'Powered by PicPeak')}</p>
        <p>© {new Date().getFullYear()} {t('gallery.allRightsReserved', 'All rights reserved')}</p>
      </footer>

      {/* Lightbox */}
      <Lightbox
        open={lightboxIndex >= 0}
        close={() => setLightboxIndex(-1)}
        index={lightboxIndex}
        slides={slides}
        plugins={[
          Thumbnails,
          Zoom,
          Fullscreen,
          ...(allowDownloads ? [Download] : []),
          ...(showOriginalFilename ? [Captions] : []),
        ]}
        animation={{ fade: 300, swipe: 250 }}
        styles={{
          container: { backgroundColor: 'rgba(0, 0, 0, 0.95)' },
          thumbnail: { border: 'none' }
        }}
        render={{
          buttonPrev: slides.length <= 1 ? () => null : undefined,
          buttonNext: slides.length <= 1 ? () => null : undefined,
        }}
        controller={{ closeOnBackdropClick: true }}
        download={{
          download: ({ slide }) => {
            handleDownloadFromLightbox(slide);
          }
        }}
      />

      {/* Identity Modal */}
      <FeedbackIdentityModal
        isOpen={showIdentityModal}
        onClose={() => { setShowIdentityModal(false); setPendingLikePhotoId(null); }}
        onSubmit={handleIdentitySubmit}
        feedbackType="like"
      />
    </div>
  );
};
