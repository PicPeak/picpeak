import React, { useEffect, useRef, useState, useMemo } from 'react';
import { MessageSquare, Star, Heart, Video, ChevronDown, Calendar, Clock } from 'lucide-react';
import { parseISO } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { useTheme } from '../../../contexts/ThemeContext';
import { AuthenticatedImage } from '../../common';
import { PhotoCard } from '../PhotoCard';
import { FeedbackIdentityModal } from '../../gallery/FeedbackIdentityModal';
import { feedbackService } from '../../../services/feedback.service';
import { buildResourceUrl } from '../../../utils/url';
import type { BaseGalleryLayoutProps } from './BaseGalleryLayout';
import type { Photo } from '../../../types';
import {
  calculateJustifiedLayout,
  createJustifiedPhotos,
  type JustifiedLayoutItem,
} from '../../../utils/justifiedLayoutCalculator';

interface JustifiedGalleryLayoutProps extends BaseGalleryLayoutProps {
  // Hero section props (optional)
  eventName?: string;
  eventLogo?: string | null;
  eventDate?: string;
  expiresAt?: string;
  heroPhotoOverride?: Photo | null;
  heroLogoVisible?: boolean;
  heroLogoSize?: 'small' | 'medium' | 'large' | 'xlarge';
  heroLogoPosition?: 'top' | 'center' | 'bottom';
}

interface JustifiedPhotoProps {
  photo: Photo;
  layoutItem: JustifiedLayoutItem;
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
  liked?: boolean;
  onLikeSuccess?: () => void;
}

const JustifiedPhoto: React.FC<JustifiedPhotoProps> = ({
  photo,
  layoutItem,
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
  onLikeSuccess,
}) => {
  const animationClass =
    animationType === 'scale'
      ? 'transition-transform duration-300 hover:scale-[1.02]'
      : animationType === 'fade'
        ? 'transition-opacity duration-300'
        : '';

  const likeCount = photo.like_count ?? 0;
  const averageRating = photo.average_rating ?? 0;
  const commentCount = photo.comment_count ?? 0;

  const isVideo =
    photo.media_type === 'video' ||
    (photo.mime_type && photo.mime_type.startsWith('video/')) ||
    photo.type === 'video';

  return (
    <PhotoCard
      photo={photo}
      isSelected={isSelected}
      isSelectionMode={isSelectionMode}
      onClick={onClick}
      onDownload={onDownload}
      onToggleSelect={onToggleSelect}
      className={`photo-card absolute group cursor-pointer overflow-hidden rounded-lg ${animationClass}`}
      style={{
        top: layoutItem.y,
        left: layoutItem.x,
        width: layoutItem.width,
        height: layoutItem.height,
      }}
      containerProps={{
        role: 'button',
        tabIndex: 0,
        'aria-label': `View photo ${photo.filename}`,
        onKeyDown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick();
          }
        },
      }}
      lazy
      inViewRootMargin="100px"
      fadeInWhenVisible={animationType === 'fade'}
      skeletonClassName="skeleton w-full h-full rounded-lg"
      touchAware
      imageProps={{
        src: photo.thumbnail_url || photo.url,
        alt: photo.filename,
        className: 'w-full h-full object-cover',
        loading: 'lazy',
        isGallery: true,
        slug,
        photoId: photo.id,
        requiresToken: photo.requires_token,
        secureUrlTemplate: photo.secure_url_template,
        protectFromDownload: !allowDownloads || useEnhancedProtection,
        protectionLevel,
        useEnhancedProtection,
        useCanvasRendering: useCanvasRendering || protectionLevel === 'maximum',
        fragmentGrid: protectionLevel === 'enhanced' || protectionLevel === 'maximum',
        blockKeyboardShortcuts: useEnhancedProtection,
        detectPrintScreen: useEnhancedProtection,
        detectDevTools: protectionLevel === 'maximum',
        watermarkText: useEnhancedProtection ? 'Protected' : undefined,
        onProtectionViolation: (violationType: string) => {
          console.warn(`Protection violation on justified photo ${photo.id}: ${violationType}`);
        },
      }}
      overlayBaseClassName="absolute inset-0 bg-black/40 transition-opacity duration-200 flex items-center justify-center gap-2"
      allowDownloads={allowDownloads}
      feedbackEnabled={feedbackEnabled}
      feedbackOptions={feedbackOptions}
      slug={slug}
      onQuickComment={onQuickComment}
      onFeedbackChange={onFeedbackChange}
      liked={liked}
      onLikeSuccess={onLikeSuccess}
      savedIdentity={savedIdentity}
      onRequireIdentity={onRequireIdentity}
      checkboxTestId
    >
      {/* Feedback Indicators */}
      {(commentCount > 0 || averageRating > 0 || likeCount > 0 || liked) && (
        <div
          className={`absolute ${photo.type === 'collage' ? 'bottom-8' : 'bottom-2'} left-2 flex items-center gap-1 z-10`}
        >
          {(likeCount > 0 || liked) && (
            <span
              className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-white/90 backdrop-blur-sm"
              title="Liked"
            >
              <Heart className="w-3.5 h-3.5 text-red-500" fill="currentColor" />
            </span>
          )}
          {averageRating > 0 && (
            <span
              className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-white/90 backdrop-blur-sm"
              title="Rated"
            >
              <Star className="w-3.5 h-3.5 text-yellow-500" fill="currentColor" />
            </span>
          )}
          {commentCount > 0 && (
            <span
              className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-white/90 backdrop-blur-sm"
              title="Commented"
            >
              <MessageSquare className="w-3.5 h-3.5 text-accent" fill="currentColor" />
            </span>
          )}
        </div>
      )}

      {/* Video Badge */}
      {isVideo && (
        <div className="absolute bottom-2 right-2">
          <span className="px-2 py-1 bg-black/60 text-white text-xs rounded flex items-center gap-1">
            <Video className="w-3 h-3" />
            Video
          </span>
        </div>
      )}

      {/* Collage Badge */}
      {photo.type === 'collage' && (
        <div className="absolute bottom-2 right-2">
          <span className="px-2 py-1 bg-black/60 text-white text-xs rounded">Collage</span>
        </div>
      )}
    </PhotoCard>
  );
};

