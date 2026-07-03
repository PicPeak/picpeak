import React, { useState } from 'react';
import { X, ChevronLeft, ChevronRight, Download, Trash2, Tag, Calendar, HardDrive, Eye, MousePointer, MessageSquare, Star, Heart, CheckCircle, XCircle, AlertCircle } from 'lucide-react';
import { toast } from 'react-toastify';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { AdminPhoto } from '../../services/photos.service';
import { photosService } from '../../services/photos.service';
import { feedbackService, type PhotoFeedback, type FeedbackSummary } from '../../services/feedback.service';
import { Button } from '../common';
import { AdminAuthenticatedImage } from './AdminAuthenticatedImage';
import { AdminAuthenticatedVideo } from './AdminAuthenticatedVideo';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';

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
  const [showCategoryMenu, setShowCategoryMenu] = useState(false);
  const [expandedComments, setExpandedComments] = useState(false);
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
      setShowCategoryMenu(false);
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
  const moderateFeedbackMutation = useMutation({
    mutationFn: ({ feedbackId, action }: { feedbackId: string; action: 'approve' | 'hide' | 'reject' }) =>
      feedbackService.moderateFeedback(feedbackId, action),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-photo-feedback', eventId, currentPhoto?.id] });
      toast.success('Feedback moderated successfully');
    },
    onError: () => {
      toast.error('Failed to moderate feedback');
    }
  });

  const deleteFeedbackMutation = useMutation({
    mutationFn: (feedbackId: string) => feedbackService.deleteFeedback(feedbackId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-photo-feedback', eventId, currentPhoto?.id] });
      toast.success('Feedback deleted successfully');
    },
    onError: () => {
      toast.error('Failed to delete feedback');
    }
  });

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
                onClick={() => setShowCategoryMenu(!showCategoryMenu)}
                className="text-xs text-accent hover:text-accent-dark"
              >
                Change
              </button>
            </div>
            <p className="text-white">
              {currentPhoto.category_name || 'Uncategorized'}
            </p>
            
            {showCategoryMenu && (
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
                    onClick={() => setExpandedComments(!expandedComments)}
                    className="text-xs text-accent hover:text-accent-dark mb-2"
                  >
                    {expandedComments ? 'Hide' : 'Show'} Comments ({comments.length})
                  </button>
                  
                  {expandedComments && (
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
