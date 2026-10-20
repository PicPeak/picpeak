import { usePhotoSelection } from '../../../hooks/usePhotoSelection';
import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Download, Maximize2, Play, Pause, Heart, MessageSquare, Sparkles } from 'lucide-react';
import { useTheme } from '../../../contexts/ThemeContext';
import { AuthenticatedImage, Button } from '../../common';
import { ColorLabelBadge } from '../ColorLabelBadge';
import { TileImage } from '../TileImage';
import { ClientVisibilityToggle, isHiddenFromGuests } from '../ClientVisibilityToggle';
import { useGalleryTileBadges } from '../GalleryTileBadges';
import { usePhotoLabels } from '../PhotoLabels';
import type { BaseGalleryLayoutProps } from './BaseGalleryLayout';
import { FeedbackIdentityModal } from '../../gallery/FeedbackIdentityModal';
import { feedbackService } from '../../../services/feedback.service';
import { feedbackLockKind } from '../../../utils/feedbackLock';
import { useGuestIdentityOptional } from '../../../contexts/GuestIdentityContext';
import { useDownloadQuota } from '../../../contexts/DownloadQuotaContext';
import { downloadLimitReachedMessage } from '../../../utils/downloadLimit';
import { usePhotoDownloadPending, preparingDownloadMessage } from '../../../hooks/usePhotoDownloadPending';