export const JustifiedGalleryLayout: React.FC<JustifiedGalleryLayoutProps> = ({
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
  // Hero props
  eventName,
  eventLogo,
  eventDate,
  expiresAt,
  heroPhotoOverride,
  heroLogoVisible = true,
  heroLogoSize = 'medium',
  heroLogoPosition = 'top',
}) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [heroPhoto, setHeroPhoto] = useState<Photo | null>(null);
  const [hasHeroInitialized, setHasHeroInitialized] = useState(false);

  const gallerySettings = theme.gallerySettings || {};
  const spacing = gallerySettings.spacing || 'normal';
  const animation = gallerySettings.photoAnimation || 'fade';
  const targetRowHeight = gallerySettings.justifiedRowHeight || 250;
  const lastRowBehavior = gallerySettings.justifiedLastRowBehavior || 'left';
  const showHero = gallerySettings.justifiedShowHero || false;
  const heroHeight = gallerySettings.justifiedHeroHeight || 'medium';
  const overlayOpacity = gallerySettings.heroOverlayOpacity || 0.3;

  // Helper function to get hero height classes
  const getHeroHeightClass = (height: string): string => {
    switch (height) {
      case 'small':
        return 'h-[40vh] sm:h-[50vh]';
      case 'medium':
        return 'h-[50vh] sm:h-[60vh] lg:h-[70vh]';
      case 'large':
        return 'h-[60vh] sm:h-[70vh] lg:h-[80vh]';
      default:
        return 'h-[50vh] sm:h-[60vh] lg:h-[70vh]';
    }
  };

  // Helper function to get logo size classes
  const getLogoSizeClasses = (size: string): string => {
    switch (size) {
      case 'small':
        return 'h-12 sm:h-14 lg:h-16';
      case 'medium':
        return 'h-20 sm:h-24 lg:h-32';
      case 'large':
        return 'h-28 sm:h-32 lg:h-40';
      case 'xlarge':
        return 'h-36 sm:h-40 lg:h-48';
      default:
        return 'h-20 sm:h-24 lg:h-32';
    }
  };

  // Initialize hero photo when hero is enabled
  useEffect(() => {
    if (!showHero) return;

    if (heroPhotoOverride) {
      setHeroPhoto(heroPhotoOverride);
      setHasHeroInitialized(true);
      return;
    }

    if (photos.length > 0) {
      const heroId = gallerySettings.heroImageId;
      if (heroId) {
        const adminSelectedHero = photos.find(p => p.id === heroId);
        if (adminSelectedHero) {
          setHeroPhoto(adminSelectedHero);
          setHasHeroInitialized(true);
          return;
        }
      }

      if (!hasHeroInitialized) {
        setHeroPhoto(photos[0]);
        setHasHeroInitialized(true);
      }
    }
  }, [showHero, photos, gallerySettings.heroImageId, hasHeroInitialized, heroPhotoOverride]);

  // Get spacing value in pixels
  const spacingPixels = spacing === 'tight' ? 8 : spacing === 'relaxed' ? 24 : 16;

  // Identity modal state
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<null | { type: 'like'; photoId: number }>(
    null
  );
  const [likedPhotoIds, setLikedPhotoIds] = useState<Set<number>>(new Set());
  // Seed from server is_liked on first non-empty payload (#590 follow-up).
  // Mount-only so refetches don't clobber in-session optimistic toggles.
  const likedSeededRef = useRef(false);
  useEffect(() => {
    if (likedSeededRef.current || photos.length === 0) return;
    setLikedPhotoIds(new Set(photos.filter(p => p.is_liked).map(p => p.id)));
    likedSeededRef.current = true;
  }, [photos]);
  const [savedIdentity, setSavedIdentity] = useState<{ name: string; email: string } | null>(null);

  // Track container width with ResizeObserver
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateWidth = () => {
      const width = container.offsetWidth;
      if (width > 0) {
        setContainerWidth(width);
      }
    };

    // Initial measurement
    updateWidth();

    // Use ResizeObserver for responsive updates
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0) {
          setContainerWidth(entry.contentRect.width);
        }
      }
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  // Calculate layout whenever photos or container width changes
  const layoutResult = useMemo(() => {
    if (containerWidth <= 0 || photos.length === 0) {
      return { items: [], containerHeight: 0, rowCount: 0 };
    }

    // Convert photos to justified format
    const justifiedPhotos = createJustifiedPhotos(
      photos.map((p) => ({
        id: p.id,
        width: p.width,
        height: p.height,
      }))
    );

    return calculateJustifiedLayout(justifiedPhotos, {
      containerWidth,
      targetRowHeight,
      spacing: spacingPixels,
      lastRowBehavior,
    });
  }, [photos, containerWidth, targetRowHeight, spacingPixels, lastRowBehavior]);

  // Create a map for quick lookup of layout items by photo ID
  const layoutItemMap = useMemo(() => {
    const map = new Map<number, JustifiedLayoutItem>();
    for (const item of layoutResult.items) {
      map.set(item.photoId, item);
    }
    return map;
  }, [layoutResult.items]);

  return (
    <>
      {/* Hero Section (optional) */}
      {showHero && heroPhoto && (
        <div className="relative -mt-6 mb-8">
          <div className={`relative ${getHeroHeightClass(heroHeight)} -mx-4 sm:-mx-6 lg:-mx-8`}>
            <AuthenticatedImage
              src={heroPhoto.url}
              fallbackSrc={heroPhoto.thumbnail_url || undefined}
              alt={heroPhoto.filename}
              className="w-full h-full object-cover"
              isGallery={true}
              slug={slug}
              photoId={heroPhoto.id}
              protectFromDownload={!allowDownloads || useEnhancedProtection}
              protectionLevel={protectionLevel}
              useEnhancedProtection={useEnhancedProtection}
              useCanvasRendering={useCanvasRendering || protectionLevel === 'maximum'}
            />

            {/* Overlay */}
            <div
              className="absolute inset-0 bg-black"
              style={{ opacity: overlayOpacity }}
            />

            {/* Hero Content */}
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center px-4">
                {/* Logo at top position */}
                {heroLogoVisible && heroLogoPosition === 'top' && eventLogo && (
                  <div className="mb-6">
                    <img
                      src={buildResourceUrl(eventLogo)}
                      alt="Event logo"
                      className={`${getLogoSizeClasses(heroLogoSize)} mx-auto`}
                      style={{
                        filter: 'drop-shadow(0 4px 6px rgba(0, 0, 0, 0.5))'
                      }}
                    />
                  </div>
                )}

                {/* Event Title */}
                {eventName && (
                  <h1 className="text-3xl sm:text-4xl lg:text-5xl xl:text-6xl font-bold text-white drop-shadow-lg mb-4">
                    {eventName}
                  </h1>
                )}

                {/* Logo at center position */}
                {heroLogoVisible && heroLogoPosition === 'center' && eventLogo && (
                  <div className="my-6">
                    <img
                      src={buildResourceUrl(eventLogo)}
                      alt="Event logo"
                      className={`${getLogoSizeClasses(heroLogoSize)} mx-auto`}
                      style={{
                        filter: 'drop-shadow(0 4px 6px rgba(0, 0, 0, 0.5))'
                      }}
                    />
                  </div>
                )}

                {/* Event Dates */}
                {(eventDate || expiresAt) && (
                  <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 text-white/90">
                    {eventDate && (
                      <span className="flex items-center text-lg sm:text-xl">
                        <Calendar className="w-5 h-5 sm:w-6 sm:h-6 mr-2" />
                        {format(parseISO(eventDate), 'PP')}
                      </span>
                    )}
                    {expiresAt && (
                      <span className="flex items-center text-lg sm:text-xl">
                        <Clock className="w-5 h-5 sm:w-6 sm:h-6 mr-2" />
                        {t('gallery.expires')} {format(parseISO(expiresAt), 'PP')}
                      </span>
                    )}
                  </div>
                )}

                {/* Logo at bottom position */}
                {heroLogoVisible && heroLogoPosition === 'bottom' && eventLogo && (
                  <div className="mt-6">
                    <img
                      src={buildResourceUrl(eventLogo)}
                      alt="Event logo"
                      className={`${getLogoSizeClasses(heroLogoSize)} mx-auto`}
                      style={{
                        filter: 'drop-shadow(0 4px 6px rgba(0, 0, 0, 0.5))'
                      }}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Scroll Indicator */}
            <button
              onClick={() => {
                const gridSection = document.getElementById('justified-gallery-grid');
                if (gridSection) {
                  gridSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                } else {
                  window.scrollBy({ top: window.innerHeight * 0.7, behavior: 'smooth' });
                }
              }}
              className="absolute bottom-8 left-1/2 transform -translate-x-1/2 animate-bounce cursor-pointer hover:scale-110 transition-transform focus:outline-none focus:ring-2 focus:ring-white focus:ring-opacity-50 rounded-full p-2"
              aria-label="Scroll to gallery"
            >
              <ChevronDown className="w-8 h-8 text-white drop-shadow-lg" />
            </button>
          </div>
        </div>
      )}

      {/* Justified Photo Grid */}
      <div
        id="justified-gallery-grid"
        ref={containerRef}
        className="photo-grid relative"
        style={{ height: layoutResult.containerHeight }}
      >
        {photos.map((photo, index) => {
          const layoutItem = layoutItemMap.get(photo.id);
          if (!layoutItem) return null;

          return (
            <JustifiedPhoto
              key={photo.id}
              photo={photo}
              layoutItem={layoutItem}
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
          );
        })}

        <FeedbackIdentityModal
          isOpen={showIdentityModal}
          onClose={() => {
            setShowIdentityModal(false);
            setPendingAction(null);
          }}
          onSubmit={async (name, email) => {
            setSavedIdentity({ name, email });
            setShowIdentityModal(false);
            if (pendingAction) {
              await feedbackService.submitFeedback(slug, String(pendingAction.photoId), {
                feedback_type: pendingAction.type,
                guest_name: name,
                guest_email: email,
              });
              // Toggle for consistency (#590).
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
    </>
  );
};
