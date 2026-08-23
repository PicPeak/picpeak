import React, { useState } from 'react';
import { X, ChevronLeft, ChevronRight, Download, Trash2, Tag, Calendar, HardDrive, Eye, MousePointer, MessageSquare, Star, Heart, CheckCircle, XCircle, AlertCircle } from 'lucide-react';
import { toast } from 'react-toastify';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { AdminPhoto } from '../../services/photos.service';
import { photosService } from '../../services/photos.service';
import { feedbackService, type PhotoFeedback, type FeedbackSummary } from '../../services/feedback.service';
import { Button } from '../common';
import { AdminAuthenticatedImage } from './AdminAuthenticatedImage';
import { AdminAuthenticatedVideo } from './AdminAuthenticatedVideo';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { COLOR_LABELS, COLOR_LABEL_SWATCHES, type ColorLabel, type KeybindMode } from '../../services/feedback.service';
import { resolveFeedbackKey, colorShortcutHints } from '../../utils/feedbackKeybinds';
import { useTranslation } from 'react-i18next';
import { useMutationWithToast, useModal } from '../../hooks';

type AdminFeedbackResponse = {
  feedback: PhotoFeedback[];
  summary?: FeedbackSummary;
};

interface AdminPhotoViewerProps {
  photos: AdminPhoto[];
  initialIndex: number;
  eventId: number;
  onClose: () => void;
  onPhotoDeleted: () => void;
  categories: Array<{ id: number; name: string; slug: string }>;
}

