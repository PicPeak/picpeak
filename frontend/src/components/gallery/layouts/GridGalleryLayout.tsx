import React from 'react';
import { Download, Maximize2, Check, MessageSquare, Star, Heart, Video, Eye, EyeOff } from 'lucide-react';
import { useInView } from 'react-intersection-observer';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../../contexts/ThemeContext';
import { AuthenticatedImage } from '../../common';
import { FeedbackIdentityModal } from '../../gallery/FeedbackIdentityModal';
import { feedbackService } from '../../../services/feedback.service';
import { useGuestIdentityOptional } from '../../../contexts/GuestIdentityContext';
import type { BaseGalleryLayoutProps } from './BaseGalleryLayout';
import type { Photo } from '../../../types';

interface GridPhotoProps {
  photo: Photo;
  isSelected: boolean;
  isSelectionMode: boolean;
  onClick: () => void;
  onDownload: (e: React.MouseEvent) => void;
  onToggleSelect: () => void;
  animationType?: string;
  allowDownloads?: boolean;
  slug?: string;
  protectionLevel?: 'basic' | 'standard' | 'enhanced' | 'maximum';
  useEnhancedProtection?: boolean;
  useCanvasRendering?: boolean;
  feedbackEnabled?: boolean;
  feedbackOptions?: {
    allowLikes?: boolean;
    allowRatings?: boolean;
    allowComments?: boolean;
    requireNameEmail?: boolean;
  };
  savedIdentity?: { name: string; email: string } | null;
  onRequireIdentity?: (action: 'like', photoId: number) => void;
  onQuickComment?: () => void;
  onFeedbackChange?: () => void;
  // Immediate UI like state and callback
  liked?: boolean;
  onLikeSuccess?: () => void;
}

