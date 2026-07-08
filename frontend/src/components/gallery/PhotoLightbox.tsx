import React, { useState, useEffect, useRef } from 'react';
import { useDevToolsProtection } from '../../hooks/useDevToolsProtection';
import { X, ChevronLeft, ChevronRight, Download, ZoomIn, ZoomOut, MessageSquare, Heart, Star } from 'lucide-react';
import type { Photo } from '../../types';
import { useSavePhotoToDevice } from '../../hooks/useGallery';
import { AuthenticatedImage } from '../common';
import { PhotoFeedback } from './PhotoFeedback';
import { feedbackService } from '../../services/feedback.service';
import { FeedbackIdentityModal } from './FeedbackIdentityModal';
import { VideoPlayer } from './VideoPlayer';
import { useGuestIdentityOptional } from '../../contexts/GuestIdentityContext';
import { useFeedbackLimitModal } from '../../hooks/useFeedbackLimitModal';

interface PhotoLightboxProps {
  photos: Photo[];
  initialIndex: number;
  onClose: () => void;
  slug: string;
  feedbackEnabled?: boolean;
  allowDownloads?: boolean;
  protectionLevel?: 'basic' | 'standard' | 'enhanced' | 'maximum';
  useEnhancedProtection?: boolean;
  useCanvasRendering?: boolean;
  initialShowFeedback?: boolean;
  onFeedbackChange?: () => void;
  disableRightClick?: boolean;
  enableDevtoolsProtection?: boolean;
  // When true, surface each photo's original camera filename in the
  // bottom toolbar — useful for photographers matching guest selections
  // back to source files (#508). Tied to the admin-side toggle that
  // also drives original-filename downloads (#493).
  showOriginalFilename?: boolean;
}

