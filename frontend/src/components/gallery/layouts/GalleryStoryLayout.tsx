import { PhotoSalesCartButton } from '../../../features/photo-sales/PhotoSalesCartButton';
import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { GalleryEmptyMessage, LikedOnlyEmptyMessage } from '../GalleryEmptyMessage';
import { Heart, LogOut, Download, CheckSquare, X, Package, ClipboardList, Upload, Shield } from 'lucide-react';
import { BackToAccountLink } from '../BackToAccountLink';
import { useTranslation } from 'react-i18next';
import { useArchiveDownload } from '../../../contexts/ArchiveDownloadContext';
import { Button } from '../../common';

import type { BaseGalleryLayoutProps } from './BaseGalleryLayout';
import type { Photo } from '../../../types';
import { STORY_FOOTER_TEXT_MAX, STORY_FOOTER_TITLE_MAX } from '../../../types/theme.types';
import { feedbackService } from '../../../services/feedback.service';
import { BulkRatingPopover } from '../BulkRatingPopover';
import { splitIntoArchives } from '../../../services/gallery.service';
import { analyticsService } from '../../../services/analytics.service';
import { isVideoItem, mediaSplitLabel, selectLabel, splitMediaCount } from '../../../utils/mediaCounts';
import { toast } from 'react-toastify';

import {
  StoryHero,
  StoryScene,
  StoryCarousel,
  StoryFixedGrid,
  StoryJustifiedGrid,
  StoryScrollToTop
} from './story';
import { WINDOW_MIN_PHOTOS } from './rowWindow';
import { TIMELINE_GROUP_WINDOW_MIN_PHOTOS } from './gridWindow';
import { PhotoLightbox } from '../PhotoLightbox';
import { PhotoLabelsProvider } from '../PhotoLabels';
import { FeedbackIdentityModal } from '../FeedbackIdentityModal';
import { useGuestIdentityOptional } from '../../../contexts/GuestIdentityContext';
import { feedbackLockKind } from '../../../utils/feedbackLock';
import { DownloadQuotaNotice } from '../DownloadQuotaNotice';
import { useDownloadQuota } from '../../../contexts/DownloadQuotaContext';
import { isDownloadLimitError, showDownloadLimitReached } from '../../../utils/downloadLimit';
import { useInputMode } from '../../../hooks/useInputMode';
import { holdLike, likedFromPayload, markLikeSaved, type LikeHolds } from './optimisticLikes';

import './GalleryStoryLayout.css';

const EMPTY_SELECTION: Set<number> = new Set();

type LikeIdentity = { guest_name?: string; guest_email?: string };
type PendingLikes = { ids: number[]; unlike: boolean; bulk: boolean };

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
  /** Filename caption on a card's hover; off unless the theme turns it on. */
  storyShowFilenames?: boolean;
  /** Footer title and text from the theme; empty keeps the defaults. */
  storyFooterTitle?: string;
  storyFooterText?: string;
}

