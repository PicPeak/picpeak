import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Download, Maximize2, Check, MessageSquare, Heart } from 'lucide-react';
import { useInView } from 'react-intersection-observer';
import { AuthenticatedImage } from '../common';
import { thumbnailUrlForTile } from './imageTiers';
import { FeedbackIdentityModal } from './FeedbackIdentityModal';
import { feedbackService } from '../../services/feedback.service';
import { ColorLabelBadge } from './ColorLabelBadge';
import { useGuestIdentityOptional } from '../../contexts/GuestIdentityContext';
import { useInputMode } from '../../hooks/useInputMode';
import type { Photo } from '../../types';

export interface PhotoCardFeedbackOptions {
  allowLikes?: boolean;
  allowFavorites?: boolean;
  allowRatings?: boolean;
  allowComments?: boolean;
  requireNameEmail?: boolean;
}

export interface PhotoCardProps {
  photo: Photo;
  isSelected: boolean;
  isSelectionMode: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDownload: (e: React.MouseEvent) => void;
  onToggleSelect: () => void;
  /** Full container className (layout-specific positioning/animation/rounding). */
  className: string;
  style?: React.CSSProperties;
  /** Extra attributes for the container div (e.g. role/tabIndex/onKeyDown). */
  containerProps?: React.HTMLAttributes<HTMLDivElement>;
  /** Props passed verbatim to AuthenticatedImage. */
  imageProps: React.ComponentProps<typeof AuthenticatedImage>;
  /** Lazy-render via IntersectionObserver with a skeleton placeholder. */
  lazy?: boolean;
  inViewRootMargin?: string;
  /**
   * Outer band, in `rootMargin` form. When set, a tile that leaves it is
   * unmounted again rather than kept for the life of the page (#1287). Opt-in
   * per layout: only a layout whose skeleton holds the tile's box can release
   * without reflowing, which today is Grid (`aspect-square`).
   */
  releaseRootMargin?: string;
  skeletonClassName?: string;
  /** Keep container at opacity 0 until in view (only meaningful with `lazy`). */
  fadeInWhenVisible?: boolean;
  /**
   * Static overlay classes — positioning, backdrop, spacing. Visibility and
   * hit-testing are owned by this component for every layout (#1263), so a
   * layout must NOT pass its own `opacity-*` / `group-hover:*` here.
   */
  overlayBaseClassName: string;
  /** 'light' = white/90 buttons with dark icons; 'dark' = white/20 buttons with white icons. */
  actionVariant?: 'light' | 'dark';
  allowDownloads?: boolean;
  feedbackEnabled?: boolean;
  feedbackOptions?: PhotoCardFeedbackOptions;
  slug?: string;
  onQuickComment?: () => void;
  onFeedbackChange?: () => void;
  liked?: boolean;
  onLikeSuccess?: () => void;
  /** 'self': card owns the identity modal; 'parent': delegate via onRequireIdentity. */
  identityMode?: 'self' | 'parent';
  savedIdentity?: { name: string; email: string } | null;
  onRequireIdentity?: (action: 'like', photoId: number) => void;
  /** Use Like/Unlike toggle labels on the like button (Masonry columns). */
  likeToggleLabels?: boolean;
  /** Render the Like button before the Comment button (Mosaic/Timeline). */
  likeBeforeComment?: boolean;
  /** Render data-testid on the selection checkbox. */
  checkboxTestId?: boolean;
  /** Rendered between the image and the hover overlay. */
  beforeOverlay?: React.ReactNode;
  /** Rendered between the overlay and the selection checkbox. */
  afterOverlay?: React.ReactNode;
  /** Rendered after the selection checkbox. */
  children?: React.ReactNode;
}