export const CarouselGalleryLayout: React.FC<BaseGalleryLayoutProps> = ({
  photos,
  slug,
  onPhotoClick,
  onOpenPhotoWithFeedback,
  onDownload,
  allowDownloads = true,
  feedbackEnabled = false,
  feedbackOptions,
  onFeedbackChange,
  isClient = false,
  onToggleVisibility,
}) => {
  const { t } = useTranslation();
  const photoLabels = usePhotoLabels();
  const { theme } = useTheme();
  const { currentPhoto, currentIndex, setCurrentIndex } = usePhotoSelection(photos);
  const [isPlaying, setIsPlaying] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
  const gallerySettings = theme.gallerySettings || {};
  const autoplay = gallerySettings.carouselAutoplay || false;
  const interval = gallerySettings.carouselInterval || 5000;
  const showThumbnails = gallerySettings.carouselShowThumbnails !== false;

  // Auto-play functionality
  useEffect(() => {
    if (isPlaying && photos.length > 1) {
      intervalRef.current = setInterval(() => {
        setCurrentIndex((prev) => (prev + 1) % photos.length);
      }, interval);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isPlaying, photos.length, interval, setCurrentIndex]);

  // Start autoplay if enabled
  useEffect(() => {
    if (autoplay) {
      setIsPlaying(true);
    }
  }, [autoplay]);

  const goToPrevious = () => {
    setCurrentIndex((prev) => (prev - 1 + photos.length) % photos.length);
  };

  const goToNext = () => {
    setCurrentIndex((prev) => (prev + 1) % photos.length);
  };

  const togglePlayPause = () => {
    setIsPlaying(!isPlaying);
  };

  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<null | { type: 'like'; photoId: number }>(null);
  const [savedIdentity, setSavedIdentity] = useState<{ name: string; email: string } | null>(null);
  const guestIdentity = useGuestIdentityOptional();
  // Download limit (issue 1560); see PhotoCard for why aria-disabled.
  const downloadQuota = useDownloadQuota();
  // First look (issue 1562) and the "All photos" folder hint (issue 1786)
  // ride in the chip row next to the category: this layout's corners are
  // all taken (see the colour-label note below).
  const tileBadges = useGalleryTileBadges();
  const [likedIds, setLikedIds] = useState<Set<number>>(new Set());
  // The like endpoint is a toggle (#590), and so is taking one back.
  const toggleLiked = (photoId: number) => setLikedIds(prev => {
    const next = new Set(prev);
    if (next.has(photoId)) next.delete(photoId);
    else next.add(photoId);
    return next;
  });
  // Seed from server is_liked on first non-empty payload (#590 follow-up).
  // Mount-only so refetches don't clobber in-session optimistic toggles.
  const likedSeededRef = useRef(false);
  useEffect(() => {
    if (likedSeededRef.current || photos.length === 0) return;
    setLikedIds(new Set(photos.filter(p => p.is_liked).map(p => p.id)));
    likedSeededRef.current = true;
  }, [photos]);
  const canQuickComment = Boolean(feedbackEnabled && feedbackOptions?.allowComments && onOpenPhotoWithFeedback);
  // Issue 2043: spins while the photo on screen is being prepared.
  const downloadPending = usePhotoDownloadPending(currentPhoto?.id);

  if (!currentPhoto) return null;
  const currentPhotoAtLimit = !downloadQuota.canDownload(currentPhoto);

  return (
    <div className="photo-grid relative">
      {/* Main Carousel */}
      <div className="photo-card relative h-[50vh] sm:h-[60vh] lg:h-[70vh] bg-black rounded-lg overflow-hidden">
        {/* A video's original cannot render as an image, and on a gallery
            with a download limit fetching it takes a slot (issue 1560):
            its poster instead. */}
        <AuthenticatedImage
          src={currentPhoto.media_type === 'video' && currentPhoto.thumbnail_url ? currentPhoto.thumbnail_url : currentPhoto.url}
          alt={photoLabels.of(currentPhoto, currentPhoto.filename)}
          // Dimmed when the client hid it from guests, as in Grid (issue 1992).
          className={`w-full h-full object-contain${isClient && onToggleVisibility && isHiddenFromGuests(currentPhoto) ? ' opacity-40' : ''}`}
          isGallery={true}
        />

        {/* Colour labels for the photo in view (#1189). Bottom-left because it
            is the only corner this layout leaves free — top-left carries the
            counter and category chips, top-right the play/fullscreen buttons,
            and both sides the prev/next controls. */}
        <ColorLabelBadge
          colorLabel={currentPhoto.my_color_label}
          otherColorLabels={currentPhoto.other_color_labels}
          decision={currentPhoto.my_decision}
          position="bottom-4 left-4"
        />

        {/* Navigation Controls */}
        <div className="absolute inset-0 flex items-center justify-between p-4">
          <button
            onClick={goToPrevious}
            className="p-2 bg-black/50 text-white rounded-full hover:bg-black/70 transition-colors"
            aria-label="Previous photo"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
          
          <button
            onClick={goToNext}
            className="p-2 bg-black/50 text-white rounded-full hover:bg-black/70 transition-colors"
            aria-label="Next photo"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        </div>
        
        {/* Top Controls */}
        <div className="absolute top-4 left-4 right-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {/* The client's hide/show button (issue 1992): first in the chip
                row, the top-left of the photo in view, as in Grid. */}
            {isClient && onToggleVisibility && (
              <ClientVisibilityToggle photo={currentPhoto} onToggle={onToggleVisibility} />
            )}
            <span className="px-3 py-1 bg-black/50 text-white rounded-full text-sm">
              {currentIndex + 1} / {photos.length}
            </span>
            {currentPhoto.category_name && (
              <span className="px-3 py-1 bg-black/50 text-white rounded-full text-sm">
                {currentPhoto.category_name}
              </span>
            )}
            {tileBadges.folderNameOf && tileBadges.folderNameOf(currentPhoto) && (
              <span className="px-3 py-1 bg-black/50 text-white rounded-full text-sm max-w-[10rem] truncate">
                {tileBadges.folderNameOf(currentPhoto)}
              </span>
            )}
            {currentPhoto.first_look && tileBadges.firstLookLabel && (
              <span className="inline-flex items-center gap-1 px-3 py-1 bg-white/90 text-neutral-800 rounded-full text-sm">
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                {tileBadges.firstLookLabel}
              </span>
            )}
          </div>
          
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={togglePlayPause}
              className="text-white hover:bg-white/20"
              title={isPlaying ? 'Pause slideshow' : 'Play slideshow'}
            >
              {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
            </Button>
            
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onPhotoClick(currentIndex)}
              className="text-white hover:bg-white/20"
              title={t('gallery.tile.viewFullSize', 'View full size')}
            >
              <Maximize2 className="w-5 h-5" />
            </Button>
            
            {allowDownloads && (
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => onDownload(currentPhoto, e)}
                isLoading={downloadPending}
                focusableWhileLoading
                className={`text-white hover:bg-white/20${currentPhotoAtLimit ? ' opacity-50 cursor-not-allowed' : ''}`}
                aria-disabled={currentPhotoAtLimit || undefined}
                title={currentPhotoAtLimit
                  ? downloadLimitReachedMessage()
                  : downloadPending ? preparingDownloadMessage() : t('gallery.tile.downloadPhoto', 'Download photo')}
              >
                {downloadPending ? null : <Download className="w-5 h-5" />}
              </Button>
            )}
            {feedbackEnabled && feedbackOptions?.allowLikes && (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  if (guestIdentity?.identityMode === 'guest') {
                    try {
                      await guestIdentity.ensureIdentity();
                    } catch {
                      return;
                    }
                    // Toggle — server /feedback like is a toggle (#590).
                    setLikedIds(prev => {
                      const next = new Set(prev);
                      if (next.has(currentPhoto.id)) next.delete(currentPhoto.id);
                      else next.add(currentPhoto.id);
                      return next;
                    });
                    try {
                      await feedbackService.submitFeedback(slug!, String(currentPhoto.id), {
                        feedback_type: 'like',
                      });
                      // The "x selected" counter and the Liked filter read
                      // /my-feedback, which this refreshes (issue 1733).
                      onFeedbackChange?.(currentPhoto.id);
                    } catch (err) {
                      // Same rule as PhotoCard: a pick refused by a finished
                      // selection goes back; otherwise keep the optimistic
                      // state, a refresh reconciles.
                      if (feedbackLockKind(err)) toggleLiked(currentPhoto.id);
                      else console.warn('Like submit failed, keeping optimistic UI', err);
                    }
                    return;
                  }
                  if (feedbackOptions?.requireNameEmail && !savedIdentity) {
                    setPendingAction({ type: 'like', photoId: currentPhoto.id });
                    setShowIdentityModal(true);
                    return;
                  }
                  // Toggle — server /feedback like is a toggle (#590).
                  setLikedIds(prev => {
                    const next = new Set(prev);
                    if (next.has(currentPhoto.id)) next.delete(currentPhoto.id);
                    else next.add(currentPhoto.id);
                    return next;
                  });
                  try {
                    await feedbackService.submitFeedback(slug!, String(currentPhoto.id), {
                      feedback_type: 'like',
                      guest_name: savedIdentity?.name,
                      guest_email: savedIdentity?.email,
                    });
                    onFeedbackChange?.(currentPhoto.id);
                  } catch (err) {
                    if (feedbackLockKind(err)) toggleLiked(currentPhoto.id);
                    else console.warn('Like submit failed, keeping optimistic UI', err);
                  }
                }}
                className={`bg-black/30 hover:bg-black/50 rounded-full border border-white/40 ${likedIds.has(currentPhoto.id) ? 'text-danger' : 'text-white'}`}
                title={t('gallery.tile.likePhoto', 'Like photo')}
                aria-pressed={likedIds.has(currentPhoto.id)}
              >
                <Heart className="w-5 h-5" />
              </Button>
            )}
            {canQuickComment && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { onOpenPhotoWithFeedback?.(currentIndex); }}
                className="text-white bg-black/30 hover:bg-black/50 rounded-full border border-white/40"
                title={t('gallery.tile.comment', 'Comment')}
                aria-label={t('gallery.tile.commentOnPhoto', 'Comment on photo')}
              >
                <MessageSquare className="w-5 h-5" />
              </Button>
            )}
          </div>
        </div>
        
        {/* Progress Bar */}
        {isPlaying && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/20">
            <div 
              className="h-full bg-white transition-all duration-1000 ease-linear"
              style={{
                width: '100%',
                animation: `progress ${interval}ms linear infinite`
              }}
            />
          </div>
        )}
      </div>
      
      {/* Thumbnails */}
      {showThumbnails && photos.length > 1 && (
        <div className="mt-4 relative">
          <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-neutral-400">
            {photos.map((photo, index) => (
              <button
                key={photo.id}
                onClick={() => setCurrentIndex(index)}
                className={`relative flex-shrink-0 w-20 h-20 rounded overflow-hidden transition-all ${
                  index === currentIndex 
                    ? 'ring-2 ring-accent scale-110' 
                    : 'opacity-70 hover:opacity-100'
                }`}
              >
                {/* TileImage for the unavailable tile (issue 1733, E9); icon
                    only, the caption does not fit 80px. */}
                <TileImage
                  compactUnavailable
                  src={photo.thumbnail_url || photo.url}
                  alt={photoLabels.of(photo, photo.filename)}
                  // Hidden from guests: dimmed here too, not only on the stage
                  // (issue 1992). On the image, so hover's opacity-100 on the
                  // button does not undo it.
                  className={`w-full h-full object-cover${isClient && onToggleVisibility && isHiddenFromGuests(photo) ? ' opacity-40' : ''}`}
                  loading="lazy"
                  isGallery={true}
                />
                {/* The strip is the only place this layout shows more than one
                    photo at a time, so it is the only place a label can
                    actually be scanned (#1189). Small variant: these tiles are
                    80px, where the grid-sized dots cover most of the image. */}
                <ColorLabelBadge
                  colorLabel={photo.my_color_label}
                  otherColorLabels={photo.other_color_labels}
                  decision={photo.my_decision}
                  size="sm"
                  position="top-1 left-1"
                />
              </button>
            ))}
          </div>
        </div>
      )}
      
      <FeedbackIdentityModal
        isOpen={showIdentityModal}
        onClose={() => { setShowIdentityModal(false); setPendingAction(null); }}
        onSubmit={async (name, email) => {
          setSavedIdentity({ name, email });
          setShowIdentityModal(false);
          if (pendingAction) {
            await feedbackService.submitFeedback(slug!, String(pendingAction.photoId), {
              feedback_type: pendingAction.type,
              guest_name: name,
              guest_email: email,
            });
            onFeedbackChange?.(pendingAction.photoId);
            setPendingAction(null);
          }
        }}
        feedbackType="like"
      />

      <style>{`
        @keyframes progress {
          from { width: 0%; }
          to { width: 100%; }
        }
      `}</style>
    </div>
  );
};
