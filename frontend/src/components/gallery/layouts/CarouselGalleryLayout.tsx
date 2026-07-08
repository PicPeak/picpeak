import React, { useState, useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, Download, Maximize2, Play, Pause, Heart, MessageSquare } from 'lucide-react';
import { useTheme } from '../../../contexts/ThemeContext';
import { AuthenticatedImage, Button } from '../../common';
import type { BaseGalleryLayoutProps } from './BaseGalleryLayout';
import { FeedbackIdentityModal } from '../../gallery/FeedbackIdentityModal';
import { feedbackService } from '../../../services/feedback.service';
import { useGuestIdentityOptional } from '../../../contexts/GuestIdentityContext';

export const CarouselGalleryLayout: React.FC<BaseGalleryLayoutProps> = ({
  photos,
  slug,
  onPhotoClick,
  onOpenPhotoWithFeedback,
  onDownload,
  allowDownloads = true,
  feedbackEnabled = false,
  feedbackOptions
}) => {
  const { theme } = useTheme();
  const [currentIndex, setCurrentIndex] = useState(0);
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
  }, [isPlaying, photos.length, interval]);

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

  if (photos.length === 0) return null;

  const currentPhoto = photos[currentIndex];
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<null | { type: 'like'; photoId: number }>(null);
  const [savedIdentity, setSavedIdentity] = useState<{ name: string; email: string } | null>(null);
  const guestIdentity = useGuestIdentityOptional();
  const [likedIds, setLikedIds] = useState<Set<number>>(new Set());
  // Seed from server is_liked on first non-empty payload (#590 follow-up).
  // Mount-only so refetches don't clobber in-session optimistic toggles.
  const likedSeededRef = useRef(false);
  useEffect(() => {
    if (likedSeededRef.current || photos.length === 0) return;
    setLikedIds(new Set(photos.filter(p => p.is_liked).map(p => p.id)));
    likedSeededRef.current = true;
  }, [photos]);
  const canQuickComment = Boolean(feedbackEnabled && feedbackOptions?.allowComments && onOpenPhotoWithFeedback);

  return (
    <div className="photo-grid relative">
      {/* Main Carousel */}
      <div className="photo-card relative h-[50vh] sm:h-[60vh] lg:h-[70vh] bg-black rounded-lg overflow-hidden">
        <AuthenticatedImage
          src={currentPhoto.url}
          alt={currentPhoto.filename}
          className="w-full h-full object-contain"
          isGallery={true}
          protectFromDownload={!allowDownloads}
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
            <span className="px-3 py-1 bg-black/50 text-white rounded-full text-sm">
              {currentIndex + 1} / {photos.length}
            </span>
            {currentPhoto.category_name && (
              <span className="px-3 py-1 bg-black/50 text-white rounded-full text-sm">
                {currentPhoto.category_name}
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
              title="View fullscreen"
            >
              <Maximize2 className="w-5 h-5" />
            </Button>
            
            {allowDownloads && (
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => onDownload(currentPhoto, e)}
                className="text-white hover:bg-white/20"
                title="Download photo"
              >
                <Download className="w-5 h-5" />
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
                    } catch (_) {}
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
                  } catch (_) {}
                }}
                className={`bg-black/30 hover:bg-black/50 rounded-full border border-white/40 ${likedIds.has(currentPhoto.id) ? 'text-red-400' : 'text-white'}`}
                title="Like photo"
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
                title="Comment"
                aria-label="Comment on photo"
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
                    ? 'ring-2 ring-primary-600 scale-110' 
                    : 'opacity-70 hover:opacity-100'
                }`}
              >
                <AuthenticatedImage
                  src={photo.thumbnail_url || photo.url}
                  alt={photo.filename}
                  className="w-full h-full object-cover"
                  loading="lazy"
                  isGallery={true}
                  protectFromDownload={!allowDownloads}
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