export const AdminPhotoViewer: React.FC<AdminPhotoViewerProps> = ({
  photos,
  initialIndex,
  eventId,
  onClose,
  onPhotoDeleted,
  categories
}) => {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [isDeleting, setIsDeleting] = useState(false);
  const { t } = useTranslation();
  // The photographer's own triage mark (#1044 follow-up). Held locally and
  // seeded from the row so the star/colour UI responds instantly; the grid
  // picks it up when its query is invalidated.
  const [myMarks, setMyMarks] = useState<Record<number, { rating: number | null; color_label: ColorLabel | null }>>({});
  const categoryMenuModal = useModal();
  const commentsModal = useModal();
  const queryClient = useQueryClient();
  const { formatDateTime: fmtDateTime } = useLocalizedDate();
  
  const currentPhoto = photos[currentIndex];
  const isVideo = currentPhoto
    ? (currentPhoto.media_type === 'video' ||
      (currentPhoto.mime_type && String(currentPhoto.mime_type).startsWith('video/')) ||
      currentPhoto.type === 'video')
    : false;
  const averageRating = currentPhoto?.average_rating ?? 0;
  const likeCount = currentPhoto?.like_count ?? 0;
  const favoriteCount = currentPhoto?.favorite_count ?? 0;

  if (!currentPhoto) {
    return null;
  }

  // Fetch feedback for current photo
  const { data: feedbackData } = useQuery<AdminFeedbackResponse>({
    queryKey: ['admin-photo-feedback', eventId, currentPhoto?.id],
    queryFn: () => feedbackService.getEventFeedback(eventId.toString(), {
      photoId: currentPhoto?.id.toString(),
      status: 'all' // Get all comments including unapproved
    }),
    enabled: !!currentPhoto
  });

  const comments = (feedbackData?.feedback ?? []).filter((item): item is PhotoFeedback => item.feedback_type === 'comment');

  const goToPrevious = () => {
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : photos.length - 1));
  };

  const goToNext = () => {
    setCurrentIndex((prev) => (prev < photos.length - 1 ? prev + 1 : 0));
  };

  const handleDelete = async () => {
    if (!confirm(`Are you sure you want to delete "${currentPhoto.filename}"?`)) {
      return;
    }

    setIsDeleting(true);
    try {
      await photosService.deletePhoto(eventId, currentPhoto.id);
      toast.success('Photo deleted successfully');
      
      // Close viewer if this was the last photo
      if (photos.length === 1) {
        onClose();
      } else {
        // Move to next photo if available, otherwise previous
        if (currentIndex === photos.length - 1) {
          setCurrentIndex(currentIndex - 1);
        }
      }
      
      onPhotoDeleted();
    } catch (error) {
      toast.error('Failed to delete photo');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDownload = async () => {
    try {
      await photosService.downloadPhoto(eventId, currentPhoto.id, currentPhoto.filename);
      toast.success('Download started');
    } catch (error) {
      toast.error('Failed to download photo');
    }
  };

  const handleCategoryChange = async (categoryId: number | null) => {
    try {
      await photosService.updatePhotoCategory(eventId, currentPhoto.id, categoryId);
      toast.success('Category updated');
      categoryMenuModal.close();
      // Invalidate photos query to refresh data
      await queryClient.invalidateQueries({ queryKey: ['admin-event-photos', eventId.toString()] });
      await queryClient.invalidateQueries({ queryKey: ['admin-event-photos', eventId] });
      // Also trigger the parent's refresh callback
      onPhotoDeleted();
    } catch (error) {
      toast.error('Failed to update category');
    }
  };

  // Mutations for feedback moderation
  const moderateFeedbackMutation = useMutationWithToast({
    mutationFn: ({ feedbackId, action }: { feedbackId: string; action: 'approve' | 'hide' | 'reject' }) =>
      feedbackService.moderateFeedback(feedbackId, action),
    invalidateKeys: [['admin-photo-feedback', eventId, currentPhoto?.id]],
    successMessage: 'Feedback moderated successfully',
    errorMessage: () => 'Failed to moderate feedback'
  });

  const deleteFeedbackMutation = useMutationWithToast({
    mutationFn: (feedbackId: string) => feedbackService.deleteFeedback(feedbackId),
    invalidateKeys: [['admin-photo-feedback', eventId, currentPhoto?.id]],
    successMessage: 'Feedback deleted successfully',
    errorMessage: () => 'Failed to delete feedback'
  });

  // The mark shown for a photo: the local edit if there is one, otherwise
  // whatever the list query loaded.
  const markFor = (photo: AdminPhoto) => myMarks[photo.id] ?? {
    rating: photo.my_rating ?? null,
    color_label: (photo.my_color_label as ColorLabel) ?? null,
  };
  const currentMark = markFor(currentPhoto);

  const saveMark = async (patch: { rating?: number | null; color_label?: ColorLabel | null }) => {
    const photoId = currentPhoto.id;
    const previous = markFor(currentPhoto);
    const optimistic = {
      rating: patch.rating === undefined ? previous.rating : patch.rating,
      color_label: patch.color_label === undefined ? previous.color_label : patch.color_label,
    };
    setMyMarks((prev) => ({ ...prev, [photoId]: optimistic }));
    try {
      await photosService.setPhotoMark(eventId, photoId, patch);
      // The grid reads my_rating / my_color_label off the photo rows.
      queryClient.invalidateQueries({ queryKey: ['admin-event-photos', String(eventId)] });
    } catch {
      setMyMarks((prev) => ({ ...prev, [photoId]: previous }));
      toast.error(t('admin.photos.markError', 'Failed to save your mark'));
    }
  };

  // Pressing the same value again clears it, matching the gallery lightbox.
  //
  // 0 is the clear sentinel — Lightroom's own binding, and what
  // resolveFeedbackKey returns for the '0' key. It must become `null` here:
  // the mark service stores 1-5 only and rejects a literal 0, so passing it
  // straight through turned "clear my rating" into an error toast.
  const toggleMarkRating = (value: number) =>
    saveMark({ rating: value === 0 || currentMark.rating === value ? null : value });
  const toggleMarkColor = (color: ColorLabel) =>
    saveMark({ color_label: currentMark.color_label === color ? null : color });

  // The admin viewer always uses the Lightroom bindings — 1-5 stars, 6-9
  // colours — regardless of the scheme chosen for the gallery. That scheme is
  // a choice made FOR the client; this surface belongs to the photographer,
  // who came from Lightroom and needs both halves on the keyboard. Resolved
  // through the shared helper so the two viewers can't drift.
  const keybindMode: KeybindMode = 'lightroom';
  const markRef = React.useRef({ currentMark, toggleMarkRating, toggleMarkColor, saveMark });
  markRef.current = { currentMark, toggleMarkRating, toggleMarkColor, saveMark };

  React.useEffect(() => {
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
        default: {
          // Proofing shortcuts for the photographer's own marks (#1044
          // follow-up). Read through a ref: this effect is keyed on
          // currentIndex, so the closure would otherwise mark the photo that
          // was open when it was registered.
          const action = resolveFeedbackKey(e, {
            mode: keybindMode,
            allowColorLabels: true,
            allowRatings: true,
          });
          if (!action) break;
          e.preventDefault();
          if (action.type === 'color') void markRef.current.toggleMarkColor(action.color);
          else if (action.type === 'rating') void markRef.current.toggleMarkRating(action.value);
          else void markRef.current.saveMark({ color_label: null });
          break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentIndex]);

  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center">
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-white/80 hover:text-white p-2 rounded-lg hover:bg-white/10 transition-colors"
      >
        <X className="w-6 h-6" />
      </button>

      {/* Navigation */}
      <button
        onClick={goToPrevious}
        className="absolute left-4 top-1/2 -translate-y-1/2 text-white/80 hover:text-white p-2 rounded-lg hover:bg-white/10 transition-colors"
      >
        <ChevronLeft className="w-8 h-8" />
      </button>

      <button
        onClick={goToNext}
        className="absolute right-4 top-1/2 -translate-y-1/2 text-white/80 hover:text-white p-2 rounded-lg hover:bg-white/10 transition-colors"
      >
        <ChevronRight className="w-8 h-8" />
      </button>

      {/* Main content */}
      <div className="flex flex-col lg:flex-row gap-6 max-w-7xl mx-auto p-4 w-full h-full">
        {/* Image */}
        <div className="flex-1 flex items-center justify-center min-h-0">
          {isVideo ? (
            <AdminAuthenticatedVideo
              src={currentPhoto.url}
              className="max-w-full max-h-full bg-black"
              poster={currentPhoto.thumbnail_url || undefined}
              fallback={
                <div className="flex items-center justify-center text-neutral-400">
                  <div className="text-center">
                    <Eye className="w-12 h-12 mx-auto mb-2" />
                    <p className="text-sm">Failed to load media</p>
                  </div>
                </div>
              }
            />
          ) : (
            <AdminAuthenticatedImage
              src={currentPhoto.url}
              alt={currentPhoto.filename}
              className="max-w-full max-h-full object-contain"
              fallback={
                <div className="flex items-center justify-center text-neutral-400">
                  <div className="text-center">
                    <Eye className="w-12 h-12 mx-auto mb-2" />
                    <p className="text-sm">Failed to load image</p>
                  </div>
                </div>
              }
            />
          )}
        </div>

        {/* Sidebar */}
        <div className="lg:w-80 bg-neutral-900 rounded-lg p-6 overflow-y-auto">
          <h3 className="text-white font-medium text-lg">{currentPhoto.filename}</h3>
          {currentPhoto.original_filename && currentPhoto.original_filename !== currentPhoto.filename && (
            <p className="text-neutral-400 text-sm">Original: {currentPhoto.original_filename}</p>
          )}
          <div className="mb-4" />

          {/* Actions */}
          <div className="flex gap-2 mb-6">
            <Button
              variant="primary"
              size="sm"
              onClick={handleDownload}
              leftIcon={<Download className="w-4 h-4" />}
              className="flex-1"
            >
              Download
            </Button>
            <button
              onClick={handleDelete}
              disabled={isDeleting}
              className="flex-1 px-3 py-1.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:bg-red-400 rounded-lg flex items-center justify-center gap-2"
            >
              <Trash2 className="w-4 h-4" />
              Delete
            </button>
          </div>

          {/* Category */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-neutral-400 text-sm flex items-center gap-1">
                <Tag className="w-4 h-4" />
                Category
              </span>
              <button
                onClick={categoryMenuModal.toggle}
                className="text-xs text-accent hover:text-accent-dark"
              >
                Change
              </button>
            </div>
            <p className="text-white">
              {currentPhoto.category_name || 'Uncategorized'}
            </p>
            
            {categoryMenuModal.isOpen && (
              <div className="mt-2 bg-neutral-800 rounded-lg p-2">
                <button
                  onClick={() => handleCategoryChange(null)}
                  className="w-full text-left px-3 py-2 text-sm text-white hover:bg-neutral-700 rounded"
                >
                  Uncategorized
                </button>
                {categories.map(cat => (
                  <button
                    key={cat.id}
                    onClick={() => handleCategoryChange(cat.id)}
                    className="w-full text-left px-3 py-2 text-sm text-white hover:bg-neutral-700 rounded"
                  >
                    {cat.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Metadata */}
          <div className="space-y-4 text-sm">
            <div>
              <span className="text-neutral-400 flex items-center gap-1 mb-1">
                <HardDrive className="w-4 h-4" />
                File Size
              </span>
              <p className="text-white">{photosService.formatBytes(currentPhoto.size)}</p>
            </div>

            <div>
              <span className="text-neutral-400 flex items-center gap-1 mb-1">
                <Calendar className="w-4 h-4" />
                Uploaded
              </span>
              <p className="text-white">
                {fmtDateTime(currentPhoto.uploaded_at)}
              </p>
            </div>

            {currentPhoto.view_count !== undefined && (
              <div>
                <span className="text-neutral-400 flex items-center gap-1 mb-1">
                  <Eye className="w-4 h-4" />
                  Views
                </span>
                <p className="text-white">{currentPhoto.view_count}</p>
              </div>
            )}

            {currentPhoto.download_count !== undefined && (
              <div>
                <span className="text-neutral-400 flex items-center gap-1 mb-1">
                  <MousePointer className="w-4 h-4" />
                  Downloads
                </span>
                <p className="text-white">{currentPhoto.download_count}</p>
              </div>
            )}
          </div>

          {/* The photographer's own marks (#1044 follow-up). Above the guest
              feedback block on purpose: this is the surface being used during
              a triage pass, and it is explicitly labelled as private so
              nobody mistakes it for what the client chose. */}
          <div className="mt-6 pt-6 border-t border-neutral-700">
            <h4 className="text-white font-medium mb-1 flex items-center gap-2">
              <Star className="w-4 h-4" />
              {t('admin.photos.myMarks', 'Your marks')}
            </h4>
            <p className="text-xs text-neutral-400 mb-3">
              {t('admin.photos.myMarksHelp', 'Only you see these. They never appear in the client gallery, and they export to Lightroom as XMP.')}
            </p>

            <div className="flex items-center gap-1 mb-3" aria-label={t('admin.photos.myRating', 'Your rating')}>
              {[1, 2, 3, 4, 5].map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => toggleMarkRating(value)}
                  className="p-0.5"
                  aria-pressed={currentMark.rating === value}
                  aria-label={currentMark.rating === value
                    ? t('admin.photos.clearRating', 'Clear your rating')
                    : t('admin.photos.rateStars', 'Rate {{count}} stars', { count: value })}
                  title={`${value}`}
                >
                  <Star
                    className={`w-5 h-5 ${(currentMark.rating || 0) >= value ? 'text-yellow-400' : 'text-neutral-600'}`}
                    fill={(currentMark.rating || 0) >= value ? 'currentColor' : 'none'}
                  />
                </button>
              ))}
              <span className="ml-2 text-xs text-neutral-500">1–5</span>
            </div>

            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('feedback.colorLabelsTitle', 'Color labels')}>
              {COLOR_LABELS.map((color) => {
                const swatch = COLOR_LABEL_SWATCHES[color];
                const isMine = currentMark.color_label === color;
                const shortcut = colorShortcutHints(keybindMode)[color];
                const name = t(`feedback.colorLabels.${color}`, color);
                return (
                  <button
                    key={color}
                    type="button"
                    onClick={() => toggleMarkColor(color)}
                    aria-pressed={isMine}
                    // Colour alone can't carry which swatch this is.
                    aria-label={isMine
                      ? t('feedback.removeColorLabel', 'Remove {{color}} label', { color: name })
                      : t('feedback.setColorLabel', 'Mark as {{color}}', { color: name })}
                    title={shortcut ? `${name} (${shortcut})` : name}
                    className={`flex items-center gap-1 pl-1.5 pr-2 py-1 rounded-full text-xs transition-all ${
                      isMine ? 'bg-white/15 ring-1 ring-white/60' : 'bg-white/5 hover:bg-white/10'
                    }`}
                  >
                    <span
                      className="w-3.5 h-3.5 rounded-full border shrink-0"
                      style={{ backgroundColor: swatch.fill, borderColor: swatch.ring }}
                      aria-hidden="true"
                    />
                    {shortcut && <span className="text-neutral-400">{shortcut}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Feedback Section */}
          {feedbackData && (
            <div className="mt-6 pt-6 border-t border-neutral-700">
              <h4 className="text-white font-medium mb-4 flex items-center gap-2">
                <MessageSquare className="w-4 h-4" />
                Feedback & Comments
              </h4>
              
              {/* Feedback Stats */}
              <div className="grid grid-cols-2 gap-3 mb-4">
                {averageRating > 0 && (
                  <div className="bg-neutral-800 rounded-lg p-3">
                    <div className="flex items-center gap-1 text-yellow-400 mb-1">
                      <Star className="w-4 h-4" fill="currentColor" />
                      <span className="text-white font-medium">{Number(averageRating).toFixed(1)}</span>
                    </div>
                    <p className="text-xs text-neutral-400">Avg Rating</p>
                  </div>
                )}
                
                {likeCount > 0 && (
                  <div className="bg-neutral-800 rounded-lg p-3">
                    <div className="flex items-center gap-1 text-red-400 mb-1">
                      <Heart className="w-4 h-4" fill="currentColor" />
                      <span className="text-white font-medium">{likeCount}</span>
                    </div>
                    <p className="text-xs text-neutral-400">Likes</p>
                  </div>
                )}
                
                {favoriteCount > 0 && (
                  <div className="bg-neutral-800 rounded-lg p-3">
                    <div className="flex items-center gap-1 text-blue-400 mb-1">
                      <Star className="w-4 h-4" />
                      <span className="text-white font-medium">{favoriteCount}</span>
                    </div>
                    <p className="text-xs text-neutral-400">Favorites</p>
                  </div>
                )}
                
                {comments.length > 0 && (
                  <div className="bg-neutral-800 rounded-lg p-3">
                    <div className="flex items-center gap-1 text-green-400 mb-1">
                      <MessageSquare className="w-4 h-4" />
                      <span className="text-white font-medium">{comments.length}</span>
                    </div>
                    <p className="text-xs text-neutral-400">Comments</p>
                  </div>
                )}
              </div>
              
              {/* Comments List */}
              {comments.length > 0 && (
                <div className="space-y-2">
                  <button
                    onClick={commentsModal.toggle}
                    className="text-xs text-accent hover:text-accent-dark mb-2"
                  >
                    {commentsModal.isOpen ? 'Hide' : 'Show'} Comments ({comments.length})
                  </button>

                  {commentsModal.isOpen && (
                    <div className="space-y-3 max-h-64 overflow-y-auto">
                      {comments.map((comment) => (
                          <div key={comment.id} className="bg-neutral-800 rounded-lg p-3">
                            <div className="flex items-start justify-between mb-2">
                              <div className="flex-1">
                                <p className="text-sm font-medium text-white">
                                  {comment.guest_name || 'Anonymous'}
                                </p>
                                <p className="text-xs text-neutral-400">
                                  {fmtDateTime(comment.created_at)}
                                </p>
                              </div>
                              
                              {/* Comment Status Badge */}
                              <div className="flex items-center gap-1">
                                {!comment.is_approved && !comment.is_hidden && (
                                  <span className="text-xs bg-yellow-500/20 text-yellow-400 px-2 py-1 rounded flex items-center gap-1">
                                    <AlertCircle className="w-3 h-3" />
                                    Pending
                                  </span>
                                )}
                                {comment.is_approved && !comment.is_hidden && (
                                  <span className="text-xs bg-green-500/20 text-green-400 px-2 py-1 rounded flex items-center gap-1">
                                    <CheckCircle className="w-3 h-3" />
                                    Approved
                                  </span>
                                )}
                                {comment.is_hidden && (
                                  <span className="text-xs bg-red-500/20 text-red-400 px-2 py-1 rounded flex items-center gap-1">
                                    <XCircle className="w-3 h-3" />
                                    Hidden
                                  </span>
                                )}
                              </div>
                            </div>
                            
                            <p className="text-sm text-neutral-300 mb-3">
                              {comment.comment_text}
                            </p>
                            
                            {/* Moderation Actions */}
                            <div className="flex gap-2">
                              {!comment.is_approved && (
                                <button
                                  onClick={() => moderateFeedbackMutation.mutate({ 
                                    feedbackId: comment.id.toString(), 
                                    action: 'approve' 
                                  })}
                                  disabled={moderateFeedbackMutation.isPending}
                                  className="text-xs px-2 py-1 bg-green-600 hover:bg-green-700 text-white rounded"
                                >
                                  Approve
                                </button>
                              )}
                              
                              {!comment.is_hidden && (
                                <button
                                  onClick={() => moderateFeedbackMutation.mutate({ 
                                    feedbackId: comment.id.toString(), 
                                    action: 'hide' 
                                  })}
                                  disabled={moderateFeedbackMutation.isPending}
                                  className="text-xs px-2 py-1 bg-yellow-600 hover:bg-yellow-700 text-white rounded"
                                >
                                  Hide
                                </button>
                              )}
                              
                              {comment.is_hidden && (
                                <button
                                  onClick={() => moderateFeedbackMutation.mutate({ 
                                    feedbackId: comment.id.toString(), 
                                    action: 'approve' 
                                  })}
                                  disabled={moderateFeedbackMutation.isPending}
                                  className="text-xs px-2 py-1 bg-green-600 hover:bg-green-700 text-white rounded"
                                >
                                  Unhide
                                </button>
                              )}
                              
                              <button
                                onClick={() => {
                                  if (confirm('Are you sure you want to delete this comment?')) {
                                    deleteFeedbackMutation.mutate(comment.id.toString());
                                  }
                                }}
                                disabled={deleteFeedbackMutation.isPending}
                                className="text-xs px-2 py-1 bg-red-600 hover:bg-red-700 text-white rounded"
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}
              
              {/* No feedback message */}
              {comments.length === 0 && (
                <p className="text-neutral-400 text-sm">No feedback for this photo yet.</p>
              )}
            </div>
          )}

          {/* Navigation info */}
          <div className="mt-6 pt-6 border-t border-neutral-700">
            <p className="text-neutral-400 text-sm text-center">
              {currentIndex + 1} of {photos.length}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
