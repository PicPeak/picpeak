import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Maximize2, Check, MessageSquare, Heart } from 'lucide-react';
import { useInView } from 'react-intersection-observer';
import { AuthenticatedImage } from '../common';
import { FeedbackIdentityModal } from './FeedbackIdentityModal';
import { feedbackService } from '../../services/feedback.service';
import { useGuestIdentityOptional } from '../../contexts/GuestIdentityContext';
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
  skeletonClassName?: string;
  /** Keep container at opacity 0 until in view (only meaningful with `lazy`). */
  fadeInWhenVisible?: boolean;
  /** Tap-to-reveal overlay state machine for touch devices (Grid/Justified). */
  touchAware?: boolean;
  /** Static overlay classes; `touchAware` appends computed visibility classes. */
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
  skeletonClassName = 'skeleton w-full h-full rounded-lg',
  fadeInWhenVisible = false,
  touchAware = false,
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
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const overlayTimeoutRef = useRef<number | null>(null);

  // Self-managed identity modal state (identityMode === 'self')
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<null | { type: 'like'; photoId: number }>(null);
  const [selfIdentity, setSelfIdentity] = useState<{ name: string; email: string } | null>(null);

  const savedIdentityValue = identityMode === 'self' ? selfIdentity : savedIdentity;

  // Detect touch device (touch-aware overlay only)
  useEffect(() => {
    if (!touchAware || typeof window === 'undefined') return;

    const mediaQuery = window.matchMedia('(hover: none) and (pointer: coarse)');
    const updateTouchState = () => {
      const hasNavigator = typeof navigator !== 'undefined';
      setIsTouchDevice(
        mediaQuery.matches ||
        ('ontouchstart' in window) ||
        (hasNavigator && navigator.maxTouchPoints > 0)
      );
    };

    updateTouchState();

    const listener = (event: MediaQueryListEvent) => {
      setIsTouchDevice(event.matches);
    };

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', listener);
    } else if (mediaQuery.addListener) {
      mediaQuery.addListener(listener);
    }

    return () => {
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener('change', listener);
      } else if (mediaQuery.removeListener) {
        mediaQuery.removeListener(listener);
      }
    };
  }, [touchAware]);

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

  // Lazy loading with intersection observer
  const { ref, inView: observedInView } = useInView({
    triggerOnce: true,
    threshold: 0.1,
    rootMargin: inViewRootMargin,
  });
  const inView = !lazy || observedInView;

  const showFeedbackActions = feedbackEnabled && Boolean(feedbackOptions);

  const overlayVisibilityClass = overlayVisible
    ? 'opacity-100 md:opacity-100'
    : 'opacity-0 md:opacity-0';

  const overlayClassName = touchAware
    ? `${overlayBaseClassName} ${overlayVisibilityClass} md:group-hover:opacity-100`
    : overlayBaseClassName;

  const checkboxVisibilityClass = touchAware
    ? `${
        isSelected || isSelectionMode || overlayVisible
          ? 'opacity-100 md:opacity-100'
          : 'opacity-0 md:opacity-0'
      } md:group-hover:opacity-100`
    : isSelected
      ? 'opacity-100'
      : 'opacity-0 group-hover:opacity-100';

  const buttonType = actionVariant === 'dark' ? ('button' as const) : undefined;
  const actionButtonClass =
    actionVariant === 'dark'
      ? 'p-2 bg-white/20 hover:bg-white/40 rounded-full transition-colors'
      : 'p-2 bg-white/90 rounded-full hover:bg-white transition-colors';
  const actionIconClass = actionVariant === 'dark' ? 'w-5 h-5 text-white' : 'w-5 h-5 text-neutral-800';

  const handlePhotoClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!touchAware) {
      onClick(e);
      return;
    }

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

  return (
    <div
      ref={lazy ? ref : undefined}
      className={className}
      style={lazy ? { ...style, opacity: !inView && fadeInWhenVisible ? 0 : 1 } : style}
      onClick={handlePhotoClick}
      {...containerProps}
    >
      {inView ? (
        <>
          <AuthenticatedImage {...imageProps} />

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
