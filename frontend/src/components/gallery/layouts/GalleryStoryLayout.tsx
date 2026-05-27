import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Search, Heart, Menu, LogOut } from 'lucide-react';
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
  StoryFeedbackSheet,
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
  protectionLevel = 'standard',
  useEnhancedProtection = false,
  useCanvasRendering = false,
  feedbackEnabled = false,
  feedbackOptions,
  heroPhotoOverride,
  welcomeMessage,
  onLogout,
  showOriginalFilename = false,
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
  const [selectedPhotoForFeedback, setSelectedPhotoForFeedback] = useState<Photo | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [comments, setComments] = useState<Record<number, Array<{ id: string; author: string; text: string; date: string }>>>({});
  const [ratings, setRatings] = useState<Record<number, number>>({});
  const [savedIdentity, setSavedIdentity] = useState<{ name: string; email: string } | null>(null);

  // Track scroll for nav background
  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Initialize favorites from photo like_counts
  useEffect(() => {
    const initialFavorites = new Set<number>();
    photos.forEach(photo => {
      if ((photo.like_count ?? 0) > 0) {
        initialFavorites.add(photo.id);
      }
    });
    setFavorites(initialFavorites);
  }, [photos]);

  // Get hero photo
  const heroPhoto = heroPhotoOverride || photos[0];

  // Group photos by category into scenes
  const scenes = useMemo<CategoryScene[]>(() => {
    const photosByCategory: PhotosByCategory = {};

    // Filter by search query
    const filteredPhotos = searchQuery
      ? photos.filter(p =>
          p.filename.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (p.category_name && p.category_name.toLowerCase().includes(searchQuery.toLowerCase()))
        )
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

  const totalPhotos = photos.length;
  const stats = `${totalPhotos} ${t('gallery.photos', 'Photos')}`;

  const handleToggleFavorite = useCallback(async (photoId: number) => {
    const newFavorites = new Set(favorites);
    const isCurrentlyFavorite = newFavorites.has(photoId);

    if (isCurrentlyFavorite) {
      newFavorites.delete(photoId);
    } else {
      newFavorites.add(photoId);
    }
    setFavorites(newFavorites);

    // Only submit like if adding favorite
    if (!isCurrentlyFavorite) {
      try {
        await feedbackService.submitFeedback(slug, String(photoId), {
          feedback_type: 'like',
          guest_name: savedIdentity?.name,
          guest_email: savedIdentity?.email,
        });
        onFeedbackChange?.();
      } catch (err) {
        console.warn('Like submit failed', err);
      }
    }
  }, [favorites, slug, savedIdentity, onFeedbackChange]);

  const handleOpenFeedback = useCallback((photo: Photo) => {
    setSelectedPhotoForFeedback(photo);
  }, []);

  const handleOpenLightbox = useCallback((photo: Photo) => {
    const index = photos.findIndex(p => p.id === photo.id);
    setLightboxIndex(index >= 0 ? index : 0);
  }, [photos]);

  const handleCloseFeedback = useCallback(() => {
    setSelectedPhotoForFeedback(null);
  }, []);

  const handleAddComment = useCallback(async (text: string, name?: string, email?: string) => {
    if (!selectedPhotoForFeedback) return;

    if (name && email) {
      setSavedIdentity({ name, email });
    }

    const newComment = {
      id: `${Date.now()}`,
      author: name || savedIdentity?.name || t('gallery.feedback.anonymous', 'Anonymous'),
      text,
      date: new Date().toLocaleDateString()
    };

    setComments(prev => ({
      ...prev,
      [selectedPhotoForFeedback.id]: [...(prev[selectedPhotoForFeedback.id] || []), newComment]
    }));

    try {
      await feedbackService.submitFeedback(slug, String(selectedPhotoForFeedback.id), {
        feedback_type: 'comment',
        comment_text: text,
        guest_name: name || savedIdentity?.name,
        guest_email: email || savedIdentity?.email,
      });
      onFeedbackChange?.();
    } catch (err) {
      console.warn('Comment submit failed', err);
    }
  }, [selectedPhotoForFeedback, slug, savedIdentity, onFeedbackChange, t]);

  const handleRate = useCallback(async (rating: number) => {
    if (!selectedPhotoForFeedback) return;

    setRatings(prev => ({
      ...prev,
      [selectedPhotoForFeedback.id]: rating
    }));

    try {
      await feedbackService.submitFeedback(slug, String(selectedPhotoForFeedback.id), {
        feedback_type: 'rating',
        rating: rating,
        guest_name: savedIdentity?.name,
        guest_email: savedIdentity?.email,
      });
      onFeedbackChange?.();
    } catch (err) {
      console.warn('Rating submit failed', err);
    }
  }, [selectedPhotoForFeedback, slug, savedIdentity, onFeedbackChange]);

  const handleDownloadAll = useCallback(async () => {
    toast.info(t('gallery.downloading', { count: photos.length }));
    try {
      const ids = photos.map(p => p.id);
      await galleryService.downloadSelectedPhotos(slug, ids);
      analyticsService.trackGalleryEvent('bulk_download', { gallery: slug, photo_count: ids.length });
    } catch {
      toast.error(t('gallery.downloadError'));
    }
  }, [photos, slug, t]);

  if (photos.length === 0) {
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
        {allowDownloads && (
          <button className="story-footer-btn" onClick={handleDownloadAll}>
            {t('common.downloadAll', 'Download All Photos')}
          </button>
        )}
      </footer>

      {/* Lightbox */}
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
        />
      )}

      {/* Feedback Sheet */}
      {feedbackEnabled && (
        <StoryFeedbackSheet
          isOpen={!!selectedPhotoForFeedback}
          onClose={handleCloseFeedback}
          photo={selectedPhotoForFeedback}
          comments={selectedPhotoForFeedback ? (comments[selectedPhotoForFeedback.id] || []) : []}
          rating={selectedPhotoForFeedback ? (ratings[selectedPhotoForFeedback.id] || selectedPhotoForFeedback.average_rating || 0) : 0}
          onAddComment={handleAddComment}
          onRate={handleRate}
          requireNameEmail={feedbackOptions?.requireNameEmail}
          savedIdentity={savedIdentity}
        />
      )}
    </div>
  );
};
