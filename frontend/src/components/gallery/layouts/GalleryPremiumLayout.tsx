import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { GalleryEmptyMessage, LikedOnlyEmptyMessage } from '../GalleryEmptyMessage';
import { createPortal } from 'react-dom';
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
import { ColorLabelBadge } from '../ColorLabelBadge';
import { FirstLookBadge } from '../GalleryTileBadges';
import { ClientVisibilityToggle, isHiddenFromGuests } from '../ClientVisibilityToggle';
import 'yet-another-react-lightbox/plugins/captions.css';
import { motion, AnimatePresence } from 'framer-motion';
import { Download as DownloadIcon, Heart, Check, Star, MessageSquare, Package, LogOut, Upload, ClipboardList } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { parseISO } from 'date-fns';
import { useInView } from 'react-intersection-observer';

import type { BaseGalleryLayoutProps } from './BaseGalleryLayout';
import type { Photo } from '../../../types';
import { Button, PoweredBy } from '../../common';
import { thumbnailUrlForTile } from '../imageTiers';
import { TileImage } from '../TileImage';
import { PhotoLabelsProvider, usePhotoLabels } from '../PhotoLabels';
import { feedbackService } from '../../../services/feedback.service';
import { PhotoReactions } from '../PhotoReactions';
import { useGuestIdentityOptional } from '../../../contexts/GuestIdentityContext';
import { feedbackLockKind } from '../../../utils/feedbackLock';
import { useInputMode } from '../../../hooks/useInputMode';
import { holdLike, likedFromPayload, markLikeSaved, type LikeHolds } from './optimisticLikes';
import { FeedbackIdentityModal } from '../FeedbackIdentityModal';
import { galleryService, splitIntoArchives } from '../../../services/gallery.service';
import { analyticsService } from '../../../services/analytics.service';
import { useDownloadPhoto } from '../../../hooks/useGallery';
import { useDownloadQuota } from '../../../contexts/DownloadQuotaContext';
import { useDownloadChoice } from '../../../contexts/DownloadChoiceContext';
import { DownloadQuotaNotice } from '../DownloadQuotaNotice';
import { isDownloadLimitError, showDownloadLimitReached } from '../../../utils/downloadLimit';
import { toast } from 'react-toastify';

import './GalleryPremiumLayout.css';
import { lightboxImageUrl } from '../imageTiers';
import { exifLine } from '../../../utils/photoExif';
import { renderPremiumLightboxImage } from './PremiumLightboxImage';
import { PremiumLightboxDownloadButton } from './PremiumLightboxDownloadButton';
import { isPhotoDownloadPending } from '../../../hooks/usePhotoDownloadPending';

const isVideoPhoto = (photo: Photo) => photo.media_type === 'video' || photo.type === 'video';

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
  useEnhancedProtection?: boolean;
  feedbackEnabled?: boolean;
  // #506: track the per-event "allow likes" toggle so the per-photo
  // Like button respects it. `feedbackEnabled` alone isn't enough —
  // an event can have feedback on but likes specifically disabled.
  allowLikes?: boolean;
  index: number;
  /** The client's hide/show handler (issue 1992); set only for the client. */
  onToggleVisibility?: (photoId: number, currentVisibility: string) => void;
}