const GridPhoto: React.FC<GridPhotoProps> = ({
  photo,
  isSelected,
  isSelectionMode,
  onClick,
  onDownload,
  onToggleSelect,
  animationType = 'fade',
  allowDownloads = true,
  slug,
  protectionLevel = 'standard',
  useEnhancedProtection = false,
  useCanvasRendering = false,
  feedbackEnabled = false,
  feedbackOptions,
  savedIdentity,
  onRequireIdentity,
  onQuickComment,
  onFeedbackChange,
  liked = false,
  onLikeSuccess
}) => {
  const { t } = useTranslation();
  const guestIdentity = useGuestIdentityOptional();
  const [overlayVisible, setOverlayVisible] = React.useState(false);
  const [isTouchDevice, setIsTouchDevice] = React.useState(false);
  const overlayTimeoutRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

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
  }, []);

  const hideOverlay = React.useCallback(() => {
    if (overlayTimeoutRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(overlayTimeoutRef.current);
    }
    overlayTimeoutRef.current = null;
    setOverlayVisible(false);
  }, []);

  const showOverlayTemporarily = React.useCallback(() => {
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

  React.useEffect(() => {
    return () => {
      if (overlayTimeoutRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(overlayTimeoutRef.current);
      }
    };
  }, []);

  React.useEffect(() => {
    if (isSelectionMode) {
      hideOverlay();
    }
  }, [isSelectionMode, hideOverlay]);

  // handled by parent layout; kept here for type completeness but not used
  const { ref, inView } = useInView({
    triggerOnce: true,
    threshold: 0.1,
  });

  const animationClass = animationType === 'scale' 
    ? 'transition-transform duration-300 hover:scale-105' 
    : animationType === 'fade'
    ? 'transition-opacity duration-300'
    : '';
  const likeCount = photo.like_count ?? 0;
  const averageRating = photo.average_rating ?? 0;
  const commentCount = photo.comment_count ?? 0;
  const showFeedbackActions = feedbackEnabled && Boolean(feedbackOptions);

  const overlayVisibilityClass = overlayVisible
    ? 'opacity-100 md:opacity-100'
    : 'opacity-0 md:opacity-0';

  const checkboxVisibilityClass =
    isSelected || isSelectionMode || overlayVisible
      ? 'opacity-100 md:opacity-100'
      : 'opacity-0 md:opacity-0';

  const isVideo = (photo.media_type === 'video') ||
    (photo.mime_type && photo.mime_type.startsWith('video/')) ||
    photo.type === 'video';

  const handlePhotoClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isTouchDevice && !overlayVisible && !isSelectionMode) {
      e.preventDefault();
      e.stopPropagation();
      showOverlayTemporarily();
      return;
    }

    onClick();
    if (isTouchDevice) {
      hideOverlay();
    }
  };

  return (
    <div
      ref={ref}
      className={`photo-card relative group cursor-pointer aspect-square ${animationClass}`}
      onClick={handlePhotoClick}
      style={{
        opacity: !inView && animationType === 'fade' ? 0 : 1
      }}
    >
      {inView ? (
        <>
          <AuthenticatedImage
            src={photo.thumbnail_url || photo.url}
            alt={photo.filename}
            className="w-full h-full object-cover rounded-lg"
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
            fragmentGrid={protectionLevel === 'enhanced' || protectionLevel === 'maximum'}
            blockKeyboardShortcuts={useEnhancedProtection}
            detectPrintScreen={useEnhancedProtection}
            detectDevTools={protectionLevel === 'maximum'}
            watermarkText={useEnhancedProtection ? 'Protected' : undefined}
            onProtectionViolation={(violationType: string) => {
              console.warn(`Protection violation on grid photo ${photo.id}: ${violationType}`);
            }}
          />
          
          <div className={`absolute inset-0 bg-black/40 transition-opacity duration-200 rounded-lg flex items-center justify-center gap-2 ${overlayVisibilityClass} md:group-hover:opacity-100`}>
            {!isSelectionMode && (
              <>
                <button
                  className="p-2 bg-white/90 rounded-full hover:bg-white transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClick();
                    hideOverlay();
                  }}
                  aria-label="View full size"
                >
                  <Maximize2 className="w-5 h-5 text-neutral-800" />
                </button>
                {allowDownloads && (
                  <button
                    className="p-2 bg-white/90 rounded-full hover:bg-white transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDownload(e);
                      hideOverlay();
                    }}
                    aria-label="Download photo"
                  >
                    <Download className="w-5 h-5 text-neutral-800" />
                  </button>
                )}
                {showFeedbackActions && feedbackOptions?.allowComments && onQuickComment && (
                  <button
                    className="p-2 bg-white/90 rounded-full hover:bg-white transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      onQuickComment();
                      hideOverlay();
                    }}
                    aria-label="Comment on photo"
                    title="Comment"
                  >
                    <MessageSquare className="w-5 h-5 text-neutral-800" />
                  </button>
                )}
                {/* Quick feedback actions */}
                {showFeedbackActions && feedbackOptions?.allowLikes && (
                  <button
                    className={`p-2 rounded-full transition-colors ${liked ? 'bg-red-500/90 hover:bg-red-500' : 'bg-white/90 hover:bg-white'}`}
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (guestIdentity?.identityMode === 'guest') {
                        try {
                          await guestIdentity.ensureIdentity();
                        } catch {
                          hideOverlay();
                          return;
                        }
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
                      if (feedbackOptions?.requireNameEmail && !savedIdentity && onRequireIdentity) {
                        onRequireIdentity('like', photo.id);
                        hideOverlay();
                        return;
                      }
                      // Optimistic UI: mark as liked immediately
                      if (onLikeSuccess) onLikeSuccess();
                      try {
                        await feedbackService.submitFeedback(slug!, String(photo.id), {
                          feedback_type: 'like',
                          guest_name: savedIdentity?.name,
                          guest_email: savedIdentity?.email,
                        });
                      } catch (err) {
                        // Keep optimistic state; a refresh will reconcile
                        console.warn('Like submit failed, keeping optimistic UI', err);
                      }
                      if (onFeedbackChange) onFeedbackChange();
                      hideOverlay();
                    }}
                    aria-label="Like photo"
                    aria-pressed={liked}
                    title="Like"
                  >
                    <Heart className={`w-5 h-5 ${liked ? 'text-white fill-white' : 'text-neutral-800'}`} />
                  </button>
                )}
              </>
            )}
          </div>

          {/* Selection Checkbox (visible on hover or when selected) */}
          <button
            type="button"
            aria-label={`Select ${photo.filename}`}
            role="checkbox"
            aria-checked={isSelected}
            data-testid={`gallery-photo-checkbox-${photo.id}`}
            className={`absolute top-2 right-2 z-20 transition-opacity ${checkboxVisibilityClass} md:group-hover:opacity-100`}
            onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
          >
            <div className={`w-6 h-6 rounded-full border-2 ${isSelected ? 'bg-accent-dark border-accent-dark' : 'bg-white/90 border-white'} flex items-center justify-center transition-colors`}>
              {isSelected && <Check className="w-4 h-4 text-white" />}
            </div>
          </button>

          {/* Feedback Indicators (always visible, bottom-left). Show like immediately when user liked */}
          {(commentCount > 0 || averageRating > 0 || likeCount > 0 || liked) && (
            <div className={`absolute ${photo.type === 'collage' ? 'bottom-8' : 'bottom-2'} left-2 flex items-center gap-1 z-10`}>
              {(likeCount > 0 || liked) && (
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-white/90 backdrop-blur-sm" title="Liked">
                  <Heart className="w-3.5 h-3.5 text-red-500" fill="currentColor" />
                </span>
              )}
              {averageRating > 0 && (
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-white/90 backdrop-blur-sm" title="Rated">
                  <Star className="w-3.5 h-3.5 text-yellow-500" fill="currentColor" />
                </span>
              )}
              {commentCount > 0 && (
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-white/90 backdrop-blur-sm" title="Commented">
                  <MessageSquare className="w-3.5 h-3.5 text-accent" fill="currentColor" />
                </span>
              )}
            </div>
          )}

          {isVideo && (
            <div className="absolute bottom-2 right-2">
              <span className="px-2 py-1 bg-black/60 text-white text-xs rounded flex items-center gap-1">
                <Video className="w-3 h-3" />
                {t('common.video', 'Video')}
              </span>
            </div>
          )}

          {photo.type === 'collage' && (
            <div className="absolute bottom-2 right-2">
              <span className="px-2 py-1 bg-black/60 text-white text-xs rounded">
                Collage
              </span>
            </div>
          )}
        </>
      ) : (
        <div className="skeleton aspect-square w-full rounded-lg" />
      )}
    </div>
  );
};

