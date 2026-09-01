import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Search, Heart, LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { BaseGalleryLayoutProps } from './BaseGalleryLayout';
import type { Photo } from '../../../types';
import { feedbackService } from '../../../services/feedback.service';
import { galleryService } from '../../../services/gallery.service';
import { analyticsService } from '../../../services/analytics.service';
import { toast } from 'react-toastify';

import {
  StoryHero,
  StoryScene,
  StoryPhotoCard,
  StoryCarousel,
  StoryScrollToTop
} from './story';
import { PhotoLightbox } from '../PhotoLightbox';

import './GalleryStoryLayout.css';

interface PhotosByCategory {
  [categoryName: string]: Photo[];
}

interface CategoryScene {
  id: string;
  title: string;
  subtitle?: string;
  type: 'grid' | 'carousel';
  photos: Photo[];
}

interface GalleryStoryLayoutProps extends BaseGalleryLayoutProps {
  heroPhotoOverride?: Photo | null;
  welcomeMessage?: string;
}

export const GalleryStoryLayout: React.FC<GalleryStoryLayoutProps> = ({
  photos,
  slug,
  onPhotoClick: _onPhotoClick,
  onOpenPhotoWithFeedback: _onOpenPhotoWithFeedback,
  onFeedbackChange,
  onDownload: _onDownload,
  selectedPhotos: _selectedPhotos,
  isSelectionMode: _isSelectionMode,
  onPhotoSelect: _onPhotoSelect,
  eventName,
  eventDate,
  allowDownloads = true,
  suppressEmptyState = false,
  eventPhotoCount,
  onDownloadEverything,
  downloadChoices,
  onPickResolution,
  protectionLevel = 'standard',
  useEnhancedProtection = false,
  useCanvasRendering = false,
  feedbackEnabled = false,
  heroPhotoOverride,
  welcomeMessage,
  onLogout,
  showOriginalFilename = false,

  people,
  onSelectPerson,
}) => {
  // These props are passed by parent but we use our own feedback system, so mark as intentionally unused
  void _onPhotoClick;
  void _onOpenPhotoWithFeedback;
  void _onDownload;
  void _selectedPhotos;
  void _isSelectionMode;
  void _onPhotoSelect;
  const { t } = useTranslation();
  const [scrolled, setScrolled] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [favorites, setFavorites] = useState<Set<number>>(new Set());
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Track scroll for nav background
  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Seed favorites from per-viewer is_liked on first non-empty payload
  // (#590 follow-up). The previous code seeded from like_count > 0 which
  // marked every photo with ANY likes as "favorited" for the current
  // viewer — wrong. Also gated by a mount-only ref so refetches don't
  // clobber the user's in-session toggles.
  const favoritesSeededRef = useRef(false);
  useEffect(() => {
    if (favoritesSeededRef.current || photos.length === 0) return;
    setFavorites(new Set(photos.filter(p => p.is_liked).map(p => p.id)));
    favoritesSeededRef.current = true;
  }, [photos]);

  // Get hero photo
  const heroPhoto = heroPhotoOverride || photos[0];

  // Group photos by category into scenes
  const scenes = useMemo<CategoryScene[]>(() => {
    const photosByCategory: PhotosByCategory = {};

    // Filter by search query. `original_filename` is in here because that is
    // the camera name the guest actually sees on the card/lightbox — matching
    // only the internal renamed `filename` gave "no results" for a substring
    // the guest could read on screen (QA P4-B.02).
    const filteredPhotos = searchQuery
      ? photos.filter(p => {
          const term = searchQuery.toLowerCase();
          return p.filename.toLowerCase().includes(term) ||
            (p.original_filename?.toLowerCase().includes(term) ?? false) ||
            (p.category_name && p.category_name.toLowerCase().includes(term));
        })
      : photos;

    // Group by category
    filteredPhotos.forEach(photo => {
      const categoryName = photo.category_name || '';
      if (!photosByCategory[categoryName]) {
        photosByCategory[categoryName] = [];
      }
      photosByCategory[categoryName].push(photo);
    });

    // Convert to scenes with alternating types
    return Object.entries(photosByCategory).map(([categoryName, categoryPhotos], index) => ({
      id: `scene-${index}`,
      title: categoryName,
      subtitle: `${categoryPhotos.length} ${t('gallery.photos', 'photos')}`,
      // Alternate between grid and carousel
      type: index % 2 === 0 ? 'grid' : 'carousel' as 'grid' | 'carousel',
      photos: categoryPhotos
    }));
  }, [photos, searchQuery, t]);

  // #1160: on a folder-only root this component renders its shell with an empty
  // scope, so fall back to the event-wide count rather than announcing 0 Photos
  // directly above folder tiles that hold them.
  const totalPhotos = photos.length || eventPhotoCount || 0;
  const stats = `${totalPhotos} ${t('gallery.photos', 'Photos')}`;

  const handleToggleFavorite = useCallback(async (photoId: number) => {
    const newFavorites = new Set(favorites);
    if (newFavorites.has(photoId)) newFavorites.delete(photoId);
    else newFavorites.add(photoId);
    setFavorites(newFavorites);

    // The server /feedback like endpoint is a toggle (#590) — fire on
    // every click, not only when adding. The previous code skipped the
    // submit on unlike, so the UI removed the heart but the server
    // still had the like row.
    try {
      await feedbackService.submitFeedback(slug, String(photoId), {
        feedback_type: 'like',
      });
      onFeedbackChange?.();
    } catch (err) {
      console.warn('Like submit failed', err);
    }
  }, [favorites, slug, onFeedbackChange]);

  const handleOpenLightbox = useCallback((photo: Photo) => {
    const index = photos.findIndex(p => p.id === photo.id);
    setLightboxIndex(index >= 0 ? index : 0);
  }, [photos]);

  const handleDownloadAll = useCallback(async () => {
    // Whole-gallery path when available: posting ids would hit the server's
    // 500-id cap and silently truncate a large gallery (#1160).
    if (onDownloadEverything) {
      onDownloadEverything();
      return;
    }
    const ids = photos.map(p => p.id);
    // #858: hand off to the resolution picker when the gallery offers a choice.
    if (downloadChoices && downloadChoices.length > 1 && onPickResolution) {
      onPickResolution(ids);
      return;
    }
    toast.info(t('gallery.downloading', { count: ids.length }));
    try {
      await galleryService.downloadSelectedPhotos(slug, ids);
      analyticsService.trackGalleryEvent('bulk_download', { gallery: slug, photo_count: ids.length });
    } catch {
      toast.error(t('gallery.downloadError'));
    }
  }, [photos, onDownloadEverything, slug, t, downloadChoices, onPickResolution]);

  // #1160: a folder-only root has no photos to show here, but the folder tiles
  // above prove the gallery isn't empty — render the shell (hero, logout,
  // controls) without the contradictory message.
  if (photos.length === 0 && !suppressEmptyState) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">{t('gallery.noPhotosFound')}</p>
      </div>
    );
  }

  return (
    <div className="gallery-story-layout">
      <StoryScrollToTop />

      {/* Navigation Overlay */}
      <nav className={`story-nav ${scrolled ? 'scrolled' : ''}`}>
        <span className="story-nav-logo">
          {eventName ? eventName.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase() : 'GALLERY'}
        </span>

        <div className="story-nav-actions">
          <div className="story-nav-search">
            <Search size={14} className="text-gray-400" />
            <input
              type="text"
              placeholder={t('gallery.searchMemories', 'Search memories...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          {feedbackEnabled && (
            <button className="story-nav-btn" title={t('gallery.favorites', 'Favorites')}>
              <Heart size={20} />
              {favorites.size > 0 && (
                <span className="story-nav-favorites-count">
                  {favorites.size > 9 ? '9+' : favorites.size}
                </span>
              )}
            </button>
          )}
          {onLogout && (
            <button
              className="story-nav-btn"
              onClick={onLogout}
              title={t('common.logout', 'Logout')}
            >
              <LogOut size={20} />
            </button>
          )}
        </div>
      </nav>

      {/* Hero */}
      <StoryHero
        title={eventName || t('gallery.photoGallery', 'Photo Gallery')}
        date={eventDate}
        stats={stats}
        photo={heroPhoto}
        slug={slug}
        allowDownloads={allowDownloads}
        protectionLevel={protectionLevel}
        useEnhancedProtection={useEnhancedProtection}
        useCanvasRendering={useCanvasRendering}
      />

      {/* Main Content - Scenes */}
      <main className="pb-32 space-y-0">
        {scenes.map((scene) => {
          if (scene.photos.length === 0) return null;

          return (
            <StoryScene
              key={scene.id}
              title={scene.title}
              subtitle={scene.subtitle}
              fullWidth={scene.type === 'carousel'}
            >
              {scene.type === 'carousel' ? (
                <StoryCarousel
                  id={`gallery-${scene.id}`}
                  photos={scene.photos}
                  favorites={favorites}
                  onToggleFavorite={handleToggleFavorite}
                  onPhotoClick={handleOpenLightbox}
                  slug={slug}
                  allowDownloads={allowDownloads}
                  protectionLevel={protectionLevel}
                  useEnhancedProtection={useEnhancedProtection}
                  useCanvasRendering={useCanvasRendering}
                />
              ) : (
                <div id={`gallery-${scene.id}`} className="story-gallery-grid">
                  {scene.photos.map((photo, index) => (
                    <StoryPhotoCard
                      key={photo.id}
                      photo={photo}
                      index={index}
                      isFavorite={favorites.has(photo.id)}
                      onToggleFavorite={handleToggleFavorite}
                      onClick={() => handleOpenLightbox(photo)}
                      slug={slug}
                      galleryId={`gallery-${scene.id}`}
                      allowDownloads={allowDownloads}
                      protectionLevel={protectionLevel}
                      useEnhancedProtection={useEnhancedProtection}
                      useCanvasRendering={useCanvasRendering}
                      // Mark first photo in each grid as featured
                      featured={index === 0 && scene.photos.length > 4}
                    />
                  ))}
                </div>
              )}
            </StoryScene>
          );
        })}
      </main>

      {/* Footer */}
      <footer className="story-footer">
        <h2 className="story-footer-title">{t('gallery.thankYou', 'Thank You')}</h2>
        <p className="story-footer-text">
          {welcomeMessage || t('gallery.thankYouMessage', 'For being part of our story and making our special day unforgettable.')}
        </p>
        {/* Needs something to download: either the whole-gallery callback, or
            photos in the current scope. On a folder-only root of a gallery with
            a category download opt-out it has neither, and posting an empty id
            list is a 400 (#1160). */}
        {allowDownloads && (onDownloadEverything || photos.length > 0) && (
          <button className="story-footer-btn" onClick={handleDownloadAll}>
            {t('common.downloadAll', 'Download All Photos')}
          </button>
        )}
      </footer>

      {/* Lightbox. It owns the whole feedback surface on this theme — ratings,
          comments, reactions and colour labels — the same way the Premium
          layout routes feedback through its own lightbox instead of a
          per-card affordance. */}
      {lightboxIndex !== null && (
        <PhotoLightbox
          photos={photos}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          slug={slug}
          feedbackEnabled={feedbackEnabled}
          allowDownloads={allowDownloads}
          protectionLevel={protectionLevel}
          useEnhancedProtection={useEnhancedProtection}
          useCanvasRendering={useCanvasRendering}
          onFeedbackChange={onFeedbackChange}
          showOriginalFilename={showOriginalFilename}
          // #1074: this layout renders its own lightbox, so the people props
          // have to be threaded through explicitly or the "In this photo"
          // chips silently disappear on the Story theme.
          people={people}
          onSelectPerson={onSelectPerson}
        />
      )}
    </div>
  );
};
