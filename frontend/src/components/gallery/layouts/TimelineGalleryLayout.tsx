import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, Heart } from 'lucide-react';
import { format, parseISO, startOfDay, startOfWeek, startOfMonth } from 'date-fns';
import { useTheme } from '../../../contexts/ThemeContext';
import { PhotoCard } from '../PhotoCard';
import type { BaseGalleryLayoutProps } from './BaseGalleryLayout';
import type { Photo } from '../../../types';
import { FeedbackIdentityModal } from '../../gallery/FeedbackIdentityModal';
import { feedbackService } from '../../../services/feedback.service';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';

export const TimelineGalleryLayout: React.FC<BaseGalleryLayoutProps> = ({
  photos,
  slug,
  onPhotoClick,
  onOpenPhotoWithFeedback,
  onDownload,
  selectedPhotos = new Set(),
  isSelectionMode = false,
  onPhotoSelect,
  allowDownloads = true,
  feedbackEnabled = false,
  feedbackOptions
}) => {
  const { theme } = useTheme();
  const { formatTime: fmtTime } = useLocalizedDate();
  const [likedIds, setLikedIds] = useState<Set<number>>(new Set());
  // Seed from server is_liked on first non-empty payload (#590 follow-up).
  // Mount-only so refetches don't clobber in-session optimistic toggles.
  const likedSeededRef = useRef(false);
  useEffect(() => {
    if (likedSeededRef.current || photos.length === 0) return;
    setLikedIds(new Set(photos.filter(p => p.is_liked).map(p => p.id)));
    likedSeededRef.current = true;
  }, [photos]);
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<null | { type: 'like'; photoId: number }>(null);
  const [savedIdentity, setSavedIdentity] = useState<{ name: string; email: string } | null>(null);
  const gallerySettings = theme.gallerySettings || {};
  const grouping = gallerySettings.timelineGrouping || 'day';
  const showDates = gallerySettings.timelineShowDates !== false;
  const canQuickComment = Boolean(feedbackEnabled && feedbackOptions?.allowComments && onOpenPhotoWithFeedback);

  // Group photos by date
  const groupedPhotos = useMemo(() => {
    const groups = new Map<string, Photo[]>();
    
    photos.forEach(photo => {
      const date = parseISO(photo.uploaded_at);
      let groupKey: string;
      
      switch (grouping) {
        case 'week':
          const weekStart = startOfWeek(date);
          groupKey = format(weekStart, 'yyyy-MM-dd');
          // groupLabel = `Week of ${format(weekStart, 'MMM d, yyyy')}`;
          break;
        case 'month':
          const monthStart = startOfMonth(date);
          groupKey = format(monthStart, 'yyyy-MM');
          // groupLabel = format(monthStart, 'MMMM yyyy');
          break;
        default: // day
          const dayStart = startOfDay(date);
          groupKey = format(dayStart, 'yyyy-MM-dd');
          // groupLabel = format(dayStart, 'EEEE, MMMM d, yyyy');
      }
      
      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey)!.push(photo);
    });
    
    // Convert to array and sort by date
    return Array.from(groups.entries())
      .map(([date, photos]) => ({
        date,
        label: photos[0] ? format(parseISO(photos[0].uploaded_at), grouping === 'month' ? 'MMMM yyyy' : grouping === 'week' ? "'Week of' MMM d, yyyy" : 'EEEE, MMMM d, yyyy') : date,
        photos: photos.sort((a, b) => new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime())
      }))
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [photos, grouping]);

  return (
    <div className="relative">
      {/* Timeline line */}
      <div className="absolute left-8 top-0 bottom-0 w-0.5 bg-black/20 hidden lg:block" />
      
      {/* Timeline groups */}
      <div className="space-y-12">
        {groupedPhotos.map((group) => (
          <div key={group.date} className="relative">
            {/* Date marker */}
            {showDates && (
              <div className="flex items-center gap-4 mb-6">
                <div className="hidden lg:flex items-center justify-center w-16 h-16 bg-white border-4 border-accent-dark rounded-full z-10">
                  <Calendar className="w-6 h-6 text-accent" />
                </div>
                <h3 className="text-xl font-semibold text-theme">
                  {group.label}
                </h3>
              </div>
            )}
            
            {/* Photos grid for this date */}
            <div className="photo-grid lg:ml-24 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {group.photos.map((photo) => {
                const actualIndex = photos.findIndex(p => p.id === photo.id);
                return (
                  <PhotoCard
                    key={photo.id}
                    photo={photo}
                    isSelected={selectedPhotos.has(photo.id)}
                    isSelectionMode={isSelectionMode}
                    onClick={() => onPhotoClick(actualIndex)}
                    onDownload={(e) => onDownload(photo, e)}
                    onToggleSelect={() => onPhotoSelect && onPhotoSelect(photo.id)}
                    className="photo-card relative group cursor-pointer aspect-square"
                    imageProps={{
                      src: photo.thumbnail_url || photo.url,
                      alt: photo.filename,
                      className: 'w-full h-full object-cover rounded-lg',
                      loading: 'lazy',
                      isGallery: true,
                      protectFromDownload: !allowDownloads,
                    }}
                    overlayBaseClassName="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-200 rounded-lg flex items-center justify-center gap-2"
                    allowDownloads={allowDownloads}
                    feedbackEnabled={feedbackEnabled}
                    feedbackOptions={feedbackOptions}
                    slug={slug}
                    onQuickComment={canQuickComment ? () => onOpenPhotoWithFeedback?.(actualIndex) : undefined}
                    liked={likedIds.has(photo.id)}
                    onLikeSuccess={() => {
                      // Toggle — server /feedback like is a toggle (#590).
                      setLikedIds(prev => {
                        const next = new Set(prev);
                        if (next.has(photo.id)) next.delete(photo.id);
                        else next.add(photo.id);
                        return next;
                      });
                    }}
                    savedIdentity={savedIdentity}
                    onRequireIdentity={(action, photoId) => {
                      setPendingAction({ type: action, photoId });
                      setShowIdentityModal(true);
                    }}
                    likeBeforeComment
                    checkboxTestId
                    beforeOverlay={
                      <div className="absolute bottom-2 left-2 px-2 py-1 bg-black/60 text-white text-xs rounded">
                        {fmtTime(photo.uploaded_at)}
                      </div>
                    }
                    afterOverlay={((photo.like_count ?? 0) > 0 || likedIds.has(photo.id)) ? (
                      <div className={`absolute ${photo.type === 'collage' ? 'bottom-8' : 'bottom-2'} left-2 z-10`}>
                        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-white/90 backdrop-blur-sm" title="Liked">
                          <Heart className="w-3.5 h-3.5 text-red-500" fill="currentColor" />
                        </span>
                      </div>
                    ) : undefined}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
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
    </div>
  );
};
