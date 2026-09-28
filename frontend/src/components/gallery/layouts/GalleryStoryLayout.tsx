import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Search, Heart, LogOut, Download, CheckSquare, X, Package } from 'lucide-react';
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
  StoryJustifiedGrid,
  StoryScrollToTop
} from './story';
import { PhotoLightbox } from '../PhotoLightbox';
import { DownloadQuotaNotice } from '../DownloadQuotaNotice';
import { useDownloadQuota } from '../../../contexts/DownloadQuotaContext';
import { isDownloadLimitError, showDownloadLimitReached } from '../../../utils/downloadLimit';

import './GalleryStoryLayout.css';

const EMPTY_SELECTION: Set<number> = new Set();

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
  /** Issue 1709: 'natural' keeps every photo's aspect ratio; 'fixed' (default) is the original tile grid. */
  storyGridMode?: 'fixed' | 'natural';
}

export const GalleryStoryLayout: React.FC<GalleryStoryLayoutProps> = ({
  photos,
  slug,
  onPhotoClick: _onPhotoClick,
  onOpenPhotoWithFeedback: _onOpenPhotoWithFeedback,
  onFeedbackChange,
  onDownload: _onDownload,
  selectedPhotos,
  isSelectionMode = false,
  onPhotoSelect,
  onSelectMany,
  onDeselectAll,
  onToggleSelectionMode,
  onDownloadSelected,
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
  feedbackOptions,
  heroPhotoOverride,
  welcomeMessage,
  storyGridMode = 'fixed',
  onLogout,
  showOriginalFilename = false,

  people,
  onSelectPerson,
}) => {
  // These props are passed by parent but we use our own feedback system, so mark as intentionally unused
  void _onPhotoClick;
  void _onOpenPhotoWithFeedback;
  void _onDownload;
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

  const downloadQuota = useDownloadQuota();

  // Selection mode (issue 1716). The container owns the mode and the set;
  // this layout only renders the controls and asks for changes.
  const selected = selectedPhotos ?? EMPTY_SELECTION;
  const visiblePhotos = useMemo(() => scenes.flatMap((scene) => scene.photos), [scenes]);
  const selectedPhotoList = useMemo(
    () => photos.filter((photo) => selected.has(photo.id)),
    [photos, selected]
  );
  // A container that can toggle the mode is what makes the bar (and its
  // Cancel) safe to show; the nav control and the card checkboxes need more
  // than one photo, or the only way out of a one-photo selection would be a
  // reload.
  const selectionAvailable = Boolean(onToggleSelectionMode && onPhotoSelect);
  const canSelect = selectionAvailable && photos.length > 1;
  const cardSelect = canSelect ? onPhotoSelect : undefined;
  // Likes are a per-event sub-toggle (#506): with them off the like endpoint
  // answers 403, so the card hearts are not offered. The bulk control and the
  // nav heart also need the feedback master switch, as before.
  const likesAllowed = feedbackOptions?.allowLikes !== false;
  const bulkLikesAllowed = feedbackEnabled && likesAllowed;
  const allVisibleSelected = visiblePhotos.length > 0 && visiblePhotos.every((photo) => selected.has(photo.id));

  const handleToggleSelectionMode = useCallback(() => {
    // Leaving selection mode clears the selection, so a later session does
    // not start with invisible ticks.
    if (isSelectionMode) onDeselectAll?.();
    onToggleSelectionMode?.();
  }, [isSelectionMode, onDeselectAll, onToggleSelectionMode]);

  const handleSelectAllVisible = useCallback(() => {
    if (allVisibleSelected) onDeselectAll?.();
    else onSelectMany?.(visiblePhotos.map((photo) => photo.id));
  }, [allVisibleSelected, onDeselectAll, onSelectMany, visiblePhotos]);

  const [favoritingSelection, setFavoritingSelection] = useState(false);
  // Likes not yet set on the selection are added; a selection that is already
  // liked throughout is unliked instead, so the same control never un-likes
  // half a selection by accident.
  const selectionToLike = useMemo(
    () => selectedPhotoList.filter((photo) => !favorites.has(photo.id)).map((photo) => photo.id),
    [selectedPhotoList, favorites]
  );
  const selectionUnlikes = selectedPhotoList.length > 0 && selectionToLike.length === 0;

  const handleFavoriteSelected = useCallback(async () => {
    const ids = selectionUnlikes ? selectedPhotoList.map((photo) => photo.id) : selectionToLike;
    if (ids.length === 0 || favoritingSelection) return;
    setFavoritingSelection(true);
    // The server like endpoint is a per-photo toggle (#590): only photos that
    // need to change are sent, in small batches.
    const done: number[] = [];
    for (let i = 0; i < ids.length; i += 5) {
      const batch = ids.slice(i, i + 5);
      const results = await Promise.allSettled(
        batch.map((id) => feedbackService.submitFeedback(slug, String(id), { feedback_type: 'like' }))
      );
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') done.push(batch[index]);
      });
    }
    setFavorites((previous) => {
      const next = new Set(previous);
      done.forEach((id) => (selectionUnlikes ? next.delete(id) : next.add(id)));
      return next;
    });
    setFavoritingSelection(false);
    if (done.length > 0) {
      toast.success(t(selectionUnlikes ? 'gallery.favoritesRemoved' : 'gallery.favoritesAdded', { count: done.length }));
      onFeedbackChange?.();
    }
    if (done.length < ids.length) toast.error(t('gallery.favoriteSelectedError'));
  }, [selectionUnlikes, selectedPhotoList, selectionToLike, favoritingSelection, slug, t, onFeedbackChange]);

  const handleDownloadAll = useCallback(async () => {
    // Whole-gallery path when available: posting ids would hit the server's
    // 500-id cap and silently truncate a large gallery (#1160).
    if (onDownloadEverything) {
      onDownloadEverything();
      return;
    }
    const ids = photos.map(p => p.id);
    // Download limit (issue 1560): all or nothing, so refuse before asking.
    if (!downloadQuota.allows(photos)) {
      showDownloadLimitReached({ remaining: downloadQuota.remaining ?? 0 });
      return;
    }
    // #858: hand off to the resolution picker when the gallery offers a choice.
    if (downloadChoices && downloadChoices.length > 1 && onPickResolution) {
      onPickResolution(ids);
      return;
    }
    toast.info(t('gallery.downloading', { count: ids.length }));
    try {
      await galleryService.downloadSelectedPhotos(slug, ids);
      analyticsService.trackGalleryEvent('bulk_download', { gallery: slug, photo_count: ids.length });
    } catch (error) {
      if (!isDownloadLimitError(error)) toast.error(t('gallery.downloadError'));
    }
  }, [photos, onDownloadEverything, slug, t, downloadChoices, onPickResolution, downloadQuota]);

  // Needs something to download: either the whole-gallery callback, or
  // photos in the current scope. On a folder-only root of a gallery with
  // a category download opt-out it has neither, and posting an empty id
  // list is a 400 (#1160). Shared by the nav button (issue 1710) and the
  // footer button so both appear and disappear together.
  const canDownloadAll = allowDownloads && Boolean(onDownloadEverything || photos.length > 0);
  const downloadAllLabel = t('common.downloadAll', 'Download All');
  const naturalGrid = storyGridMode === 'natural';

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
          {/* Issue 1710: the footer button was the only Download All in the
              layout, unreachable without scrolling through every scene. Same
              handler, same resolution / quota / whole-gallery flow. */}
          {canSelect && (
            <button
              type="button"
              className={`story-nav-btn${isSelectionMode ? ' active' : ''}`}
              onClick={handleToggleSelectionMode}
              aria-pressed={isSelectionMode}
              aria-label={isSelectionMode ? t('gallery.cancelSelection', 'Cancel Selection') : t('gallery.selectPhotos', 'Select Photos')}
              title={isSelectionMode ? t('gallery.cancelSelection', 'Cancel Selection') : t('gallery.selectPhotos', 'Select Photos')}
              data-testid="story-nav-select"
            >
              <CheckSquare size={20} />
            </button>
          )}
          {canDownloadAll && (
            <button
              type="button"
              className="story-nav-btn"
              onClick={handleDownloadAll}
              aria-label={downloadAllLabel}
              title={downloadAllLabel}
              data-testid="story-nav-download-all"
            >
              <Download size={20} />
            </button>
          )}
          {bulkLikesAllowed && (
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

      {/* Selection bar (issue 1716): count, select all, and the bulk actions
          on the selection. Download goes through the container's handler so
          the resolution picker and the download limit apply exactly as they
          do on every other layout. */}
      {isSelectionMode && selectionAvailable && (
        <div className="story-selection-bar" role="region" aria-label={t('gallery.selectPhotos', 'Select Photos')}>
          <span className="story-selection-count" aria-live="polite">
            {t('gallery.photosSelected', { count: selected.size })}
          </span>
          <div className="story-selection-actions">
            <button type="button" className="story-selection-btn" onClick={handleSelectAllVisible}>
              {allVisibleSelected ? t('gallery.deselectAll', 'Deselect All') : t('gallery.selectAll', 'Select All')}
            </button>
            {bulkLikesAllowed && selected.size > 0 && (
              <button
                type="button"
                className="story-selection-btn"
                onClick={handleFavoriteSelected}
                disabled={favoritingSelection}
                data-testid="story-favorite-selected"
              >
                <Heart size={14} fill={selectionUnlikes ? 'currentColor' : 'none'} />
                {t(selectionUnlikes ? 'gallery.unfavoriteSelected' : 'gallery.favoriteSelected', { count: selected.size })}
              </button>
            )}
            {allowDownloads && onDownloadSelected && selected.size > 0 && (
              <button
                type="button"
                className="story-selection-btn story-selection-btn--primary"
                onClick={() => { void onDownloadSelected(); }}
                disabled={!downloadQuota.allows(selectedPhotoList)}
                data-testid="story-download-selected"
              >
                <Package size={14} />
                {t('gallery.downloadSelected', { count: selected.size })}
              </button>
            )}
            <button
              type="button"
              className="story-selection-btn"
              onClick={handleToggleSelectionMode}
              aria-label={t('gallery.cancelSelection', 'Cancel Selection')}
            >
              <X size={14} />
              {t('common.cancel', 'Cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Hero */}
      <StoryHero
        title={eventName || t('gallery.photoGallery', 'Photo Gallery')}
        date={eventDate}
        stats={stats}
        photo={heroPhoto}
        slug={slug}
        allowDownloads={allowDownloads}
        useEnhancedProtection={useEnhancedProtection}
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
                  useEnhancedProtection={useEnhancedProtection}
                  naturalAspect={naturalGrid}
                  isSelectionMode={isSelectionMode}
                  selectedPhotos={selected}
                  onPhotoSelect={cardSelect}
                  likesAllowed={likesAllowed}
                />
              ) : naturalGrid ? (
                <StoryJustifiedGrid
                  id={`gallery-${scene.id}`}
                  photos={scene.photos}
                  favorites={favorites}
                  onToggleFavorite={handleToggleFavorite}
                  onPhotoClick={handleOpenLightbox}
                  slug={slug}
                  allowDownloads={allowDownloads}
                  useEnhancedProtection={useEnhancedProtection}
                  isSelectionMode={isSelectionMode}
                  selectedPhotos={selected}
                  onPhotoSelect={cardSelect}
                  likesAllowed={likesAllowed}
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
                      useEnhancedProtection={useEnhancedProtection}
                      // Mark first photo in each grid as featured
                      featured={index === 0 && scene.photos.length > 4}
                      isSelectionMode={isSelectionMode}
                      isSelected={selected.has(photo.id)}
                      onSelect={cardSelect}
                      likesAllowed={likesAllowed}
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
        {canDownloadAll && (
          <button type="button" className="story-footer-btn" onClick={handleDownloadAll}>
            {t('common.downloadAll', 'Download All Photos')}
          </button>
        )}
        {allowDownloads && <DownloadQuotaNotice className="mt-2" />}
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