const PhotoCard: React.FC<PhotoCardProps> = ({
  photo,
  width,
  height,
  onClick,
  onLike,
  onSelect,
  isSelected,
  isSelectionMode,
  isLiked,
  slug,
  feedbackEnabled = false,
  allowLikes = false,
  index,
  onToggleVisibility,
}) => {
  // The height MasonryPhotoAlbum computed from photos.width/height is used,
  // not discarded (#1130). Letting the tile size itself from the image meant
  // the rendered shape came from whatever rendition happened to be served —
  // and with thumbnail_fit seeded to 'cover' (migration 040) every rendition
  // is square, so the masonry laid out 79 identical squares and was
  // indistinguishable from the fixed grid. The photo's real aspect ratio is
  // in the DB and is what the album already laid out against.
  const { ref, inView } = useInView({
    triggerOnce: true,
    threshold: 0.1,
  });

  // Responsive tier (#1095). This layout has its own card rather than the
  // shared PhotoCard, so it needs its own call — but MasonryPhotoAlbum hands
  // the laid-out tile width straight to the render prop, so the measurement
  // the shared card has to take is simply a parameter here.
  const isVideo = photo.media_type === 'video' || photo.type === 'video';
  const tieredSrc = (!isVideo && photo.thumbnail_url
    ? thumbnailUrlForTile(photo.thumbnail_url, photo, width)
    : null) || photo.thumbnail_url || photo.url;
  const photoLabels = usePhotoLabels();

  const likeCount = photo.like_count ?? 0;
  const averageRating = photo.average_rating ?? 0;
  const commentCount = photo.comment_count ?? 0;

  return (
    <motion.div
      ref={ref}
      className={`gallery-premium-photo-card group ${isSelected ? 'selected' : ''}`}
      style={{ width: '100%', height, display: 'block' }}
      initial={{ opacity: 0, y: 20 }}
      animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
      transition={{ duration: 0.4, delay: Math.min(index * 0.05, 0.3) }}
      onClick={onClick}
      data-testid={`photo-card-${photo.id}`}
    >
      <TileImage
        // Blurred placeholder (issue 1733). Every card mounts its image at
        // page load here, so the hash is only handed over (and decoded) once
        // the card is in view.
        thumbHash={inView ? photo.thumb_hash : null}
        src={tieredSrc}
        alt={photoLabels.of(photo, photo.filename)}
        // No inline height: the card now has a definite one, so the
        // stylesheet's `.gallery-premium-photo-card img { height: 100% }` can
        // finally apply and object-fit: cover crops a square rendition INTO
        // the correctly-shaped tile, rather than the rendition dictating the
        // tile's shape.
        // Dimmed when the client hid it from guests, as in Grid (issue 1992).
        // Important: `.gallery-premium-photo-card.selected img` sets its own
        // opacity and would otherwise undim a hidden photo once selected.
        className={`w-full h-full object-cover${onToggleVisibility && isHiddenFromGuests(photo) ? ' !opacity-40' : ''}`}
        loading="lazy"
        isGallery={true}
        slug={slug}
      />

      {/* Colour label (#1044) — same badge every layout uses. For the client
          the dots move into the visibility toggle's row below. */}
      <ColorLabelBadge
        colorLabel={photo.my_color_label}
        otherColorLabels={photo.other_color_labels}
        decision={photo.my_decision}
        part={onToggleVisibility ? 'ring' : undefined}
      />

      {/* Overlay Gradient */}
      <div className="gallery-premium-photo-overlay" />

      {/* First look (issue 1562): bottom-left like the shared card, lifted
          above the feedback indicators that own that corner here. No folder
          hint (issue 1786) on this card: its top corners hold the checkbox and
          a like button that is always shown on touch. */}
      <FirstLookBadge
        photo={photo}
        className={feedbackEnabled && (likeCount > 0 || averageRating > 0 || commentCount > 0 || isLiked)
          ? 'bottom-10 left-2'
          : 'bottom-2 left-2'}
      />


      {/* Selection Checkbox */}
      <button
        onClick={onSelect}
        className={`gallery-premium-checkbox ${isSelected || isSelectionMode ? 'visible' : ''} ${isSelected ? 'selected' : ''}`}
      >
        {isSelected && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
      </button>

      {/* The client's hide/show button (issue 1992), with the colour-label
          dots beside it. The checkbox owns this card's top-left corner, so the
          row sits right of it at the checkbox's height: a short panoramic tile
          clipped anything placed below the checkbox. */}
      {onToggleVisibility && (
        <div className="absolute top-2 left-14 z-10 flex items-center gap-1.5">
          <ClientVisibilityToggle photo={photo} onToggle={onToggleVisibility} />
          <ColorLabelBadge
            colorLabel={photo.my_color_label}
            otherColorLabels={photo.other_color_labels}
            decision={photo.my_decision}
            part="dots"
          />
        </div>
      )}

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
              <Heart className="w-3.5 h-3.5 text-danger" fill="currentColor" />
            </span>
          )}
          {averageRating > 0 && (
            <span className="gallery-premium-feedback-indicator" title="Rated">
              <Star className="w-3.5 h-3.5 text-rating" fill="currentColor" />
            </span>
          )}
          {commentCount > 0 && (
            <span className="gallery-premium-feedback-indicator" title="Commented">
              <MessageSquare className="w-3.5 h-3.5 text-info" fill="currentColor" />
            </span>
          )}
        </div>
      )}
    </motion.div>
  );
};

