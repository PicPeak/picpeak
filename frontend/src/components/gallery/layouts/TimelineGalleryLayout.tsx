import React, { useMemo, useState } from 'react';
import { Download, Maximize2, Check, Calendar, Heart, MessageSquare } from 'lucide-react';
import { format, parseISO, startOfDay, startOfWeek, startOfMonth } from 'date-fns';
import { useTheme } from '../../../contexts/ThemeContext';
import { AuthenticatedImage } from '../../common';
import type { BaseGalleryLayoutProps } from './BaseGalleryLayout';
import type { Photo } from '../../../types';
import { FeedbackIdentityModal } from '../../gallery/FeedbackIdentityModal';
import { feedbackService } from '../../../services/feedback.service';
import { useGuestIdentityOptional } from '../../../contexts/GuestIdentityContext';

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
  const [likedIds, setLikedIds] = useState<Set<number>>(new Set());
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<null | { type: 'like'; photoId: number }>(null);
  const [savedIdentity, setSavedIdentity] = useState<{ name: string; email: string } | null>(null);
  const guestIdentity = useGuestIdentityOptional();
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
                  <div
                    key={photo.id}
                    className="photo-card relative group cursor-pointer aspect-square"
                    onClick={() => onPhotoClick(actualIndex)}
                  >
                    <AuthenticatedImage
                      src={photo.thumbnail_url || photo.url}
                      alt={photo.filename}
                      className="w-full h-full object-cover rounded-lg"
                      loading="lazy"
                      isGallery={true}
                      protectFromDownload={!allowDownloads}
                    />
                    
                    {/* Time label */}
                    <div className="absolute bottom-2 left-2 px-2 py-1 bg-black/60 text-white text-xs rounded">
                      {format(parseISO(photo.uploaded_at), 'h:mm a')}
                    </div>
                    
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-200 rounded-lg flex items-center justify-center gap-2">
                      {!isSelectionMode && (
                        <>
                          <button
                            className="p-2 bg-white/90 rounded-full hover:bg-white transition-colors"
                            onClick={(e) => {
                              e.stopPropagation();
                              onPhotoClick(actualIndex);
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
                                onDownload(photo, e);
                              }}
                              aria-label="Download photo"
                            >
                              <Download className="w-5 h-5 text-neutral-800" />
                            </button>
                          )}
                          {feedbackEnabled && feedbackOptions?.allowLikes && (
                            <button
                              className={`p-2 rounded-full transition-colors ${likedIds.has(photo.id) ? 'bg-red-500/90 hover:bg-red-500' : 'bg-white/90 hover:bg-white'}`}
                              onClick={async (e) => {
                                e.stopPropagation();
                                if (guestIdentity?.identityMode === 'guest') {
                                  try {
                                    await guestIdentity.ensureIdentity();
                                  } catch {
                                    return;
                                  }
                                  setLikedIds(prev => new Set(prev).add(photo.id));
                                  try {
                                    await feedbackService.submitFeedback(slug!, String(photo.id), {
                                      feedback_type: 'like',
                                    });
                                  } catch (_) {}
                                  return;
                                }
                                if (feedbackOptions?.requireNameEmail && !savedIdentity) {
                                  setPendingAction({ type: 'like', photoId: photo.id });
                                  setShowIdentityModal(true);
                                  return;
                                }
                                setLikedIds(prev => new Set(prev).add(photo.id));
                                try {
                                  await feedbackService.submitFeedback(slug!, String(photo.id), {
                                    feedback_type: 'like',
                                    guest_name: savedIdentity?.name,
                                    guest_email: savedIdentity?.email,
                                  });
                                } catch (_) {}
                              }}
                              aria-label="Like photo"
                              aria-pressed={likedIds.has(photo.id)}
                              title="Like"
                            >
                              <Heart className={`w-5 h-5 ${likedIds.has(photo.id) ? 'text-white fill-white' : 'text-neutral-800'}`} />
                            </button>
                          )}
                          {canQuickComment && (
                            <button
                              className="p-2 bg-white/90 rounded-full hover:bg-white transition-colors"
                              onClick={(e) => { e.stopPropagation(); onOpenPhotoWithFeedback?.(actualIndex); }}
                              aria-label="Comment on photo"
                              title="Comment"
                            >
                              <MessageSquare className="w-5 h-5 text-neutral-800" />
                            </button>
                          )}
                        </>
                      )}
                    </div>

                    {((photo.like_count ?? 0) > 0 || likedIds.has(photo.id)) && (
                      <div className={`absolute ${photo.type === 'collage' ? 'bottom-8' : 'bottom-2'} left-2 z-10`}>
                        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-white/90 backdrop-blur-sm" title="Liked">
                          <Heart className="w-3.5 h-3.5 text-red-500" fill="currentColor" />
                        </span>
                      </div>
                    )}

                    {/* Selection Checkbox (visible on hover or when selected) */}
                    <button
                      type="button"
                      aria-label={`Select ${photo.filename}`}
                      role="checkbox"
                      aria-checked={selectedPhotos.has(photo.id)}
                      data-testid={`gallery-photo-checkbox-${photo.id}`}
                      className={`absolute top-2 right-2 z-20 transition-opacity ${
                        selectedPhotos.has(photo.id) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                      }`}
                      onClick={(e) => { e.stopPropagation(); onPhotoSelect && onPhotoSelect(photo.id); }}
                    >
                      <div className={`w-6 h-6 rounded-full border-2 ${selectedPhotos.has(photo.id) ? 'bg-accent-dark border-accent-dark' : 'bg-white/90 border-white'} flex items-center justify-center transition-colors`}>
                        {selectedPhotos.has(photo.id) && <Check className="w-4 h-4 text-white" />}
                      </div>
                    </button>
                  </div>
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