export const PhotoCard: React.FC<PhotoCardProps> = ({
  photo,
  isSelected,
  isSelectionMode,
  onClick,
  onDownload,
  onToggleSelect,
  className,
  style,
  containerProps,
  imageProps,
  lazy = false,
  inViewRootMargin,
  releaseRootMargin,
  skeletonClassName = 'skeleton w-full h-full rounded-lg',
  fadeInWhenVisible = false,
  overlayBaseClassName,
  actionVariant = 'light',
  allowDownloads = true,
  feedbackEnabled = false,
  feedbackOptions,
  slug,
  onQuickComment,
  onFeedbackChange,
  liked = false,
  onLikeSuccess,
  identityMode = 'parent',
  savedIdentity,
  onRequireIdentity,
  likeToggleLabels = false,
  likeBeforeComment = false,
  checkboxTestId = false,
  beforeOverlay,
  afterOverlay,
  children,
}) => {
  const guestIdentity = useGuestIdentityOptional();
  const [overlayVisible, setOverlayVisible] = useState(false);
  // #1275 — the input in use right now, not what the device is capable of.
  // On a hybrid the two disagree, and acting on the device's primary pointer
  // handles one of its two inputs as if it were the other.
  const isTouchDevice = useInputMode() === 'touch';
  const overlayTimeoutRef = useRef<number | null>(null);

  // Self-managed identity modal state (identityMode === 'self')
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<null | { type: 'like'; photoId: number }>(null);
  const [selfIdentity, setSelfIdentity] = useState<{ name: string; email: string } | null>(null);

  const savedIdentityValue = identityMode === 'self' ? selfIdentity : savedIdentity;

  const hideOverlay = useCallback(() => {
    if (overlayTimeoutRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(overlayTimeoutRef.current);
    }
    overlayTimeoutRef.current = null;
    setOverlayVisible(false);
  }, []);

  const showOverlayTemporarily = useCallback(() => {
    setOverlayVisible(true);
    if (overlayTimeoutRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(overlayTimeoutRef.current);
    }
    if (typeof window !== 'undefined') {
      overlayTimeoutRef.current = window.setTimeout(() => {
        overlayTimeoutRef.current = null;
        setOverlayVisible(false);
      }, 2500);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (overlayTimeoutRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(overlayTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (isSelectionMode) {
      hideOverlay();
    }
  }, [isSelectionMode, hideOverlay]);

  // Lazy loading with intersection observer.
  //
  // Two bands with a deliberate gap between them (#1287). The inner one, from
  // `inViewRootMargin`, decides when a tile starts loading. The outer one,
  // from `releaseRootMargin`, decides when it is far enough away to unmount —
  // and unmounting is the part that frees anything, because AuthenticatedImage
  // revokes its object URL and drops any protection canvas in its cleanup, and
  // neither is reclaimable while the tile stays mounted. On a 546-photo grid
  // the old latch meant every tile scrolled past was retained for the life of
  // the page, which is the memory profile iOS Safari discards a tab over.
  //
  // The gap between the bands is the hysteresis: a tile is not released until
  // it is well outside the band that would immediately reload it, so scrolling
  // back and forth across one edge cannot thrash. Without a release band the
  // observer keeps its original `triggerOnce` latch, so every other layout
  // behaves exactly as before.
  const releases = Boolean(lazy && releaseRootMargin);
  const { ref: loadBandRef, inView: withinLoadBand } = useInView({
    triggerOnce: !releases,
    threshold: 0.1,
    rootMargin: inViewRootMargin,
  });
  const { ref: keepBandRef, inView: withinKeepBand } = useInView({
    skip: !releases,
    threshold: 0,
    rootMargin: releaseRootMargin,
  });
  const [rendered, setRendered] = useState(false);
  useEffect(() => {
    if (!releases) return;
    if (withinLoadBand) setRendered(true);
    else if (!withinKeepBand) setRendered(false);
  }, [releases, withinLoadBand, withinKeepBand]);
  const inView = !lazy || (releases ? rendered : withinLoadBand);

  // Tile width for the responsive tier (#1095), measured rather than inferred.
  // The observer entry only exists for `lazy` cards, and Mosaic, Masonry and
  // Timeline do not pass it — Mosaic is 1-up on mobile where Grid is 2-up, so
  // those are exactly the layouts a breakpoint guess gets most wrong.
  //
  // Gated: the image is not rendered until this has run, so AuthenticatedImage
  // never mounts with a src it would have to replace. Attaching the observer
  // ref unconditionally instead would refetch every tile — React flushes
  // passive effects before the synchronous re-render a layout effect triggers,
  // so the fetch fires once with the fallback and again with the measurement.
  //
  // useLayoutEffect, so the extra commit lands before paint and the skeleton
  // branch below is never actually seen. One reflow per commit, not per card:
  // nothing writes to the DOM between the reads, so the browser batches them.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [tile, setTile] = useState<{ width: number | null } | null>(null);
  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (!lazy) return;
    loadBandRef(node);
    if (releases) keepBandRef(node);
  }, [loadBandRef, keepBandRef, lazy, releases]);

  useLayoutEffect(() => {
    if (!inView || tile) return;
    // 0 means not laid out (a hidden tab, say), not a 0px tile — null falls
    // back to the viewport estimate rather than pinning the smallest tier.
    setTile({ width: containerRef.current?.offsetWidth || null });
  }, [inView, tile]);

  const showFeedbackActions = feedbackEnabled && Boolean(feedbackOptions);

  // #1263 - opacity hides pixels, not hit-testing. An `opacity-0` control is
  // still tappable, and on a touchscreen (no hover) it is invisible for good,
  // so a tap in the middle of a tile silently downloaded or liked instead of
  // opening the photo. Every visibility toggle below therefore moves
  // pointer-events with it, in both the tap-to-reveal and the hover branch.
  //
  // The hover variants are emitted while a mouse is in use, and withheld while
  // a finger is. Not behind `md:`: width is the wrong proxy for hover, and a
  // mouse user with a window under 768px got no overlay at all. Not behind the
  // device's primary pointer either (#1275) — on a hybrid that answers for the
  // wrong input. Withholding them on touch is what the breakpoint was really
  // for, since :hover latches on a touchscreen once a tile has been tapped.
  const revealed = (visible: boolean) => {
    const base = visible
      ? 'opacity-100 pointer-events-auto'
      : 'opacity-0 pointer-events-none';
    return isTouchDevice
      ? base
      : `${base} group-hover:opacity-100 group-hover:pointer-events-auto`;
  };

  const overlayClassName = `${overlayBaseClassName} ${revealed(overlayVisible)}`;

  const checkboxVisibilityClass = revealed(
    isSelected || isSelectionMode || overlayVisible,
  );

  const buttonType = actionVariant === 'dark' ? ('button' as const) : undefined;
  const actionButtonClass =
    actionVariant === 'dark'
      ? 'p-2 bg-white/20 hover:bg-white/40 rounded-full transition-colors'
      : 'p-2 bg-white/90 rounded-full hover:bg-white transition-colors';
  const actionIconClass = actionVariant === 'dark' ? 'w-5 h-5 text-white' : 'w-5 h-5 text-neutral-800';

  const handlePhotoClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isTouchDevice && !overlayVisible && !isSelectionMode) {
      e.preventDefault();
      e.stopPropagation();
      showOverlayTemporarily();
      return;
    }

    onClick(e);
    if (isTouchDevice) {
      hideOverlay();
    }
  };

  const handleLike = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (guestIdentity?.identityMode === 'guest') {
      try {
        await guestIdentity.ensureIdentity();
      } catch {
        hideOverlay();
        return;
      }
      // Optimistic UI: mark as liked immediately
      if (onLikeSuccess) onLikeSuccess();
      try {
        await feedbackService.submitFeedback(slug!, String(photo.id), {
          feedback_type: 'like',
        });
      } catch (err) {
        console.warn('Like submit failed, keeping optimistic UI', err);
      }
      if (onFeedbackChange) onFeedbackChange();
      hideOverlay();
      return;
    }
    if (
      feedbackOptions?.requireNameEmail &&
      !savedIdentityValue &&
      (identityMode === 'self' || onRequireIdentity)
    ) {
      if (identityMode === 'self') {
        setPendingAction({ type: 'like', photoId: photo.id });
        setShowIdentityModal(true);
      } else if (onRequireIdentity) {
        onRequireIdentity('like', photo.id);
      }
      hideOverlay();
      return;
    }
    // Optimistic UI: mark as liked immediately
    if (onLikeSuccess) onLikeSuccess();
    try {
      await feedbackService.submitFeedback(slug!, String(photo.id), {
        feedback_type: 'like',
        guest_name: savedIdentityValue?.name,
        guest_email: savedIdentityValue?.email,
      });
    } catch (err) {
      // Keep optimistic state; a refresh will reconcile
      console.warn('Like submit failed, keeping optimistic UI', err);
    }
    if (onFeedbackChange) onFeedbackChange();
    hideOverlay();
  };

  const commentButton =
    showFeedbackActions && feedbackOptions?.allowComments && onQuickComment ? (
      <button
        className={actionButtonClass}
        onClick={(e) => {
          e.stopPropagation();
          onQuickComment();
          hideOverlay();
        }}
        aria-label="Comment on photo"
        title="Comment"
      >
        <MessageSquare className={actionIconClass} />
      </button>
    ) : null;

  const likeButton =
    showFeedbackActions && feedbackOptions?.allowLikes ? (
      <button
        className={`p-2 rounded-full transition-colors ${
          liked ? 'bg-red-500/90 hover:bg-red-500' : 'bg-white/90 hover:bg-white'
        }`}
        onClick={handleLike}
        aria-label={likeToggleLabels && liked ? 'Unlike photo' : 'Like photo'}
        aria-pressed={liked}
        title={likeToggleLabels ? (liked ? 'Unlike' : 'Like') : 'Like'}
      >
        <Heart className={`w-5 h-5 ${liked ? 'text-white fill-white' : 'text-neutral-800'}`} />
      </button>
    ) : null;

  // Responsive grid tier (#1095). Applied here rather than in each layout
  // because six of the seven funnel their tile through this one image; the
  // seventh, Carousel, renders 80px filmstrip thumbs that the canonical 300
  // already covers at DPR 3.
  //
  // Only when the src IS the thumbnail route: layouts fall back to photo.url
  // when thumbnail_url is null, and ?w= on the original-photo route means
  // something else. Videos are excluded because their thumbnail is a poster
  // frame from the video pipeline — the tier route would hand the video file
  // itself to Sharp.
  const isVideo = photo.media_type === 'video' || photo.type === 'video';
  const tileSrc = !isVideo && photo.thumbnail_url && imageProps.src === photo.thumbnail_url
    ? (thumbnailUrlForTile(photo.thumbnail_url, photo, tile?.width) ?? imageProps.src)
    : imageProps.src;

  return (
    <div
      ref={setContainerRef}
      className={className}
      style={lazy ? { ...style, opacity: !inView && fadeInWhenVisible ? 0 : 1 } : style}
      onClick={handlePhotoClick}
      {...containerProps}
    >
      {inView && tile ? (
        <>
          <AuthenticatedImage {...imageProps} src={tileSrc} />

          {/* The guest's own colour label (#1044) — visible without hovering
              or opening anything, which is the point: the client watches
              their selection progress across the grid. */}
          <ColorLabelBadge
            colorLabel={photo.my_color_label}
            otherColorLabels={photo.other_color_labels}
          />

          {beforeOverlay}

          {/* Hover Overlay */}
          <div className={overlayClassName}>
            {!isSelectionMode && (
              <>
                <button
                  type={buttonType}
                  className={actionButtonClass}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClick(e);
                    hideOverlay();
                  }}
                  aria-label="View full size"
                >
                  <Maximize2 className={actionIconClass} />
                </button>
                {allowDownloads && (
                  <button
                    type={buttonType}
                    className={actionButtonClass}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDownload(e);
                      hideOverlay();
                    }}
                    aria-label="Download photo"
                  >
                    <Download className={actionIconClass} />
                  </button>
                )}
                {likeBeforeComment ? (
                  <>
                    {likeButton}
                    {commentButton}
                  </>
                ) : (
                  <>
                    {commentButton}
                    {likeButton}
                  </>
                )}
              </>
            )}
          </div>

          {/* Identity Modal (self-managed mode) */}
          {identityMode === 'self' && (
            <FeedbackIdentityModal
              isOpen={showIdentityModal}
              onClose={() => { setShowIdentityModal(false); setPendingAction(null); }}
              onSubmit={async (name, email) => {
                setSelfIdentity({ name, email });
                setShowIdentityModal(false);
                if (pendingAction) {
                  if (pendingAction.type === 'like' && onLikeSuccess) {
                    onLikeSuccess();
                  }
                  await feedbackService.submitFeedback(slug!, String(pendingAction.photoId), {
                    feedback_type: pendingAction.type,
                    guest_name: name,
                    guest_email: email,
                  });
                  setPendingAction(null);
                }
              }}
              feedbackType="like"
            />
          )}

          {afterOverlay}

          {/* Selection Checkbox (visible on hover or when selected) */}
          <button
            type="button"
            aria-label={`Select ${photo.filename}`}
            role="checkbox"
            aria-checked={isSelected}
            data-testid={checkboxTestId ? `gallery-photo-checkbox-${photo.id}` : undefined}
            className={`absolute top-2 right-2 z-20 transition-opacity ${checkboxVisibilityClass}`}
            onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
          >
            <div className={`w-6 h-6 rounded-full border-2 ${isSelected ? 'bg-accent-dark border-accent-dark' : 'bg-white/90 border-white'} flex items-center justify-center transition-colors`}>
              {isSelected && <Check className="w-4 h-4 text-white" />}
            </div>
          </button>

          {children}
        </>
      ) : (
        <div className={skeletonClassName} />
      )}
    </div>
  );
};