interface GalleryPremiumLayoutProps extends BaseGalleryLayoutProps {
  heroPhotoOverride?: Photo | null;
  suppressEmptyState?: boolean;
}

export const GalleryPremiumLayout: React.FC<GalleryPremiumLayoutProps> = ({
  // #1160: folder-only root — render the shell, skip the empty message.
  suppressEmptyState = false,
  emptyIsFiltered = false,
  afterGrid,
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
  onSelectMany,
  onToggleSelectionMode,
  selectionQuotaPhotos,
  onDownloadEverything,
  eventName,
  eventDate,
  allowDownloads = true,
  downloadChoices,
  onPickResolution,
  protectionLevel = 'standard',
  useEnhancedProtection = false,
  useCanvasRendering = false,
  feedbackEnabled = false,
  feedbackOptions,
  heroPhotoOverride,
  onLogout,
  onUploadClick,
  onCopyFilenames,
  copyFilenamesCount = 0,
  showOriginalFilename = false,
  openPhotoId,
  onLightboxPhotoChange,
  isClient = false,
  onToggleVisibility,
  likedOnly = false,
  onToggleLikedOnly,
}) => {
  // These props are passed by parent but we use our own lightbox, so mark as intentionally unused
  void _onPhotoClick;
  void _onOpenPhotoWithFeedback;
  void _onDownload;
  const { t, i18n } = useTranslation();
  const photoLabels = usePhotoLabels();
  const downloadPhotoMutation = useDownloadPhoto();
  const [lightboxIndex, setLightboxIndex] = useState(-1);
  // The delivered preview can be smaller than the original. Keep Zoom's
  // pixel limit/aspect ratio tied to the loaded rendition, as its default
  // image renderer does internally.
  const [imageDimensions, setImageDimensions] = useState<Record<string, { width: number; height: number }>>({});
  const handleLightboxImageLoad = useCallback((src: string, dimensions: { width: number; height: number }) => {
    setImageDimensions((previous) => (
      previous[src]?.width === dimensions.width && previous[src]?.height === dimensions.height
        ? previous
        : { ...previous, [src]: dimensions }
    ));
  }, []);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [likedPhotoIds, setLikedPhotoIds] = useState<Set<number>>(new Set());
  // Per-viewer is_liked is the server's truth (#590 follow-up). Seeding it
  // once on mount left the nav count behind every later refetch, so the set
  // follows each payload, and a like the viewer just toggled holds its state
  // until a payload confirms it (optimisticLikes.ts).
  const pendingLikesRef = useRef<LikeHolds>(new Map());
  useEffect(() => {
    setLikedPhotoIds(likedFromPayload(photos, pendingLikesRef.current));
  }, [photos]);
  const [savedIdentity, setSavedIdentity] = useState<{ name: string; email: string } | null>(null);
  // Emoji reactions (#839) inside the premium lightbox. This layout uses
  // yet-another-react-lightbox instead of the shared PhotoLightbox, so the
  // reaction bar is a fixed overlay fed by its own per-photo fetch.
  const [reactionState, setReactionState] = useState<{
    photoId: number;
    mine: string | null;
    counts: Record<string, number>;
  } | null>(null);
  const guestIdentity = useGuestIdentityOptional();
  const inputMode = useInputMode();
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

  const currentLightboxPhoto = lightboxIndex >= 0 ? filteredPhotos[lightboxIndex] : null;

  // The photo the lightbox is on, by id: `lightboxIndex` is a position in
  // `filteredPhotos`, which a filter or category change can shift under it.
  // When that photo leaves the list while others remain, the slide at the
  // old index is a different photo and YARL fires no `view` for it, so the
  // URL would keep the old `?photo=`. Clamp onto a neighbour and report the
  // step, as the standard lightbox does; with no slides left, close.
  const lightboxPhotoIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (lightboxIndex < 0 || lightboxPhotoIdRef.current === null) return;
    if (filteredPhotos.some((photo) => photo.id === lightboxPhotoIdRef.current)) return;
    if (filteredPhotos.length === 0) {
      lightboxPhotoIdRef.current = null;
      setLightboxIndex(-1);
      onLightboxPhotoChange?.(null, 'close');
      return;
    }
    const next = Math.min(lightboxIndex, filteredPhotos.length - 1);
    lightboxPhotoIdRef.current = filteredPhotos[next].id;
    setLightboxIndex(next);
    onLightboxPhotoChange?.(filteredPhotos[next].id, 'step');
  }, [filteredPhotos, lightboxIndex, onLightboxPhotoChange]);

  // Link to a single photo (issue 1733): open on the photo the URL asks for,
  // close on null. This layout filters by category on its own, so a linked
  // photo hidden by that chip clears it first; an id not in `photos` opens
  // nothing.
  useEffect(() => {
    if (openPhotoId === undefined) return;
    if (openPhotoId === null) {
      setLightboxIndex(-1);
      return;
    }
    const index = filteredPhotos.findIndex((photo) => photo.id === openPhotoId);
    if (index >= 0) {
      lightboxPhotoIdRef.current = openPhotoId;
      setLightboxIndex(index);
    } else if (photos.some((photo) => photo.id === openPhotoId)) {
      setActiveCategory(null);
    }
  }, [openPhotoId, filteredPhotos, photos]);

  const reactionsActive = feedbackEnabled && !!feedbackOptions?.allowReactions;

  // Fetch the current photo's reaction tallies + my selection when the
  // lightbox lands on it. Optimistic updates below keep it fresh in place.
  useEffect(() => {
    if (!currentLightboxPhoto || !reactionsActive) {
      setReactionState(null);
      return undefined;
    }
    let alive = true;
    feedbackService.getPhotoFeedback(slug, String(currentLightboxPhoto.id))
      .then((d) => {
        if (!alive) return;
        setReactionState({
          photoId: currentLightboxPhoto.id,
          mine: d.my_feedback.reaction || null,
          counts: d.reactions || {},
        });
      })
      .catch(() => { /* bar simply stays hidden for this photo */ });
    return () => { alive = false; };
  }, [currentLightboxPhoto?.id, reactionsActive, slug]);

  const handleReactionChange = useCallback((next: string | null) => {
    setReactionState((prev) => {
      if (!prev) return prev;
      const counts = { ...prev.counts };
      if (prev.mine) counts[prev.mine] = Math.max(0, (counts[prev.mine] || 0) - 1);
      if (next) counts[next] = (counts[next] || 0) + 1;
      return { ...prev, mine: next, counts };
    });
    onFeedbackChange?.();
  }, [onFeedbackChange]);

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
  // when the admin has flipped the original-filenames toggle (#508), or as
  // "Photo 12 of 84" under neutral photo labels (issue 1733, E6).
  const slides = useMemo(() => {
    return filteredPhotos.map((photo, index) => ({
      // Display source, not the original (#1166). This layout returns early
      // from PhotoGridWithLayouts and never renders PhotoLightbox, so it needs
      // its own call — without it a premium gallery keeps pulling
      // multi-megabyte originals to show a photo on screen. `download` below
      // deliberately stays on photo.url: what a guest saves must be the full
      // original.
      // A video's original cannot render as an image slide anyway, and on a
      // gallery with a download limit fetching it takes a slot (issue 1560),
      // which a neighbour preload must not do: show its poster instead.
      src: isVideoPhoto(photo) ? (photo.thumbnail_url || photo.url) : lightboxImageUrl(photo),
      // The download handler used to recover the photo by matching slide.src
      // against photo.url. src is a derivative now, so that lookup would find
      // nothing and Download would silently do nothing (#1166 review).
      photoId: photo.id,
      alt: photoLabels.neutral ? photoLabels.at(index, filteredPhotos.length) : photo.filename,
      width: imageDimensions[lightboxImageUrl(photo)]?.width || photo.width || 1200,
      height: imageDimensions[lightboxImageUrl(photo)]?.height || photo.height || 800,
      thumbnail: photo.thumbnail_url || undefined,
      download: allowDownloads ? photo.url : undefined,
      title: photoLabels.neutral
        ? photoLabels.at(index, filteredPhotos.length)
        : showOriginalFilename
          ? (photo.original_filename || photo.filename)
          : undefined,
      // Photo credit (#1561), same wording as PhotoLightbox. Only present
      // when the gallery shows names to this viewer.
      // Camera details (issue 1733, D1) on a second line; the caption
      // plugin breaks a string at "\n".
      description: [
        photo.credit_name
          ? (photo.uploaded_by_guest
            ? t('gallery.credits.uploadedBy', { name: photo.credit_name })
            : t('gallery.credits.photoBy', { name: photo.credit_name }))
          : null,
        exifLine(photo.exif),
      ].filter(Boolean).join('\n') || undefined,
    }));
  }, [filteredPhotos, allowDownloads, showOriginalFilename, photoLabels, imageDimensions, t]);
  const showCaptions = showOriginalFilename || photoLabels.neutral || slides.some((slide) => !!slide.description);

  // Toggle — server /feedback like is a toggle (#590) — and remember the
  // state asked for until a payload confirms it.
  const toggleLikedOptimistically = (photoId: number) => setLikedPhotoIds(prev => {
    const next = new Set(prev);
    const liked = !next.has(photoId);
    if (liked) next.add(photoId);
    else next.delete(photoId);
    holdLike(pendingLikesRef.current, photoId, liked);
    return next;
  });
  // Saved: start the window in which the row refresh should confirm it.
  const likeSaved = useCallback((photoId: number) => markLikeSaved(pendingLikesRef.current, photoId), []);
  // Refused: the heart goes back and nothing is awaited.
  const rollBackLike = useCallback((photoId: number) => {
    pendingLikesRef.current.delete(photoId);
    setLikedPhotoIds(prev => {
      const next = new Set(prev);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  }, []);

  const handleLike = useCallback(async (photo: Photo, e: React.MouseEvent) => {
    e.stopPropagation();

    if (guestIdentity?.identityMode === 'guest') {
      try {
        await guestIdentity.ensureIdentity();
      } catch {
        return;
      }
      // Toggle — server /feedback like is a toggle (#590).
      toggleLikedOptimistically(photo.id);
      try {
        await feedbackService.submitFeedback(slug, String(photo.id), {
          feedback_type: 'like',
        });
        likeSaved(photo.id);
        onFeedbackChange?.(photo.id);
      } catch (err) {
        // Refused (a finished selection, issue 1733, or the like limit): the
        // heart goes back, so the nav count matches what the Liked filter,
        // which reads the server's is_liked, will show.
        rollBackLike(photo.id);
        if (!feedbackLockKind(err)) console.warn('Like submit failed', err);
      }
      return;
    }

    if (feedbackOptions?.requireNameEmail && !savedIdentity) {
      setPendingLikePhotoId(photo.id);
      setShowIdentityModal(true);
      return;
    }

    // Optimistic update — toggle, not add (#590).
    toggleLikedOptimistically(photo.id);

    try {
      await feedbackService.submitFeedback(slug, String(photo.id), {
        feedback_type: 'like',
        guest_name: savedIdentity?.name,
        guest_email: savedIdentity?.email,
      });
      likeSaved(photo.id);
      onFeedbackChange?.(photo.id);
    } catch (err) {
      rollBackLike(photo.id);
      if (!feedbackLockKind(err)) console.warn('Like submit failed', err);
    }
  }, [slug, savedIdentity, feedbackOptions, onFeedbackChange, guestIdentity, rollBackLike, likeSaved]);

  const handleIdentitySubmit = useCallback(async (name: string, email: string) => {
    setSavedIdentity({ name, email });
    setShowIdentityModal(false);

    if (pendingLikePhotoId) {
      // Toggle — server /feedback like is a toggle (#590). The identity
      // modal only fires the first time per session, so the user is
      // intentionally liking a not-yet-liked photo here, but keep the
      // setter shape consistent with the other paths.
      toggleLikedOptimistically(pendingLikePhotoId);

      try {
        await feedbackService.submitFeedback(slug, String(pendingLikePhotoId), {
          feedback_type: 'like',
          guest_name: name,
          guest_email: email,
        });
        likeSaved(pendingLikePhotoId);
        onFeedbackChange?.(pendingLikePhotoId);
      } catch (err) {
        rollBackLike(pendingLikePhotoId);
        if (!feedbackLockKind(err)) console.warn('Like submit failed', err);
      }
      setPendingLikePhotoId(null);
    }
  }, [slug, pendingLikePhotoId, onFeedbackChange, rollBackLike, likeSaved]);

  // Every photo on screen is selected — by id: equal sizes can be a
  // different set (a selection made under another category chip).
  const allSelected = filteredPhotos.length > 0 && filteredPhotos.every((photo) => selectedPhotos.has(photo.id));
  // Select all covers the photos on screen, not those under other category
  // chips (as Gallery Story's does, issue 1716).
  const handleSelectAll = useCallback(() => {
    if (allSelected) {
      onDeselectAll?.();
    } else if (onSelectMany) {
      onSelectMany(filteredPhotos.map((photo) => photo.id));
    } else {
      onSelectAll?.();
    }
  }, [allSelected, filteredPhotos, onSelectMany, onSelectAll, onDeselectAll]);

  // Download limit (issue 1560).
  const downloadQuota = useDownloadQuota();
  const downloadChoice = useDownloadChoice();
  // The whole selection, photos a search hides included: they are sent too.
  const selectedPhotoList = useMemo(
    () => selectionQuotaPhotos ?? photos.filter((photo) => selectedPhotos.has(photo.id)),
    [selectionQuotaPhotos, photos, selectedPhotos]
  );
  const selectionOverQuota = !downloadQuota.allows(selectedPhotoList);

  const handleDownloadSelected = useCallback(async () => {
    if (selectedPhotos.size === 0) return;
    const ids = Array.from(selectedPhotos);
    if (selectionOverQuota) {
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
      return;
    }
    // Downloaded: clear the selection and leave selection mode, as the grid
    // toolbar does. A failure keeps it to retry or trim.
    onDeselectAll?.();
    if (isSelectionMode) onToggleSelectionMode?.();
  }, [selectedPhotos, slug, t, downloadChoices, onPickResolution, selectionOverQuota, downloadQuota.remaining, onDeselectAll, isSelectionMode, onToggleSelectionMode]);

  // Same path as Gallery Story's Download All: the whole-gallery download
  // when the container offers it (#1160), else the ids in scope. That
  // fallback only runs when a category opts out of downloads (#640), so it
  // leaves those photos out, as the server would.
  const downloadablePhotos = useMemo(
    () => photos.filter((photo) => photo.category_allow_downloads !== false),
    [photos]
  );
  const handleDownloadAll = useCallback(async () => {
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
      await galleryService.downloadPhotosInParts(slug, ids);
      analyticsService.trackGalleryEvent('bulk_download', { gallery: slug, photo_count: ids.length });
    } catch (error) {
      if (!isDownloadLimitError(error)) toast.error(t('gallery.downloadError'));
    }
  }, [downloadablePhotos, onDownloadEverything, slug, t, downloadChoices, onPickResolution, downloadQuota]);

  const handleDownloadFromLightbox = useCallback((slide: { src?: string; photoId?: number }) => {
    if (!allowDownloads || !slide.src) return;

    // By id, carried on the slide. Matching on src broke the moment the slide
    // stopped being the original — and what Download hands over must stay the
    // original regardless of what is rendered.
    const photo = slide.photoId != null
      ? filteredPhotos.find(p => p.id === slide.photoId)
      : filteredPhotos.find(p => p.url === slide.src);
    // Issue 2043: a repeated tap while this photo is still being prepared.
    if (photo && isPhotoDownloadPending(photo.id)) return;
    if (photo && !downloadQuota.canDownload(photo)) {
      showDownloadLimitReached({ remaining: 0 });
      return;
    }
    if (photo) {
      // The download menu (issue 1733, E2): a size first, where there is a choice.
      downloadChoice.choose(photo, (resolution) => {
        analyticsService.trackDownload(photo.id, slug, false);
        downloadPhotoMutation.mutate({
          slug,
          photoId: photo.id,
          filename: photo.filename,
          resolution,
        });
      });
    }
  }, [allowDownloads, filteredPhotos, slug, downloadPhotoMutation, downloadQuota, downloadChoice]);

  // Long form on purpose (the hero's look), in the gallery's language rather
  // than always US English. parseISO: a bare yyyy-MM-dd read by `new Date`
  // is UTC midnight, the day before west of UTC.
  const formattedDate = eventDate ? parseISO(eventDate).toLocaleDateString(i18n.language, {
    year: 'numeric',
    month: 'long',
    day: '2-digit'
  }) : null;
  const uploadLabel = t('upload.uploadPhotos', 'Upload Photos');

  // #1160: a folder-only root has no photos to show here, but the folder tiles
  // above prove the gallery isn't empty — render the shell (hero, logout,
  // controls) without the contradictory message.
  if (photos.length === 0 && !suppressEmptyState) {
    return (
      <div className="text-center py-12">
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
    // Tiles are numbered against the list this layout's lightbox steps
    // through, which a category filter narrows (issue 1733, E6).
    <PhotoLabelsProvider photos={filteredPhotos}>
    {/* #1275 — the stylesheet keys its touch rules off this rather than a
        primary-pointer media query, so the checkbox and like button follow
        the input actually in use on a device that has both. */}
    <div className="gallery-premium-layout" data-input-mode={inputMode}>
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
                    {allSelected ? t('gallery.deselectAll') : t('gallery.selectAll')}
                  </button>
                  <button
                    className="gallery-premium-download-btn"
                    onClick={handleDownloadSelected}
                    aria-disabled={selectionOverQuota || undefined}
                    style={selectionOverQuota ? { opacity: 0.5 } : undefined}
                    title={selectionOverQuota
                      ? t('gallery.downloadLimit.selectionTooLarge', {
                        cost: downloadQuota.costOf(selectedPhotoList),
                        remaining: downloadQuota.remaining ?? 0,
                        defaultValue: 'Download limit: this selection needs {{cost}} downloads, only {{remaining}} left',
                      })
                      : undefined}
                  >
                    <Package className="w-3 h-3 mr-1 inline" />
                    {t('common.download')} ({selectedPhotos.size})
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Guest upload: this layout has no gallery header, which is where
                every other layout offers it. Hidden while the selection
                controls take the row, which already fill a phone's width. */}
            {onUploadClick && !(isSelectionMode && selectedPhotos.size > 0) && (
              <button
                type="button"
                className="gallery-premium-nav-btn"
                onClick={onUploadClick}
                aria-label={uploadLabel}
                title={uploadLabel}
                data-testid="premium-nav-upload"
                data-gallery-focus="upload"
              >
                <Upload className="w-4 h-4" />
              </button>
            )}
            {feedbackEnabled && feedbackOptions?.allowLikes && (
              // The gallery's "Liked" filter, with the count Story shows.
              <button
                type="button"
                className={`gallery-premium-nav-btn${likedOnly ? ' active' : ''}`}
                onClick={onToggleLikedOnly}
                aria-pressed={onToggleLikedOnly ? likedOnly : undefined}
                aria-label={`${t('gallery.showLikedOnly', 'Show only photos I liked')}${likedPhotoIds.size > 0 ? ` (${likedPhotoIds.size})` : ''}`}
                title={t('gallery.favorites', 'Favorites')}
                data-testid="premium-nav-liked"
                // Focus moves to "Show all photos" when the filter empties the view.
                data-gallery-focus="liked"
              >
                <Heart className="w-4 h-4" fill={likedOnly ? 'currentColor' : 'none'} />
                {likedPhotoIds.size > 0 && (
                  <span className="gallery-premium-nav-count">
                    {likedPhotoIds.size > 9 ? '9+' : likedPhotoIds.size}
                  </span>
                )}
              </button>
            )}
            {/* As Gallery Story's: the whole-gallery path alone is enough, so a
                folder-only root (no photos in scope) still offers it. */}
            {allowDownloads && (onDownloadEverything || downloadablePhotos.length > 0) && (
              <button
                className="gallery-premium-nav-btn"
                title={t('common.downloadAll', 'Download All')}
                onClick={handleDownloadAll}
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
        {/* Download limit (issue 1560): the client's counter, or a guest's
            preview-size note. */}
        {allowDownloads && (downloadQuota.limited || downloadQuota.previewOnly) && (
          <div className="mb-4 text-center">
            <DownloadQuotaNotice />
          </div>
        )}
        <MasonryPhotoAlbum
          photos={albumPhotos}
          render={{
            photo: (_props, { photo, index: photoIndex, width, height }) => {
              // `index` is the position in `albumPhotos`, a 1:1 map of
              // `filteredPhotos`, so it is the lightbox index too — no
              // per-tile `findIndex` (issue 1733).
              const originalPhoto = (photo as any)._photo as Photo;

              return (
                <PhotoCard
                  photo={originalPhoto}
                  width={width}
                  height={height}
                  onClick={() => {
                    lightboxPhotoIdRef.current = originalPhoto.id;
                    setLightboxIndex(photoIndex);
                    onLightboxPhotoChange?.(originalPhoto.id, 'open');
                  }}
                  onLike={(e) => handleLike(originalPhoto, e)}
                  onSelect={(e) => {
                    e.stopPropagation();
                    onPhotoSelect?.(originalPhoto.id);
                  }}
                  isSelected={selectedPhotos.has(originalPhoto.id)}
                  isSelectionMode={isSelectionMode}
                  // #590 follow-up: drop the `|| like_count > 0` fallback,
                  // which treated "anyone liked this" as "I liked it". The
                  // per-viewer is_liked seed above is the correct source.
                  isLiked={likedPhotoIds.has(originalPhoto.id)}
                  slug={slug}
                  allowDownloads={allowDownloads}
                  useEnhancedProtection={useEnhancedProtection}
                  feedbackEnabled={feedbackEnabled}
                  allowLikes={!!feedbackOptions?.allowLikes}
                  index={photoIndex}
                  onToggleVisibility={isClient ? onToggleVisibility : undefined}
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

      {afterGrid && <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">{afterGrid}</div>}

      {/* Footer */}
      <footer className="gallery-premium-footer">
        <PoweredBy />
        <p>© {new Date().getFullYear()} {t('gallery.allRightsReserved', 'All rights reserved')}</p>
      </footer>

      {/* Lightbox */}
      <Lightbox
        open={lightboxIndex >= 0}
        close={() => {
          lightboxPhotoIdRef.current = null;
          setLightboxIndex(-1);
          onLightboxPhotoChange?.(null, 'close');
        }}
        index={lightboxIndex}
        slides={slides}
        // View beacon (#895): yarl fires `view` on open and on every
        // slide change — same semantics as PhotoLightbox's beacon.
        on={{
          view: ({ index }) => {
            // Keep the controlled index in sync when loaded dimensions update
            // the slides array; otherwise YARL jumps back to the opening photo.
            setLightboxIndex(index);
            const photo = filteredPhotos[index];
            if (photo) {
              lightboxPhotoIdRef.current = photo.id;
              galleryService.trackPhotoView(slug, photo.id);
              onLightboxPhotoChange?.(photo.id, 'step');
            }
          },
        }}
        plugins={[
          Thumbnails,
          Zoom,
          Fullscreen,
          ...(allowDownloads ? [Download] : []),
          ...(showCaptions ? [Captions] : []),
        ]}
        animation={{ fade: 300, swipe: 250 }}
        styles={{
          container: { backgroundColor: 'rgba(0, 0, 0, 0.95)' },
          thumbnail: { border: 'none' }
        }}
        render={{
          slide: (props) => renderPremiumLightboxImage({
            ...props, slug, useCanvasRendering, protectionLevel, onImageLoad: handleLightboxImageLoad,
          }),
          buttonPrev: slides.length <= 1 ? () => null : undefined,
          buttonNext: slides.length <= 1 ? () => null : undefined,
          buttonDownload: () => <PremiumLightboxDownloadButton onDownload={handleDownloadFromLightbox} />,
        }}
        controller={{ closeOnBackdropClick: true }}
      />

      {/* Emoji reaction bar over the lightbox (#839). Portaled to
          document.body: inside the layout tree an ancestor stacking context
          (framer-motion transforms) would paint it UNDER yarl's body-level
          portal and its backdrop would swallow every click. As a body child
          the z-index 10000 genuinely beats yarl's 9999. */}
      {currentLightboxPhoto && reactionsActive && reactionState?.photoId === currentLightboxPhoto.id && createPortal(
        <div className="gallery-premium-lightbox-reactions">
          <PhotoReactions
            photoId={String(currentLightboxPhoto.id)}
            gallerySlug={slug}
            myReaction={reactionState.mine}
            reactionCounts={reactionState.counts}
            isEnabled={true}
            requireNameEmail={!!feedbackOptions?.requireNameEmail}
            onReactionChange={handleReactionChange}
          />
        </div>,
        document.body
      )}

      {/* Identity Modal */}
      <FeedbackIdentityModal
        isOpen={showIdentityModal}
        onClose={() => { setShowIdentityModal(false); setPendingLikePhotoId(null); }}
        onSubmit={handleIdentitySubmit}
        feedbackType="like"
      />
    </div>
    </PhotoLabelsProvider>
  );
};
