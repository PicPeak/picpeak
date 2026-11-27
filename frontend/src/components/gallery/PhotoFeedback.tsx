import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { feedbackService } from '../../services/feedback.service';
import { FEEDBACK_SETTINGS_STALE_TIME, useGalleryFeedbackSettings } from '../../hooks/useGalleryFeedbackSettings';
import { PhotoReactions } from './PhotoReactions';
import { PhotoComments } from './PhotoComments';
import { Skeleton } from '../common';

interface PhotoFeedbackProps {
  photoId: string;
  gallerySlug: string;
  className?: string;
  // The lightbox bar has the rating, like and favourite buttons (issue
  // 1733); the panel holds reactions and comments.
  onFeedbackUpdate?: (toggledPhotoId?: number) => void;
  /**
   * The edit revision of the picture shown (issue 2619): comments are read
   * again when it changes, their drawings placed on the new picture.
   */
  editRevision?: number;
}

export const PhotoFeedback: React.FC<PhotoFeedbackProps> = ({
  photoId,
  gallerySlug,
  className = '',
  onFeedbackUpdate,
  editRevision = 0,
}) => {
  // Fetch feedback settings for the gallery
  const { data: settings, isLoading: settingsLoading } = useGalleryFeedbackSettings(gallerySlug, {
    staleTime: FEEDBACK_SETTINGS_STALE_TIME,
  });

  // Fetch feedback data for the photo
  const { data: feedbackData } = useQuery({
    queryKey: ['photo-feedback', gallerySlug, photoId, editRevision],
    queryFn: () => feedbackService.getPhotoFeedback(gallerySlug, photoId),
    enabled: !!settings?.feedback_enabled,
  });

  // Local state for optimistic updates
  const [myReaction, setMyReaction] = useState<string | null>(null);
  const [reactionCounts, setReactionCounts] = useState<Record<string, number>>({});

  // Update local state when data loads
  useEffect(() => {
    if (feedbackData) {
      setMyReaction(feedbackData.my_feedback.reaction || null);
      setReactionCounts(feedbackData.reactions || {});
    }
  }, [feedbackData]);

  // Optimistic reaction switch: decrement the old emoji, increment the new.
  const handleReactionChange = (reaction: string | null) => {
    setReactionCounts(prev => {
      const next = { ...prev };
      if (myReaction) next[myReaction] = Math.max(0, (next[myReaction] || 0) - 1);
      if (reaction) next[reaction] = (next[reaction] || 0) + 1;
      return next;
    });
    setMyReaction(reaction);
    if (onFeedbackUpdate) onFeedbackUpdate();
  };

  if (settingsLoading) {
    return (
      <div className={`space-y-3 ${className}`}>
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (!settings?.feedback_enabled) {
    return null;
  }

  const hasAnyFeedbackType = settings.allow_ratings || settings.allow_likes ||
                            settings.allow_comments || settings.allow_favorites ||
                            settings.allow_reactions;

  if (!hasAnyFeedbackType) {
    return null;
  }

  return (
    <div className={`space-y-4 ${className}`}>
      {/* Emoji reactions (#839) */}
      {settings.allow_reactions && (
        <PhotoReactions
          photoId={photoId}
          gallerySlug={gallerySlug}
          myReaction={myReaction}
          reactionCounts={reactionCounts}
          isEnabled={true}
          requireNameEmail={settings.require_name_email || false}
          onReactionChange={handleReactionChange}
        />
      )}

      {/* Comments Section */}
      {settings.allow_comments && (
        <div className="border-t border-border-token pt-4">
          <PhotoComments
            photoId={photoId}
            gallerySlug={gallerySlug}
            comments={feedbackData?.feedback?.filter(f => f.feedback_type === 'comment') || []}
            isEnabled={true}
            requireNameEmail={settings.require_name_email || false}
            showToGuests={settings.show_feedback_to_guests || false}
            allowAnnotations={!!settings.allow_annotations}
            commentsLoaded={!!feedbackData}
            onCommentAdded={() => {
              if (onFeedbackUpdate) onFeedbackUpdate();
            }}
          />
        </div>
      )}
    </div>
  );
};