/** A theme string as plain text: trimmed and clamped, '' when unusable. */
const footerString = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

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
  selectionQuotaPhotos,
  eventName,
  eventDate,
  allowDownloads = true,
  suppressEmptyState = false,
  emptyIsFiltered = false,
  afterGrid,
  beforeGrid,
  eventPhotoCount,
  onDownloadEverything,
  onCopyFilenames,
  copyFilenamesCount = 0,
  likedOnly = false,
  onToggleLikedOnly,
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
  storyShowFilenames = false,
  storyFooterTitle,
  storyFooterText,
  onLogout,
  showBackToAccount = false,
  onManageGallery,
  clientModeBusy,
  onUploadClick,
  showOriginalFilename = false,

  people,
  onSelectPerson,
  openPhotoId,
  onLightboxPhotoChange,
  isClient = false,
  onToggleVisibility,
}) => {
  // These props are passed by parent but we use our own feedback system, so mark as intentionally unused
  void _onPhotoClick;
  void _onOpenPhotoWithFeedback;
  void _onDownload;
  const archives = useArchiveDownload();
  const { t } = useTranslation();
  const [scrolled, setScrolled] = useState(false);
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

  // Per-viewer is_liked is the server's truth (#590 follow-up: like_count > 0
  // marked every photo with ANY likes as favorited). It used to be read once
  // on mount so a refetch could not clobber an in-session toggle, but that
  // left a like made in the lightbox invisible here, and Favourite selected
  // (issue 1716) decides what to toggle from this set. So the set follows
  // every payload, and a like the viewer just toggled holds its state until
  // a payload confirms it (optimisticLikes.ts).
  const likeHoldsRef = useRef<LikeHolds>(new Map());
  // Submits still running per photo: a quick like-unlike sends two, and the
  // first one finishing must not settle the hold of the second (issue 2561).
  const likeRunningRef = useRef<Map<number, number>>(new Map());
  // Photos where one of several overlapping submits failed: their hold
  // assumed every click reached the server.
  const likeFailedRef = useRef<Set<number>>(new Set());
  const photosRef = useRef(photos);
  photosRef.current = photos;
  // A like made in the lightbox reaches this set only through the parent's
  // refetch. Until that payload lands, Favourite selected would decide from
  // a set that is known to be behind, so it waits; a short timeout covers a
  // parent that never refetches.
  const [awaitingRefresh, setAwaitingRefresh] = useState(false);
  const awaitingRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Deliberately without the photo id, here and in runLikeBatch: this layout
  // asks for the whole list after a like. The favourites set and the wait
  // below assume one consistent payload; refreshing a single row instead
  // (issue 1891, as the other layouts do) made them act on a half-updated
  // list and undo saved likes.
  const handleLightboxFeedbackChange = useCallback(() => {
    if (onFeedbackChange) {
      setAwaitingRefresh(true);
      if (awaitingRefreshTimer.current) clearTimeout(awaitingRefreshTimer.current);
      awaitingRefreshTimer.current = setTimeout(() => setAwaitingRefresh(false), 5000);
      onFeedbackChange();
    }
  }, [onFeedbackChange]);
  useEffect(() => () => {
    if (awaitingRefreshTimer.current) clearTimeout(awaitingRefreshTimer.current);
  }, []);
  useEffect(() => {
    if (photos.length === 0) return;
    setAwaitingRefresh(false);
    if (awaitingRefreshTimer.current) {
      clearTimeout(awaitingRefreshTimer.current);
      awaitingRefreshTimer.current = null;
    }
    setFavorites(likedFromPayload(photos, likeHoldsRef.current));
  }, [photos]);

  // Get hero photo
  const heroPhoto = heroPhotoOverride || photos[0];

  // Group photos by category into scenes
  const scenes = useMemo<CategoryScene[]>(() => {
    const photosByCategory: PhotosByCategory = {};

    // Search is the gallery's shared one (issue 2543): `photos` arrives
    // already searched and filtered.
    // Group by category
    photos.forEach(photo => {
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
  }, [photos, t]);

  // #1160: on a folder-only root this component renders its shell with an empty
  // scope, so fall back to the event-wide count rather than announcing 0 Photos
  // directly above folder tiles that hold them.
  const totalPhotos = photos.length || eventPhotoCount || 0;
  // "12 Photos" stays as it was; with a video in scope the hero line becomes
  // the split ("9 photos · 3 videos"), like the admin grid (issue 1430, item 3).
  const videoTotal = photos.filter(isVideoItem).length;
  const hasVideos = videoTotal > 0;
  const stats = hasVideos
    ? mediaSplitLabel(t, splitMediaCount(totalPhotos, videoTotal))
    : `${totalPhotos} ${t('gallery.photos', 'Photos')}`;

  // Likes need an identity the server accepts (issue 1716, Codex review):
  // guest identity mode asks the context, which prompts on first use; simple
  // mode with require_name_email asks once through the modal and remembers
  // for the session, the way the Premium layout does. Shared by the card
  // heart and Favourite selected.
  const guestIdentity = useGuestIdentityOptional();
  // Card controls hidden until hover are shown outright for a finger (CSS).
  const inputMode = useInputMode();
  const [savedIdentity, setSavedIdentity] = useState<{ name: string; email: string } | null>(null);
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [pendingLikes, setPendingLikes] = useState<PendingLikes | null>(null);

  // The server /feedback like endpoint is a toggle (#590), so every id in a
  // batch changes in the same direction and only ids that need to change are
  // sent. A single card flips optimistically and flips back on failure; a
  // bulk batch applies what succeeded and reports the rest.
  const runLikeBatch = useCallback(async (ids: number[], unlike: boolean, identity: LikeIdentity, bulk: boolean) => {
    const apply = (target: number[], remove: boolean) => setFavorites((previous) => {
      const next = new Set(previous);
      target.forEach((id) => (remove ? next.delete(id) : next.add(id)));
      return next;
    });
    if (!bulk) apply(ids, unlike);
    // A single card shows its new state at once; a bulk batch keeps the old
    // one until it knows what succeeded.
    ids.forEach((id) => {
      holdLike(likeHoldsRef.current, id, bulk ? unlike : !unlike);
      likeRunningRef.current.set(id, (likeRunningRef.current.get(id) ?? 0) + 1);
    });
    const done: number[] = [];
    // A finished selection (issue 1733): the feedback service has said so.
    let locked = false;
    for (let i = 0; i < ids.length; i += 5) {
      const batch = ids.slice(i, i + 5);
      const results = await Promise.allSettled(
        batch.map((id) => feedbackService.submitFeedback(slug, String(id), { feedback_type: 'like', ...identity }))
      );
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') done.push(batch[index]);
        else if (feedbackLockKind(result.reason)) locked = true;
      });
    }
    const failed = ids.filter((id) => !done.includes(id));
    // Only a photo with no newer submit still running settles here; a newer
    // click's hold stays until its own submit finishes.
    const idle = (id: number) => {
      const running = Math.max(0, (likeRunningRef.current.get(id) ?? 0) - 1);
      if (running > 0) likeRunningRef.current.set(id, running);
      else likeRunningRef.current.delete(id);
      return running === 0;
    };
    failed.forEach((id) => likeFailedRef.current.add(id));
    done.filter(idle).forEach((id) => {
      // One of the overlapping submits failed: show the server's state.
      if (likeFailedRef.current.delete(id)) likeHoldsRef.current.delete(id);
      else {
        holdLike(likeHoldsRef.current, id, !unlike);
        markLikeSaved(likeHoldsRef.current, id);
      }
    });
    // Refused: the hold goes and the card shows the server's state.
    failed.filter(idle).forEach((id) => {
      likeFailedRef.current.delete(id);
      likeHoldsRef.current.delete(id);
    });
    // A refresh may have confirmed these while they ran, and an identical
    // later response can keep the same photos array: look at the current one.
    setFavorites(likedFromPayload(photosRef.current, likeHoldsRef.current));
    if (done.length > 0) {
      if (bulk) toast.success(t(unlike ? 'gallery.favoritesRemoved' : 'gallery.favoritesAdded', { count: done.length }));
      onFeedbackChange?.();
    }
    if (failed.length > 0) {
      if (bulk && !locked) toast.error(t('gallery.favoriteSelectedError'));
      else console.warn('Like submit failed');
    }
  }, [slug, t, onFeedbackChange]);

  // 'deferred' means the batch is parked behind the identity modal; the
  // caller keeps its busy state until handleIdentitySubmit or the modal's
  // close releases it.
  const likeWithIdentity = useCallback(async (ids: number[], unlike: boolean, bulk: boolean): Promise<'done' | 'deferred'> => {
    if (guestIdentity?.identityMode === 'guest') {
      try {
        await guestIdentity.ensureIdentity();
      } catch {
        return 'done';
      }
      await runLikeBatch(ids, unlike, {}, bulk);
      return 'done';
    }
    if (feedbackOptions?.requireNameEmail && !savedIdentity) {
      setPendingLikes({ ids, unlike, bulk });
      setShowIdentityModal(true);
      return 'deferred';
    }
    await runLikeBatch(
      ids,
      unlike,
      savedIdentity ? { guest_name: savedIdentity.name, guest_email: savedIdentity.email } : {},
      bulk
    );
    return 'done';
  }, [guestIdentity, feedbackOptions, savedIdentity, runLikeBatch]);

  const [favoritingSelection, setFavoritingSelection] = useState(false);

  const handleIdentitySubmit = useCallback(async (name: string, email: string) => {
    setSavedIdentity({ name, email });
    setShowIdentityModal(false);
    const pending = pendingLikes;
    setPendingLikes(null);
    if (!pending) return;
    try {
      await runLikeBatch(pending.ids, pending.unlike, { guest_name: name, guest_email: email }, pending.bulk);
    } finally {
      if (pending.bulk) setFavoritingSelection(false);
    }
  }, [pendingLikes, runLikeBatch]);

  const handleIdentityClose = useCallback(() => {
    setShowIdentityModal(false);
    if (pendingLikes?.bulk) setFavoritingSelection(false);
    setPendingLikes(null);
  }, [pendingLikes]);

  const handleToggleFavorite = useCallback((photoId: number) => {
    void likeWithIdentity([photoId], favorites.has(photoId), false);
  }, [favorites, likeWithIdentity]);

  // The photos the grid shows, in its order: the category scenes applied.
  // The lightbox steps through these, in the order the scenes show them.
  const visiblePhotos = useMemo(() => scenes.flatMap((scene) => scene.photos), [scenes]);
  // The row above the scenes acts on what they show (issues 2355, 2543).
  const toolbar = typeof beforeGrid === 'function' ? beforeGrid(visiblePhotos) : beforeGrid;

  // In a large gallery a grid mounts only the rows near the viewport (issue
  // 2193). A small scene stays whole, for the reason a small Timeline group
  // does. Carousels are not grids: they keep every slide.
  const windowScene = (scene: CategoryScene) => visiblePhotos.length >= WINDOW_MIN_PHOTOS
    && scene.photos.length >= TIMELINE_GROUP_WINDOW_MIN_PHOTOS;
  // Which cards have made their entrance, for a large gallery only: a filter
  // that takes it below the threshold must not replay them either.
  const revealedRef = useRef(new Set<number>());
  const revealed = photos.length >= WINDOW_MIN_PHOTOS ? revealedRef.current : undefined;

  const handleOpenLightbox = useCallback((photo: Photo) => {
    const index = visiblePhotos.findIndex(p => p.id === photo.id);
    setLightboxIndex(index >= 0 ? index : 0);
    onLightboxPhotoChange?.(photo.id, 'open');
  }, [visiblePhotos, onLightboxPhotoChange]);

  // Link to a single photo (issue 1733): open on the photo the URL asks for,
  // close on null. A photo a search or filter hides is the container's to
  // bring back (it clears them); an id not in `photos` opens nothing.
  useEffect(() => {
    if (openPhotoId === undefined) return;
    if (openPhotoId === null) {
      setLightboxIndex(null);
      return;
    }
    const index = visiblePhotos.findIndex((photo) => photo.id === openPhotoId);
    if (index >= 0) setLightboxIndex(index);
  }, [openPhotoId, visiblePhotos]);

  const downloadQuota = useDownloadQuota();

  // Selection mode (issue 1716). The container owns the mode and the set;
  // this layout only renders the controls and asks for changes.
  const selected = selectedPhotos ?? EMPTY_SELECTION;
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
  // Likes are a per-event sub-toggle (#506) under the feedback master switch:
  // with either off the like endpoint answers 403, so neither the card hearts
  // nor the bulk control are offered.
  const likesAllowed = feedbackEnabled && feedbackOptions?.allowLikes !== false;
  // As the other layouts' "Rate selected": off with ratings off for the event.
  const ratingsAllowed = feedbackEnabled && !!feedbackOptions?.allowRatings && !!slug;
  // The client's per-photo hide/show button (issue 1992); guests get none.
  const clientToggleVisibility = isClient ? onToggleVisibility : undefined;
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

  // Likes not yet set on the selection are added; a selection that is already
  // liked throughout is unliked instead, so the same control never un-likes
  // half a selection by accident.
  //
  // The whole selection, photos the shared search hides included (issue
  // 2543): the button counts all of it, so it must act on all of it.
  // `favorites` only knows the photos on screen, so a hidden photo's like
  // comes from its pending hold or its payload.
  const selectionIds = useMemo(
    () => (selectionQuotaPhotos ?? selectedPhotoList).map((photo) => photo.id),
    [selectionQuotaPhotos, selectedPhotoList]
  );
  const selectionToLike = useMemo(() => {
    const visibleIds = new Set(photos.map((photo) => photo.id));
    const hiddenById = new Map((selectionQuotaPhotos ?? []).map((photo) => [photo.id, photo as Partial<Photo>]));
    const isLiked = (id: number) => (visibleIds.has(id)
      ? favorites.has(id)
      : likeHoldsRef.current.get(id)?.liked ?? !!hiddenById.get(id)?.is_liked);
    return selectionIds.filter((id) => !isLiked(id));
  }, [selectionIds, selectionQuotaPhotos, photos, favorites]);
  const selectionUnlikes = selectionIds.length > 0 && selectionToLike.length === 0;

  const handleFavoriteSelected = useCallback(async () => {
    const ids = selectionUnlikes ? selectionIds : selectionToLike;
    if (ids.length === 0 || favoritingSelection) return;
    setFavoritingSelection(true);
    let outcome: 'done' | 'deferred' = 'done';
    try {
      outcome = await likeWithIdentity(ids, selectionUnlikes, true);
    } finally {
      if (outcome !== 'deferred') setFavoritingSelection(false);
    }
  }, [selectionUnlikes, selectionIds, selectionToLike, favoritingSelection, likeWithIdentity]);

  // The id fallback only runs when a category opts out of downloads (#640),
  // so it leaves those photos out, as the server would: a part made only of
  // them would come back empty and stop the parts after it.
  const downloadablePhotos = useMemo(
    () => photos.filter((photo) => photo.category_allow_downloads !== false),
    [photos]
  );
  const handleDownloadAll = useCallback(async () => {
    // Whole-gallery path when available: posting ids would hit the server's
    // 500-id cap and silently truncate a large gallery (#1160).
    if (onDownloadEverything) {
      onDownloadEverything();
      return;
    }
    const ids = downloadablePhotos.map(p => p.id);
    if (ids.length === 0) return;
    // Download limit (issue 1560): all or nothing, so refuse before asking.
    if (!downloadQuota.allows(downloadablePhotos)) {
      showDownloadLimitReached({ remaining: downloadQuota.remaining ?? 0 });
      return;
    }
    // One archive takes at most SELECTED_DOWNLOAD_LIMIT ids, so a larger set
    // goes as several zips rather than being cut short.
    const parts = splitIntoArchives(ids).length;
    // #858: hand off to the resolution picker when the gallery offers a choice.
    // The picker builds one archive, so past the cap it is skipped and the
    // parts come at the gallery's standard size.
    if (parts === 1 && downloadChoices && downloadChoices.length > 1 && onPickResolution) {
      onPickResolution(ids);
      return;
    }
    toast.info(parts > 1
      ? t('gallery.downloadingInParts', { count: ids.length, parts })
      : t('gallery.downloading', { count: ids.length }));
    try {
      if (!await archives.downloadPhotosInParts(slug, ids)) return;
      analyticsService.trackGalleryEvent('bulk_download', { gallery: slug, photo_count: ids.length });
    } catch (error) {
      if (!isDownloadLimitError(error)) toast.error(t('gallery.downloadError'));
    }
  }, [archives, downloadablePhotos, onDownloadEverything, slug, t, downloadChoices, onPickResolution, downloadQuota]);

  // Needs something to download: either the whole-gallery callback, or
  // downloadable photos in the current scope. On a folder-only root of a gallery with
  // a category download opt-out it has neither, and posting an empty id
  // list is a 400 (#1160). Shared by the nav button (issue 1710) and the
  // footer button so both appear and disappear together.
  const canDownloadAll = allowDownloads && Boolean(onDownloadEverything || downloadablePhotos.length > 0);
  const downloadAllLabel = t('common.downloadAll', 'Download All');
  const naturalGrid = storyGridMode === 'natural';
  const uploadLabel = t('upload.uploadPhotos', 'Upload Photos');
  // The caption names the photo the way the lightbox does: the uploaded
  // filename when the gallery shows original filenames (#508).
  const caption = !storyShowFilenames ? 'none' : showOriginalFilename ? 'original' : 'filename';

  // #1160: a folder-only root has no photos to show here, but the folder tiles
  // above prove the gallery isn't empty — render the shell (hero, logout,
  // controls) without the contradictory message. A search or filter that
  // left nothing keeps the shell too (issue 2543), so the toolbox that set it
  // stays mounted, with the message in place of the scenes.
  if (photos.length === 0 && !suppressEmptyState && !emptyIsFiltered) {
    return (
      <div className="text-center py-12">
        {/* A filter that left nothing keeps its own controls, so it can be
            cleared from here (issue 2355). */}
        {toolbar && <div className="story-toolbar story-toolbar--empty">{toolbar}</div>}
        {/* No nav in this branch, so the way back to the portal sits here. */}
        {showBackToAccount && (
          <div className="mb-4 flex justify-center">
            <BackToAccountLink alwaysLabelled className="inline-flex items-center gap-1.5 text-sm text-muted-theme hover:text-theme" />
          </div>
        )}
        {onManageGallery && <Button variant="outline" className="mb-4" onClick={onManageGallery} disabled={clientModeBusy}
          leftIcon={<Shield className="w-4 h-4" />}>
          {isClient ? t('clientAccess.returnToGallery', 'Return to gallery') : t('clientAccess.manageGallery', 'Manage Gallery')}
        </Button>}
        {likedOnly
          ? <LikedOnlyEmptyMessage onShowAll={onToggleLikedOnly} />
          : <GalleryEmptyMessage filtered={emptyIsFiltered} />}
        {/* No nav in this branch, and an upload-only gallery starts empty:
            the guest still needs a way to add the first photos. */}
        {onUploadClick && (
          <Button
            variant="primary"
            className="mt-4"
            leftIcon={<Upload className="w-4 h-4" />}
            onClick={onUploadClick}
            data-gallery-focus="upload"
          >
            {uploadLabel}
          </Button>
        )}
        {/* Event-wide like the nav button (issue 1733, A3d): a filter that
            leaves nothing on screen must not take the favourites' list with it. */}
        {onCopyFilenames && copyFilenamesCount > 0 && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              leftIcon={<ClipboardList className="w-4 h-4" />}
              onClick={onCopyFilenames}
              className="text-xs sm:text-sm"
            >
              {t('gallery.copyFilenames.button', 'Copy filenames')} ({copyFilenamesCount})
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    // Numbered against the list this layout's lightbox steps through, in
    // scene order (issue 1733, E6).
    <PhotoLabelsProvider photos={visiblePhotos}>
    <div className="gallery-story-layout" data-input-mode={inputMode}>
      <StoryScrollToTop />

      {/* Navigation Overlay */}
      <nav className={`story-nav ${scrolled ? 'scrolled' : ''}${isSelectionMode && selectionAvailable ? ' story-nav--selecting' : ''}`}>
        {/* The way back to the portal, ahead of the monogram. */}
        <div className="flex items-center gap-2">
          {showBackToAccount && (
            <BackToAccountLink className="story-nav-btn story-nav-back inline-flex items-center gap-1.5 text-sm" />
          )}
          <span className="story-nav-logo">
            {eventName ? eventName.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase() : 'GALLERY'}
          </span>
        </div>

        <div className="story-nav-actions">
          <PhotoSalesCartButton />
          {/* Issue 1710: the footer button was the only Download All in the
              layout, unreachable without scrolling through every scene. Same
              handler, same resolution / quota / whole-gallery flow. */}
          {/* Guest upload: this layout has no gallery header, which is where
              every other layout offers it. */}
          {onUploadClick && (
            <button
              type="button"
              className="story-nav-btn"
              onClick={onUploadClick}
              aria-label={uploadLabel}
              title={uploadLabel}
              data-testid="story-nav-upload"
              data-gallery-focus="upload"
            >
              <Upload size={20} />
            </button>
          )}
          {canSelect && (
            <button
              type="button"
              className={`story-nav-btn${isSelectionMode ? ' active' : ''}`}
              onClick={handleToggleSelectionMode}
              aria-pressed={isSelectionMode}
              aria-label={isSelectionMode ? t('gallery.cancelSelection', 'Cancel Selection') : selectLabel(t, hasVideos)}
              title={isSelectionMode ? t('gallery.cancelSelection', 'Cancel Selection') : selectLabel(t, hasVideos)}
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
          {/* Filename list (issue 1733, A3d): in the fixed nav, where every
              other gallery-wide action of this layout lives; a band above the
              hero would sit under this nav on narrow phones. */}
          {onCopyFilenames && copyFilenamesCount > 0 && (
            <button
              type="button"
              className="story-nav-btn"
              onClick={onCopyFilenames}
              aria-label={`${t('gallery.copyFilenames.button', 'Copy filenames')} (${copyFilenamesCount})`}
              title={`${t('gallery.copyFilenames.button', 'Copy filenames')} (${copyFilenamesCount})`}
              data-testid="story-nav-copy-filenames"
            >
              <ClipboardList size={20} />
            </button>
          )}
          {likesAllowed && (
            // The gallery's "Liked" filter when the container offers it:
            // only the photos this viewer liked, until clicked again.
            <button
              type="button"
              className={`story-nav-btn${likedOnly ? ' active' : ''}`}
              onClick={onToggleLikedOnly}
              aria-pressed={onToggleLikedOnly ? likedOnly : undefined}
              aria-label={`${t('gallery.showLikedOnly', 'Show only photos I liked')}${favorites.size > 0 ? ` (${favorites.size})` : ''}`}
              title={t('gallery.favorites', 'Favorites')}
              data-testid="story-nav-liked"
              // Focus moves to "Show all photos" when the filter empties the view.
              data-gallery-focus="liked"
            >
              <Heart size={20} fill={likedOnly ? 'currentColor' : 'none'} />
              {favorites.size > 0 && (
                <span className="story-nav-favorites-count">
                  {favorites.size > 9 ? '9+' : favorites.size}
                </span>
              )}
            </button>
          )}
          {onManageGallery && (
            <button className="story-nav-btn" onClick={onManageGallery} disabled={clientModeBusy}
              aria-label={isClient ? t('clientAccess.returnToGallery', 'Return to gallery') : t('clientAccess.manageGallery', 'Manage Gallery')}
              title={isClient ? t('clientAccess.returnToGallery', 'Return to gallery') : t('clientAccess.manageGallery', 'Manage Gallery')}>
              <Shield size={20} />
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

        {/* Selection bar (issue 1716): a second row of the fixed nav, so it can
            never sit under it. Count, select all, and the bulk actions on the
            selection; download goes through the container's handler so the
            resolution picker and the download limit apply exactly as they do
            on every other layout. */}
        {isSelectionMode && selectionAvailable && (
          <div className="story-selection-bar" role="region" aria-label={selectLabel(t, hasVideos)}>
            <span className="story-selection-count" aria-live="polite">
              {t('gallery.photosSelected', { count: selected.size })}
            </span>
            <div className="story-selection-actions">
              <button type="button" className="story-selection-btn" onClick={handleSelectAllVisible}>
                {allVisibleSelected ? t('gallery.deselectAll', 'Deselect All') : t('gallery.selectAll', 'Select All')}
              </button>
              {likesAllowed && selected.size > 0 && (
                <button
                  type="button"
                  className="story-selection-btn"
                  onClick={handleFavoriteSelected}
                  disabled={favoritingSelection || awaitingRefresh}
                  aria-label={t(selectionUnlikes ? 'gallery.unfavoriteSelected' : 'gallery.favoriteSelected', { count: selected.size })}
                  data-testid="story-favorite-selected"
                >
                  <Heart size={14} fill={selectionUnlikes ? 'currentColor' : 'none'} />
                  {/* Full label from sm up; count only on a phone, where three
                      rows of pills would otherwise eat a quarter of the screen. */}
                  <span className="hidden sm:inline">
                    {t(selectionUnlikes ? 'gallery.unfavoriteSelected' : 'gallery.favoriteSelected', { count: selected.size })}
                  </span>
                  <span className="sm:hidden" aria-hidden="true">({selected.size})</span>
                </button>
              )}
              {/* Rate selected (issue 1985): tiles here show no rating, so
                  the result comes back as a toast. Icon only on a phone. */}
              {ratingsAllowed && selected.size > 0 && (
                <BulkRatingPopover
                  slug={slug}
                  photoIds={Array.from(selected)}
                  requireNameEmail={feedbackOptions?.requireNameEmail}
                  className="story-rate"
                  triggerClassName="story-selection-btn"
                  popoverClassName="story-rate-popover"
                >
                  <span className="hidden sm:inline">{t('feedback.rateSelected', 'Rate selected')}</span>
                </BulkRatingPopover>
              )}
              {allowDownloads && onDownloadSelected && selected.size > 0 && (
                <button
                  type="button"
                  className="story-selection-btn story-selection-btn--primary"
                  onClick={() => { void onDownloadSelected(); }}
                  disabled={!downloadQuota.allows(selectionQuotaPhotos ?? selectedPhotoList)}
                  data-testid="story-download-selected"
                >
                  <Package size={14} />
                  <span className="hidden sm:inline">{t('gallery.downloadSelected', { count: selected.size })}</span>
                  <span className="sm:hidden">{t('common.download', 'Download')} ({selected.size})</span>
                </button>
              )}
              <button
                type="button"
                className="story-selection-btn"
                onClick={handleToggleSelectionMode}
                aria-label={t('gallery.cancelSelection', 'Cancel Selection')}
              >
                <X size={14} />
                <span className="hidden sm:inline">{t('common.cancel', 'Cancel')}</span>
              </button>
            </div>
          </div>
        )}
      </nav>

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

      {/* Below the hero, so the fixed nav keeps the hero behind it (issue 2355). */}
      {toolbar && <div className="story-toolbar">{toolbar}</div>}
      {photos.length === 0 && emptyIsFiltered && (
        <div className="text-center py-24 px-4">
          {likedOnly
            ? <LikedOnlyEmptyMessage onShowAll={onToggleLikedOnly} />
            : <GalleryEmptyMessage filtered />}
        </div>
      )}

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
                  onToggleVisibility={clientToggleVisibility}
                  caption={caption}
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
                  onToggleVisibility={clientToggleVisibility}
                  caption={caption}
                  windowed={windowScene(scene)}
                  revealed={revealed}
                />
              ) : (
                <StoryFixedGrid
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
                  onToggleVisibility={clientToggleVisibility}
                  caption={caption}
                  windowed={windowScene(scene)}
                  revealed={revealed}
                />
              )}
            </StoryScene>
          );
        })}
      </main>

      {afterGrid && <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">{afterGrid}</div>}

      {/* Footer */}
      <footer className="story-footer">
        {/* Rendered as text, never HTML. The footer's own text wins; without
            it the welcome message closes the story, as it always has. */}
        <h2 className="story-footer-title">
          {footerString(storyFooterTitle, STORY_FOOTER_TITLE_MAX) || t('gallery.thankYou', 'Thank You')}
        </h2>
        <p className="story-footer-text">
          {footerString(storyFooterText, STORY_FOOTER_TEXT_MAX)
            || welcomeMessage
            || t('gallery.thankYouMessage', 'For being part of our story and making our special day unforgettable.')}
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
      {/* Not over an emptied list: the container closes it a render later. */}
      {lightboxIndex !== null && visiblePhotos.length > 0 && (
        <PhotoLightbox
          photos={visiblePhotos}
          initialIndex={lightboxIndex}
          onClose={() => {
            setLightboxIndex(null);
            onLightboxPhotoChange?.(null, 'close');
          }}
          slug={slug}
          feedbackEnabled={feedbackEnabled}
          allowDownloads={allowDownloads}
          protectionLevel={protectionLevel}
          useEnhancedProtection={useEnhancedProtection}
          useCanvasRendering={useCanvasRendering}
          onFeedbackChange={handleLightboxFeedbackChange}
          showOriginalFilename={showOriginalFilename}
          // #1074: this layout renders its own lightbox, so the people props
          // have to be threaded through explicitly or the "In this photo"
          // chips silently disappear on the Story theme.
          people={people}
          onSelectPerson={onSelectPerson}
          onCurrentPhotoChange={(photoId) => onLightboxPhotoChange?.(photoId, 'step')}
        />
      )}

      <FeedbackIdentityModal
        isOpen={showIdentityModal}
        onClose={handleIdentityClose}
        onSubmit={handleIdentitySubmit}
        feedbackType="like"
      />
    </div>
    </PhotoLabelsProvider>
  );
};