export const GridGalleryLayout: React.FC<BaseGalleryLayoutProps> = ({
  photos,
  slug,
  onPhotoClick,
  onOpenPhotoWithFeedback,
  onFeedbackChange,
  onDownload,
  selectedPhotos = new Set(),
  isSelectionMode = false,
  onPhotoSelect,
  allowDownloads = true,
  protectionLevel = 'standard',
  useEnhancedProtection = false,
  useCanvasRendering = false,
  feedbackEnabled = false,
  feedbackOptions,
  isClient = false,
  onToggleVisibility
}) => {
  const { theme } = useTheme();
  const gallerySettings = theme.gallerySettings || {};
  const columns = gallerySettings.gridColumns || { mobile: 2, tablet: 3, desktop: 4 };
  const spacing = gallerySettings.spacing || 'normal';
  const animation = gallerySettings.photoAnimation || 'fade';
  const scale = gallerySettings.thumbnailScale || 'md';

  const scaleOffsets: Record<string, number> = { xs: 3, sm: 1, md: 0, lg: -1, xl: -2 };
  const applyScale = (cols: number) => Math.max(1, cols + (scaleOffsets[scale] ?? 0));

  const [showIdentityModal, setShowIdentityModal] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<null | { type: 'like'; photoId: number }>(null);
  const [likedPhotoIds, setLikedPhotoIds] = React.useState<Set<number>>(new Set());
  // Seed from server is_liked on first non-empty payload (#590 follow-up).
  // Mount-only so refetches don't clobber in-session optimistic toggles.
  const likedSeededRef = React.useRef(false);
  React.useEffect(() => {
    if (likedSeededRef.current || photos.length === 0) return;
    setLikedPhotoIds(new Set(photos.filter(p => p.is_liked).map(p => p.id)));
    likedSeededRef.current = true;
  }, [photos]);
  const [savedIdentity, setSavedIdentity] = React.useState<{ name: string; email: string } | null>(null);

  const spacingClass = spacing === 'tight' ? 'gap-2' : spacing === 'relaxed' ? 'gap-6' : 'gap-4';

  const gridClass = `photo-grid grid ${spacingClass}
    grid-cols-${applyScale(columns.mobile)}
    sm:grid-cols-${applyScale(columns.tablet)}
    lg:grid-cols-${applyScale(columns.desktop)}
    xl:grid-cols-${applyScale(columns.desktop + 1)}`;

  return (
    <div className={gridClass}>
      {photos.map((photo, index) => {
        const isHidden = photo.visibility === 'hidden';
        return (
          <div key={photo.id} className={`relative ${isClient && isHidden ? 'opacity-40' : ''}`}>
            <GridPhoto
              photo={photo}
              isSelected={selectedPhotos.has(photo.id)}
              isSelectionMode={isSelectionMode}
              onClick={() => onPhotoClick(index)}
              onToggleSelect={() => onPhotoSelect && onPhotoSelect(photo.id)}
              onDownload={(e) => onDownload(photo, e)}
              animationType={animation}
              allowDownloads={allowDownloads}
              slug={slug}
              protectionLevel={protectionLevel}
              useEnhancedProtection={useEnhancedProtection}
              useCanvasRendering={useCanvasRendering}
              feedbackEnabled={feedbackEnabled}
              feedbackOptions={feedbackOptions}
              savedIdentity={savedIdentity}
              onRequireIdentity={(action, photoId) => {
                setPendingAction({ type: action, photoId });
                setShowIdentityModal(true);
              }}
              onQuickComment={() => onOpenPhotoWithFeedback && onOpenPhotoWithFeedback(index)}
              onFeedbackChange={onFeedbackChange}
              liked={likedPhotoIds.has(photo.id)}
              onLikeSuccess={() => {
                // Toggle, not add — like endpoint toggles server-side,
                // so the optimistic UI has to follow suit on click 2 (#590).
                setLikedPhotoIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(photo.id)) next.delete(photo.id);
                  else next.add(photo.id);
                  return next;
                });
              }}
            />
            {/* Client visibility toggle overlay (#172) */}
            {isClient && onToggleVisibility && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleVisibility(photo.id, photo.visibility || 'visible');
                }}
                className={`absolute top-2 left-2 z-10 p-1.5 rounded-full shadow-md transition-colors ${
                  isHidden
                    ? 'bg-red-500/90 text-white hover:bg-red-600'
                    : 'bg-white/90 text-neutral-700 hover:bg-white dark:bg-neutral-800/90 dark:text-neutral-200 dark:hover:bg-neutral-700'
                }`}
                title={isHidden ? 'Hidden from guests' : 'Visible to guests'}
              >
                {isHidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            )}
          </div>
        );
      })}
      <FeedbackIdentityModal
        isOpen={showIdentityModal}
        onClose={() => { setShowIdentityModal(false); setPendingAction(null); }}
        onSubmit={async (name, email) => {
          setSavedIdentity({ name, email });
          setShowIdentityModal(false);
          if (pendingAction) {
            await feedbackService.submitFeedback(slug, String(pendingAction.photoId), {
              feedback_type: pendingAction.type,
              guest_name: name,
              guest_email: email,
            });
            // Immediately reflect like UI — toggle for consistency (#590).
            if (pendingAction.type === 'like') {
              setLikedPhotoIds((prev) => {
                const next = new Set(prev);
                if (next.has(pendingAction.photoId)) next.delete(pendingAction.photoId);
                else next.add(pendingAction.photoId);
                return next;
              });
            }
            setPendingAction(null);
          }
        }}
        feedbackType="like"
      />
    </div>
  );
};