export const PhotoLightbox: React.FC<PhotoLightboxProps> = ({
  photos,
  initialIndex,
  onClose,
  slug,
  feedbackEnabled = false,
  allowDownloads = true,
  protectionLevel = 'standard',
  useEnhancedProtection = false,
  useCanvasRendering = false,
  initialShowFeedback = false,
  onFeedbackChange,
  disableRightClick = false,
  enableDevtoolsProtection = false,
  showOriginalFilename = false,
}) => {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [touchDistance, setTouchDistance] = useState<number | null>(null);
  // Ref (not state) so handleTouchEnd reads the value set by handleTouchStart
  // even when both fire in the same render batch.
  const swipeStartRef = useRef<{ x: number; y: number; t: number } | null>(null);

  // Carousel swipe state. A 3-slide track (prev/current/next) is shifted
  // so the current slide is centered; the user's finger drags the track,
  // and the track snaps to the neighbour or springs back when released.
  // Percentage-based transforms avoid the need to measure the container
  // before the first paint.
  // - 'idle': showing the current slide, no transition
  // - 'dragging': finger is down, track follows the finger (no transition)
  // - 'committing': finger lifted past the threshold, animating to the
  //   neighbouring slot. On transitionend we advance currentIndex and reset.
  // - 'springing': finger lifted below threshold, animating back to center.
  const trackContainerRef = useRef<HTMLDivElement>(null);
  const [dragX, setDragX] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'dragging' | 'committing' | 'springing'>('idle');
  const [commitDirection, setCommitDirection] = useState<-1 | 1>(1);
  const [showFeedback, setShowFeedback] = useState(initialShowFeedback);
  const [isSmallScreen, setIsSmallScreen] = useState<boolean>(typeof window !== 'undefined' ? window.innerWidth < 640 : false);
  const [feedbackSettings, setFeedbackSettings] = useState<{
    feedback_enabled?: boolean;
    allow_likes?: boolean;
    allow_ratings?: boolean;
    allow_comments?: boolean;
    show_feedback_to_guests?: boolean;
    require_name_email?: boolean;
  } | null>(null);
  const [myLiked, setMyLiked] = useState<boolean>(false);
  const [myRating, setMyRating] = useState<number>(0);
  const [likeCount, setLikeCount] = useState<number>(0);
  const [avgRating, setAvgRating] = useState<number>(0);
  const [totalRatings, setTotalRatings] = useState<number>(0);
  const [savedIdentity, setSavedIdentity] = useState<{ name: string; email: string } | null>(null);
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<null | { type: 'like' | 'rating'; rating?: number }>(null);
  const guestIdentity = useGuestIdentityOptional();
  const isGuestMode = guestIdentity?.identityMode === 'guest';
  // Per-guest cap modal (#655) — shared across every submitFeedback call site
  // in the lightbox (guest mode, simple mode, identity-modal-confirm path).
  const { modal: limitModal, handleError: handleLimitError } = useFeedbackLimitModal();

  useEffect(() => {
    const onResize = () => setIsSmallScreen(window.innerWidth < 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);


  // Save-aware download. On mobile (where Web Share + files is supported)
  // this opens the OS share sheet so "Save to Photos" actually lands in
  // the Photos/Gallery app — matters for non-technical clients who
  // otherwise have to chain Files → unzip → save (#531). Desktop and
  // unsupported browsers fall through to a regular <a download>.
  const downloadPhotoMutation = useSavePhotoToDevice();
  const currentPhoto = photos[currentIndex];
  // Per-category download permission (#640). AND'd with the event-level
  // allowDownloads — disabling at either level hides the download button.
  // Defaults true for uncategorised photos and pre-migration-135 categories.
  const photoAllowsDownload =
    allowDownloads && currentPhoto?.category_allow_downloads !== false;
  
  // DevTools protection - enabled by individual setting OR legacy protection level
  const devToolsEnabled = enableDevtoolsProtection || (useEnhancedProtection && (protectionLevel === 'enhanced' || protectionLevel === 'maximum'));

  useDevToolsProtection({
    enabled: devToolsEnabled,
    detectionSensitivity: protectionLevel === 'maximum' ? 'high' : 'medium',
    onDevToolsDetected: () => {
      console.warn('DevTools detected in photo lightbox');

      // Track analytics
      if (typeof window !== 'undefined' && (window as any).umami) {
        (window as any).umami.track('lightbox_devtools_detected', {
          photoId: currentPhoto.id,
          protectionLevel,
          zoom,
          gallery: slug
        });
      }

      // Close lightbox immediately for maximum protection
      if (protectionLevel === 'maximum') {
        onClose();
      }
    },
    redirectOnDetection: false, // Don't redirect, just close lightbox
  });

  // Right-click blocking in lightbox
  useEffect(() => {
    if (!disableRightClick) return;

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      return false;
    };

    document.addEventListener('contextmenu', handleContextMenu);
    return () => {
      document.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [disableRightClick]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose();
          break;
        case 'ArrowLeft':
          goToPrevious();
          break;
        case 'ArrowRight':
          goToNext();
          break;
        case '+':
        case '=':
          handleZoomIn();
          break;
        case '-':
        case '_':
          handleZoomOut();
          break;
        case 'd':
        case 'D':
          if (photoAllowsDownload) {
            handleDownload();
          }
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';
    
    // Add protection class to body for maximum security
    if (protectionLevel === 'maximum') {
      document.body.classList.add('protection-maximum');
    } else if (protectionLevel === 'enhanced') {
      document.body.classList.add('protection-enhanced');
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
      
      // Remove protection classes from body
      document.body.classList.remove('protection-maximum', 'protection-enhanced');
    };
  }, [currentIndex]);

  // Load feedback settings once
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const settings = await feedbackService.getGalleryFeedbackSettings(slug);
        if (mounted) setFeedbackSettings(settings as any);
      } catch {
        // ignore
      }
    })();
    return () => { mounted = false; };
  }, [slug]);

  // Load my feedback for the current photo
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        if (!feedbackSettings?.feedback_enabled) return;
        const data = await feedbackService.getPhotoFeedback(slug, String(currentPhoto.id));
        if (!mounted) return;
        setMyLiked(!!data.my_feedback.liked);
        setMyRating(data.my_feedback.rating || 0);
        setLikeCount(Number(data.summary?.like_count) || 0);
        setAvgRating(Number(data.summary?.average_rating) || 0);
        setTotalRatings(Number(data.summary?.total_ratings) || 0);
      } catch {
        // ignore
      }
    })();
    return () => { mounted = false; };
  }, [slug, currentPhoto.id, feedbackSettings?.feedback_enabled]);

  const submitLike = async () => {
    // Guest identity mode: ensure we have a per-person guest token. The
    // server reads name/email from the token — body values are ignored.
    if (isGuestMode && guestIdentity) {
      try {
        await guestIdentity.ensureIdentity();
      } catch {
        // User cancelled the prompt — abort silently.
        return;
      }
      try {
        await feedbackService.submitFeedback(slug, String(currentPhoto.id), {
          feedback_type: 'like',
        });
        setMyLiked(prev => {
          const next = !prev;
          setLikeCount(c => Math.max(0, c + (next ? 1 : -1)));
          return next;
        });
        if (onFeedbackChange) onFeedbackChange();
      } catch (err) {
        // Per-guest cap reached (#655) surfaces the shared modal.
        if (handleLimitError(err)) return;
        // eslint-disable-next-line no-console
        console.warn('Like submit failed', err);
      }
      return;
    }

    // Simple mode: legacy inline identity modal flow.
    const needIdentity = feedbackSettings?.require_name_email && !savedIdentity;
    if (needIdentity) {
      setPendingAction({ type: 'like' });
      setShowIdentityModal(true);
      return;
    }
    try {
      await feedbackService.submitFeedback(slug, String(currentPhoto.id), {
        feedback_type: 'like',
        guest_name: savedIdentity?.name,
        guest_email: savedIdentity?.email,
      });
      setMyLiked(prev => {
        const next = !prev;
        setLikeCount(c => Math.max(0, c + (next ? 1 : -1)));
        return next;
      });
    } catch (err) {
      if (handleLimitError(err)) return;
      // eslint-disable-next-line no-console
      console.warn('Like submit failed', err);
    }
  };

  const submitRating = async (value: number) => {
    // Guest identity mode.
    if (isGuestMode && guestIdentity) {
      try {
        await guestIdentity.ensureIdentity();
      } catch {
        return;
      }
      try {
        await feedbackService.submitFeedback(slug, String(currentPhoto.id), {
          feedback_type: 'rating',
          rating: value,
        });
        setMyRating(value);
        try {
          const fresh = await feedbackService.getPhotoFeedback(slug, String(currentPhoto.id));
          setAvgRating(Number(fresh.summary?.average_rating) || 0);
          setTotalRatings(Number(fresh.summary?.total_ratings) || 0);
        } catch {}
        if (onFeedbackChange) onFeedbackChange();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('Rating submit failed', err);
      }
      return;
    }

    // Simple mode: legacy inline identity modal flow.
    const needIdentity = feedbackSettings?.require_name_email && !savedIdentity;
    if (needIdentity) {
      setPendingAction({ type: 'rating', rating: value });
      setShowIdentityModal(true);
      return;
    }
    await feedbackService.submitFeedback(slug, String(currentPhoto.id), {
      feedback_type: 'rating',
      rating: value,
      guest_name: savedIdentity?.name,
      guest_email: savedIdentity?.email,
    });
    setMyRating(value);
    // Refresh current summary to reflect average and totals
    try {
      const fresh = await feedbackService.getPhotoFeedback(slug, String(currentPhoto.id));
      setAvgRating(Number(fresh.summary?.average_rating) || 0);
      setTotalRatings(Number(fresh.summary?.total_ratings) || 0);
    } catch {}
  };

  const goToPrevious = () => {
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : photos.length - 1));
    resetZoom();
  };

  const goToNext = () => {
    setCurrentIndex((prev) => (prev < photos.length - 1 ? prev + 1 : 0));
    resetZoom();
  };

  const resetZoom = () => {
    setZoom(1);
    setDragOffset({ x: 0, y: 0 });
  };

  const handleZoomIn = () => {
    setZoom((prev) => Math.min(prev + 0.5, 3));
  };

  const handleZoomOut = () => {
    setZoom((prev) => Math.max(prev - 0.5, 1));
    if (zoom - 0.5 <= 1) {
      setDragOffset({ x: 0, y: 0 });
    }
  };

  const handleDownload = () => {
    if (!photoAllowsDownload) return;
    downloadPhotoMutation.mutate({
      slug,
      photoId: currentPhoto.id,
      filename: currentPhoto.filename,
    });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoom > 1) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - dragOffset.x, y: e.clientY - dragOffset.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging && zoom > 1) {
      setDragOffset({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleImageClick = (e: React.MouseEvent) => {
    // Only close if clicking the background, not the image
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  // Touch event handlers: pinch-to-zoom (2 fingers) + single-finger
  // carousel-style swipe nav. Swipe is suppressed while zoomed in so the
  // user can pan instead. The carousel is also disabled mid-animation.
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const distance = Math.hypot(
        touch2.clientX - touch1.clientX,
        touch2.clientY - touch1.clientY
      );
      setTouchDistance(distance);
      swipeStartRef.current = null;
      // Cancel any in-progress carousel motion when a pinch starts —
      // spring the track back so the image doesn't jerk under the user.
      if (phase === 'dragging') {
        if (dragX === 0) {
          setPhase('idle');
        } else {
          setPhase('springing');
          setDragX(0);
        }
      }
    } else if (e.touches.length === 1 && zoom > 1) {
      // Single-finger pan when zoomed in (#532). Mirrors the desktop
      // handleMouseDown path so mobile users can drag a zoomed image
      // around instead of being stuck looking at the centre crop.
      // Carousel swipe is disabled in this branch — when zoom > 1 the
      // gesture has to mean "pan", not "next photo", or zoomed nav
      // becomes unusable.
      const t = e.touches[0];
      setIsDragging(true);
      setDragStart({ x: t.clientX - dragOffset.x, y: t.clientY - dragOffset.y });
    } else if (e.touches.length === 1 && zoom <= 1 && (phase === 'idle' || phase === 'dragging')) {
      const t = e.touches[0];
      swipeStartRef.current = { x: t.clientX, y: t.clientY, t: Date.now() };
      setPhase('dragging');
      setDragX(0);
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && touchDistance !== null) {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const newDistance = Math.hypot(
        touch2.clientX - touch1.clientX,
        touch2.clientY - touch1.clientY
      );

      const scale = newDistance / touchDistance;
      const newZoom = Math.max(1, Math.min(3, zoom * scale));
      setZoom(newZoom);
      setTouchDistance(newDistance);
      // Pinch-out back down to 1.0 has to re-centre the image — without
      // this the previous pan offset persists and the photo sits off-
      // centre at the natural zoom level (#532 follow-on).
      if (newZoom <= 1 && (dragOffset.x !== 0 || dragOffset.y !== 0)) {
        setDragOffset({ x: 0, y: 0 });
      }
      return;
    }

    if (isDragging && zoom > 1 && e.touches.length === 1) {
      // Single-finger pan when zoomed (#532). Touch counterpart to
      // handleMouseMove. Same dragOffset state so the transform on the
      // <img> stays consistent across input modalities.
      const t = e.touches[0];
      setDragOffset({
        x: t.clientX - dragStart.x,
        y: t.clientY - dragStart.y,
      });
      return;
    }

    if (phase === 'dragging' && e.touches.length === 1 && swipeStartRef.current) {
      const t = e.touches[0];
      const dx = t.clientX - swipeStartRef.current.x;
      const dy = t.clientY - swipeStartRef.current.y;
      // Cancel the carousel drag if the gesture turns out to be vertical
      // (e.g. an accidental scroll attempt while not zoomed). If we
      // haven't moved horizontally yet, snap straight to idle — there's
      // no transition to wait on — otherwise let the spring carry it back.
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 24) {
        swipeStartRef.current = null;
        if (dragX === 0) {
          setPhase('idle');
        } else {
          setPhase('springing');
          setDragX(0);
        }
        return;
      }
      setDragX(dx);
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    setTouchDistance(null);
    // Release single-finger pan state (#532). The pan offset itself
    // persists so the image stays where the user left it — only the
    // "actively dragging" flag clears.
    if (isDragging) setIsDragging(false);
    const start = swipeStartRef.current;
    if (phase === 'dragging' && start && e.changedTouches.length > 0) {
      const t = e.changedTouches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      const dt = Math.max(1, Date.now() - start.t);
      const velocity = Math.abs(dx) / dt; // px / ms
      const containerWidth = trackContainerRef.current?.offsetWidth ?? 0;
      const threshold = Math.max(60, containerWidth * 0.2);
      const isHorizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
      const shouldCommit = isHorizontal && (Math.abs(dx) > threshold || (velocity > 0.5 && Math.abs(dx) > 40));

      if (shouldCommit) {
        setCommitDirection(dx < 0 ? 1 : -1);
        setDragX(dx);
        setPhase('committing');
      } else if (dragX === 0) {
        // Tap with no movement — no transition would fire, so skip the
        // springing phase to avoid getting stuck waiting for transitionend.
        setPhase('idle');
      } else {
        setPhase('springing');
        setDragX(0);
      }
    } else if (phase === 'dragging') {
      // Touch ended without changedTouches data (rare) — reset cleanly.
      setPhase('idle');
      setDragX(0);
    }
    swipeStartRef.current = null;
  };

  const handleTouchCancel = () => {
    // System took over the gesture (incoming call, edge swipe, etc.).
    // Spring back if the carousel was being dragged.
    if (phase === 'dragging') {
      if (dragX === 0) {
        setPhase('idle');
      } else {
        setPhase('springing');
        setDragX(0);
      }
    }
    swipeStartRef.current = null;
    setTouchDistance(null);
  };

  // Track transform. Percentages on translateX are self-referential (a
  // 300%-wide track translated -33.333% moves left by exactly one container
  // width), so we never need to know the container width to position the
  // slides. The drag delta is added in pixels.
  // - idle / springing target: -33.333% (current centered)
  // - dragging: -33.333% + dragX px (finger follows)
  // - committing next: -66.666% (next centered)
  // - committing prev: 0% (previous centered)
  const trackTransform = (() => {
    if (phase === 'dragging') return `translate3d(calc(-33.3333% + ${dragX}px), 0, 0)`;
    if (phase === 'committing') {
      return commitDirection === 1
        ? 'translate3d(-66.6666%, 0, 0)'
        : 'translate3d(0%, 0, 0)';
    }
    return 'translate3d(-33.3333%, 0, 0)'; // idle | springing
  })();

  const trackTransition = phase === 'committing' || phase === 'springing'
    ? 'transform 280ms cubic-bezier(0.22, 0.61, 0.36, 1)'
    : 'none';

  const handleTrackTransitionEnd = (e: React.TransitionEvent) => {
    if (e.propertyName !== 'transform') return;
    if (phase === 'committing') {
      if (commitDirection === 1) {
        setCurrentIndex((prev) => (prev < photos.length - 1 ? prev + 1 : 0));
      } else {
        setCurrentIndex((prev) => (prev > 0 ? prev - 1 : photos.length - 1));
      }
      setDragX(0);
      setPhase('idle');
    } else if (phase === 'springing') {
      setPhase('idle');
    }
  };

  const prevPhoto = photos.length > 1
    ? photos[(currentIndex - 1 + photos.length) % photos.length]
    : null;
  const nextPhoto = photos.length > 1
    ? photos[(currentIndex + 1) % photos.length]
    : null;

  // Apply protection class to the lightbox container
  const lightboxClass = useEnhancedProtection ? 
    `fixed inset-0 bg-black z-50 flex items-center justify-center protected-image protection-${protectionLevel}` :
    'fixed inset-0 bg-black z-50 flex items-center justify-center';

  const desktopFeedbackWidth = 416; // 26rem; keep in sync with panel width
  const isDesktopFeedback = showFeedback && !isSmallScreen;

  return (
    <div className={lightboxClass}>
      {/* Close button. top respects iOS safe-area (notch) so it doesn't
         disappear under the camera/dynamic-island. */}
      <button
        onClick={onClose}
        className="absolute p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors z-30"
        aria-label="Close"
        style={{
          top: 'max(1rem, env(safe-area-inset-top))',
          right: isDesktopFeedback ? `${desktopFeedbackWidth + 16}px` : 'max(1rem, env(safe-area-inset-right))'
        }}
      >
        <X className="w-6 h-6 text-white" />
      </button>

      {/* Navigation buttons */}
      <button
        onClick={goToPrevious}
        className="absolute left-4 top-1/2 -translate-y-1/2 p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors z-20"
        aria-label="Previous photo"
      >
        <ChevronLeft className="w-6 h-6 text-white" />
      </button>

      {!showFeedback || !isSmallScreen ? (
        <button
          onClick={goToNext}
          className="absolute top-1/2 -translate-y-1/2 p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors z-30"
          aria-label="Next photo"
          style={{ right: isDesktopFeedback ? `${desktopFeedbackWidth + 16}px` : '1rem' }}
        >
          <ChevronRight className="w-6 h-6 text-white" />
        </button>
      ) : null}

      {/* Bottom toolbar. flex-wrap + reduced gap/padding on mobile prevent
         the action row from clipping when feedback (likes / 5-star ratings /
         comments) is enabled. pb-[env(safe-area-inset-bottom)] keeps the
         buttons above the iOS home indicator. */}
      <div
        className="absolute bottom-0 left-0 bg-gradient-to-t from-black/80 to-transparent px-3 pt-3 pb-3 sm:p-4 z-20"
        style={{
          right: isDesktopFeedback ? `${desktopFeedbackWidth}px` : 0,
          paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))'
        }}
      >
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-2 flex-wrap">
          <div className="text-white min-w-0">
            <p className="text-sm opacity-75">
              {currentIndex + 1} / {photos.length}
            </p>
            {/* #508 — original camera filename next to the counter when
                the admin has flipped the matching toggle. Falls back to
                the storage filename only if `original_filename` is null
                (pre-migration-062 uploads). truncate + max-w keep long
                names from pushing the action row to another line. */}
            {showOriginalFilename && (currentPhoto.original_filename || currentPhoto.filename) && (
              <p
                className="text-xs opacity-60 truncate max-w-[14rem] sm:max-w-md mt-0.5"
                title={currentPhoto.original_filename || currentPhoto.filename}
              >
                {currentPhoto.original_filename || currentPhoto.filename}
              </p>
            )}
          </div>

          <div className="flex items-center gap-1 sm:gap-2 flex-wrap justify-end">
            <button
              onClick={handleZoomOut}
              disabled={zoom <= 1}
              className="p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Zoom out"
            >
              <ZoomOut className="w-5 h-5 text-white" />
            </button>
            <span className="text-white text-sm w-12 text-center">
              {Math.round(zoom * 100)}%
            </span>
            <button
              onClick={handleZoomIn}
              disabled={zoom >= 3}
              className="p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Zoom in"
            >
              <ZoomIn className="w-5 h-5 text-white" />
            </button>
            
            <div className="w-px h-6 bg-white/20 mx-2" />
            
            {photoAllowsDownload && (
              <button
                onClick={handleDownload}
                className="p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors"
                aria-label="Download photo"
              >
                <Download className="w-5 h-5 text-white" />
              </button>
            )}

            {/* Inline Like */}
            {feedbackEnabled && feedbackSettings?.allow_likes && (
              <div className="flex items-center gap-1">
                <button
                  onClick={submitLike}
                  className={`p-2 rounded-full transition-colors ${myLiked ? 'bg-red-500/80 hover:bg-red-500' : 'bg-white/10 hover:bg-white/20'}`}
                  aria-label={myLiked ? 'Unlike photo' : 'Like photo'}
                  title={myLiked ? 'Unlike' : 'Like'}
                >
                  {/* fill-current on the liked state so the heart is
                      actually visible against the red background — both
                      branches were `text-white` only (#538 follow-on
                      bug from @Tietge86). */}
                  <Heart className={`w-5 h-5 text-white ${myLiked ? 'fill-current' : ''}`} />
                </button>
                {/* Aggregate like count is admin-only when the admin
                    has hidden feedback from guests (#538 bug 3). Without
                    this gate, a guest could see how many other guests
                    liked a photo even with show_feedback_to_guests off. */}
                {feedbackSettings?.show_feedback_to_guests && (
                  <span className="text-white text-xs min-w-[1.5rem] text-center select-none">{likeCount}</span>
                )}
              </div>
            )}

            {/* Inline Rating */}
            {feedbackEnabled && feedbackSettings?.allow_ratings && (
              <div className="flex items-center gap-1 ml-1" aria-label="Rate photo">
                {[1,2,3,4,5].map((i) => (
                  <button
                    key={i}
                    onClick={() => submitRating(i)}
                    className="p-1"
                    aria-label={`Rate ${i} star${i>1?'s':''}`}
                    title={`Rate ${i}`}
                  >
                    <Star className={`w-5 h-5 ${myRating >= i ? 'text-yellow-400 fill-yellow-400' : 'text-white/70'}`} />
                  </button>
                ))}
                <span className="text-white/90 text-xs ml-2 select-none">{avgRating.toFixed(1)} ({totalRatings})</span>
              </div>
            )}
            
            {/* Feedback button with indicator. Gated on allow_comments
                because likes/ratings already have their own dedicated
                toolbar buttons above — this MessageSquare button only
                opens the comments panel, so it has nothing to do when
                comments are off (#518). */}
            {feedbackEnabled && feedbackSettings?.allow_comments && (
              <button
                onClick={() => {
                  setShowFeedback(!showFeedback);
                }}
                className="relative p-2 bg-black/40 hover:bg-black/60 rounded-full border border-white/40 transition-colors"
                aria-label="Toggle feedback"
                title={`Photo feedback${(currentPhoto.comment_count ?? 0) > 0 ? ` (${currentPhoto.comment_count ?? 0} comments)` : ''}`}
              >
                <MessageSquare className="w-5 h-5 text-white" />
                {((currentPhoto.comment_count ?? 0) > 0 || (currentPhoto.average_rating ?? 0) > 0) && (
                  <span className="absolute -top-1 -right-1 bg-accent-dark/150 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                    {(currentPhoto.comment_count ?? 0) > 0 ? currentPhoto.comment_count ?? 0 : '★'}
                  </span>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Image/Video container.
         For photos this hosts a 3-slide carousel (prev/current/next) so
         swipe gestures animate the track and the neighbour images preload
         while the user views the current one. Videos still render as a
         single player — sliding video elements during a drag is awkward
         and the carousel adds nothing for that case. */}
      {(() => {
        const isVideoCurrent = currentPhoto.media_type === 'video';

        // Stable per-slide keys so React's reconciler can MOVE existing
        // DOM nodes across slot positions on commit rather than
        // re-fetching the AuthenticatedImage at the new position (#505 —
        // that re-fetch is what caused the black blink during swipe).
        // Edge case: 2-photo galleries assign the same photo to both
        // `prev` and `next`; fall back to slot-prefixed keys to keep
        // siblings unique. >2-photo galleries (the common case) get
        // plain photo.id keys so a "next becomes current" commit
        // preserves the loaded image instance.
        const slideKey = (photo: Photo | null, slot: 'prev' | 'current' | 'next') => {
          if (!photo) return `empty-${slot}`;
          if (photos.length === 2) return `${slot}-${photo.id}`;
          return `photo-${photo.id}`;
        };

        const renderSlide = (photo: Photo | null, isCurrent: boolean, slot: 'prev' | 'current' | 'next') => {
          // Reserve the slot even when there's no neighbour (single-photo
          // gallery) so the flex layout keeps slides aligned.
          if (!photo) {
            return <div key={slideKey(photo, slot)} className="h-full" style={{ flex: '0 0 33.3333%' }} aria-hidden="true" />;
          }

          // Neighbouring slides are plain thumbnails — they're only on
          // screen during the swipe animation, so we save the work of a
          // protected canvas pipeline for them. The current slide keeps
          // the full protection chain. Wrapper className matches the
          // current slide so object-contain sizing renders the same
          // visible height (#505 — earlier `px-2` made wide images
          // shorter on neighbours than on current).
          if (!isCurrent) {
            return (
              <div key={slideKey(photo, slot)} className="h-full flex items-center justify-center" style={{ flex: '0 0 33.3333%' }}>
                {photo.media_type === 'video' && photo.thumbnail_url ? (
                  <img
                    src={photo.thumbnail_url}
                    alt={photo.filename}
                    className="max-w-full max-h-full object-contain select-none pointer-events-none"
                    draggable={false}
                  />
                ) : (
                  <AuthenticatedImage
                    // Prefer the lightbox preview tier when the admin
                    // opted in (#492). Falls back to `url` (the
                    // original) when preview_url is null — happens
                    // when the toggle is off, when the photo is a
                    // video, or briefly while lazy generation runs.
                    src={photo.preview_url || photo.url}
                    alt={photo.filename}
                    fallbackSrc={photo.thumbnail_url || undefined}
                    className="max-w-full max-h-full object-contain select-none pointer-events-none"
                    draggable={false}
                    isGallery={true}
                    slug={slug}
                    photoId={photo.id}
                    requiresToken={photo.requires_token}
                    secureUrlTemplate={photo.secure_url_template}
                  />
                )}
              </div>
            );
          }

          return (
            <div
              key={slideKey(photo, slot)}
              className="h-full flex items-center justify-center"
              style={{ flex: '0 0 33.3333%' }}
              onClick={handleImageClick}
            >
              <AuthenticatedImage
                // Same preview-prefer-with-fallback logic as the
                // off-screen tile above (#492).
                src={photo.preview_url || photo.url}
                alt={photo.filename}
                fallbackSrc={photo.thumbnail_url || undefined}
                className="max-w-full max-h-full object-contain select-none"
                style={{
                  transform: `scale(${zoom}) translate(${dragOffset.x / zoom}px, ${dragOffset.y / zoom}px)`,
                  transition: isDragging ? 'none' : 'transform 0.2s',
                }}
                draggable={false}
                useWatermark={useEnhancedProtection}
                watermarkText={useEnhancedProtection ? `${photo.filename} - Protected` : undefined}
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
                detectDevTools={protectionLevel === 'enhanced' || protectionLevel === 'maximum'}
                onProtectionViolation={(violationType) => {
                  console.warn(`Protection violation in lightbox for photo ${photo.id}: ${violationType}`);

                  if (typeof window !== 'undefined' && (window as any).umami) {
                    (window as any).umami.track('lightbox_protection_violation', {
                      photoId: photo.id,
                      violationType,
                      protectionLevel,
                      zoom
                    });
                  }

                  if (protectionLevel === 'maximum' &&
                      ['devtools_detected', 'print_screen_detected', 'canvas_access_blocked'].includes(violationType)) {
                    onClose();
                  }
                }}
              />
            </div>
          );
        };

        return (
          <div
            ref={trackContainerRef}
            className="absolute top-0 left-0 bottom-0 overflow-hidden z-0"
            onClick={isVideoCurrent ? undefined : handleImageClick}
            onMouseDown={isVideoCurrent ? undefined : handleMouseDown}
            onMouseMove={isVideoCurrent ? undefined : handleMouseMove}
            onMouseUp={isVideoCurrent ? undefined : handleMouseUp}
            onMouseLeave={isVideoCurrent ? undefined : handleMouseUp}
            onTouchStart={isVideoCurrent ? undefined : handleTouchStart}
            onTouchMove={isVideoCurrent ? undefined : handleTouchMove}
            onTouchEnd={isVideoCurrent ? undefined : handleTouchEnd}
            onTouchCancel={isVideoCurrent ? undefined : handleTouchCancel}
            style={{
              cursor: isVideoCurrent ? 'default' : (zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default'),
              right: isDesktopFeedback ? `${desktopFeedbackWidth}px` : 0,
              // Tell the browser we handle horizontal gestures ourselves so
              // it doesn't fight us with edge-swipe back navigation, native
              // pinch-zoom, etc. Videos keep default touch behaviour.
              touchAction: isVideoCurrent ? 'auto' : 'none',
            }}
          >
            {isVideoCurrent ? (
              <div className="w-full h-full flex items-center justify-center">
                <VideoPlayer
                  src={currentPhoto.url}
                  poster={currentPhoto.thumbnail_url}
                  className="max-w-full max-h-full"
                  controls={true}
                  autoPlay={false}
                />
              </div>
            ) : (
              <div
                className="absolute inset-0 flex items-stretch"
                style={{
                  width: '300%',
                  transform: trackTransform,
                  transition: trackTransition,
                  willChange: 'transform',
                }}
                onTransitionEnd={handleTrackTransitionEnd}
              >
                {renderSlide(prevPhoto, false, 'prev')}
                {renderSlide(currentPhoto, true, 'current')}
                {renderSlide(nextPhoto, false, 'next')}
              </div>
            )}
          </div>
        );
      })()}

      {/* Feedback Panel */}
      {showFeedback && (
        <div className="absolute right-0 top-0 bottom-0 w-full sm:w-[26rem] bg-surface shadow-xl z-20 overflow-y-auto flex flex-col border-l border-surface">
          <div className="sticky top-0 bg-surface border-b border-surface px-4 py-3 flex items-center justify-between">
            <h3 className="font-semibold" style={{ color: 'var(--color-text)' }}>Photo Feedback</h3>
            <button
              onClick={() => setShowFeedback(false)}
              className="p-1 hover:bg-black/10 rounded transition-colors"
              aria-label="Close feedback"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="p-4 flex-1 overflow-y-auto">
            <PhotoFeedback
              photoId={String(currentPhoto.id)}
              gallerySlug={slug}
              showComments={true}
              className="space-y-4"
              onFeedbackUpdate={() => {
                if (onFeedbackChange) onFeedbackChange();
              }}
            />
          </div>
        </div>
      )}

      {/* Identity Modal for required name/email */}
      <FeedbackIdentityModal
        isOpen={showIdentityModal}
        onClose={() => { setShowIdentityModal(false); setPendingAction(null); }}
        onSubmit={async (name, email) => {
          setSavedIdentity({ name, email });
          setShowIdentityModal(false);
          if (pendingAction?.type === 'like') {
            try {
              await feedbackService.submitFeedback(slug, String(currentPhoto.id), {
                feedback_type: 'like',
                guest_name: name,
                guest_email: email,
              });
              setMyLiked(true);
            } catch (err) {
              // Per-guest cap reached (#655) on the post-identity-modal submit.
              if (!handleLimitError(err)) throw err;
            }
          } else if (pendingAction?.type === 'rating' && pendingAction.rating) {
            await feedbackService.submitFeedback(slug, String(currentPhoto.id), {
              feedback_type: 'rating',
              rating: pendingAction.rating,
              guest_name: name,
              guest_email: email,
            });
            setMyRating(pendingAction.rating);
          }
          setPendingAction(null);
        }}
        feedbackType={pendingAction?.type === 'rating' ? 'rating' : 'like'}
      />
      {/* Per-guest cap modal (#655). Single instance fires for any of the
          lightbox's submitFeedback paths via the shared hook. */}
      {limitModal}
    </div>
  );
};
