import React, { useState } from 'react';
import { Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { feedbackService } from '../../services/feedback.service';
import { toast } from 'react-toastify';
import { FeedbackIdentityModal } from './FeedbackIdentityModal';
import { useGuestIdentityOptional } from '../../contexts/GuestIdentityContext';

interface PhotoRatingProps {
  photoId: string;
  gallerySlug: string;
  currentRating?: number;
  averageRating?: number;
  totalRatings?: number;
  isEnabled: boolean;
  requireNameEmail?: boolean;
  onRatingChange?: (rating: number) => void;
}

export const PhotoRating: React.FC<PhotoRatingProps> = ({
  photoId,
  gallerySlug,
  currentRating = 0,
  averageRating = 0,
  totalRatings = 0,
  isEnabled,
  requireNameEmail = false,
  onRatingChange
}) => {
  // Ensure averageRating is a valid number
  const safeAverageRating = typeof averageRating === 'number' && !isNaN(averageRating) ? averageRating : 0;
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const guestIdentity = useGuestIdentityOptional();
  const [hoveredRating, setHoveredRating] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [pendingRating, setPendingRating] = useState(0);
  const [savedIdentity, setSavedIdentity] = useState<{ name: string; email: string } | null>(null);

  const submitRatingMutation = useMutation({
    mutationFn: (data: { rating: number; guest_name?: string; guest_email?: string }) => 
      feedbackService.submitFeedback(gallerySlug, photoId, {
        feedback_type: 'rating',
        rating: data.rating,
        guest_name: data.guest_name || undefined,
        guest_email: data.guest_email || undefined
      }),
    onMutate: async (data) => {
      setIsSubmitting(true);
      // Optimistic update
      if (onRatingChange) {
        onRatingChange(data.rating);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['photo-feedback', gallerySlug, photoId] });
      toast.success(t('feedback.ratingSubmitted', 'Rating submitted'));
    },
    onError: (error: any) => {
      // Revert optimistic update
      if (onRatingChange && currentRating) {
        onRatingChange(currentRating);
      }
      if (error.response?.status === 429) {
        toast.error(t('feedback.rateLimited', 'Please wait before rating again'));
      } else {
        toast.error(t('feedback.ratingError', 'Failed to submit rating'));
      }
    },
    onSettled: () => {
      setIsSubmitting(false);
    }
  });

  const handleRatingClick = async (rating: number) => {
    if (!isEnabled || isSubmitting) return;

    // If clicking the same rating, remove it
    const newRating = rating === currentRating ? 0 : rating;

    if (guestIdentity?.identityMode === 'guest') {
      try {
        await guestIdentity.ensureIdentity();
      } catch {
        return;
      }
      submitRatingMutation.mutate({ rating: newRating });
      return;
    }

    if (requireNameEmail && !savedIdentity) {
      setPendingRating(newRating);
      setShowIdentityModal(true);
    } else {
      submitRatingMutation.mutate({
        rating: newRating,
        guest_name: savedIdentity?.name,
        guest_email: savedIdentity?.email
      });
    }
  };

  const handleIdentitySubmit = (name: string, email: string) => {
    setSavedIdentity({ name, email });
    setShowIdentityModal(false);
    submitRatingMutation.mutate({ 
      rating: pendingRating,
      guest_name: name,
      guest_email: email
    });
  };

  if (!isEnabled) return null;

  return (
    <>
      <div className="flex flex-col items-center gap-2">
        {/* Star Rating Input */}
        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              onClick={() => handleRatingClick(star)}
              onMouseEnter={() => setHoveredRating(star)}
              onMouseLeave={() => setHoveredRating(0)}
              disabled={isSubmitting}
              className={`p-1 transition-all ${
                isSubmitting ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:scale-110'
              }`}
              aria-label={t('feedback.rateStar', 'Rate {{count}} stars', { count: star })}
            >
              <Star
                className={`w-6 h-6 transition-colors ${
                  star <= (hoveredRating || currentRating)
                    ? 'fill-yellow-500 text-yellow-500'
                    : 'text-black/30 hover:text-yellow-400'
                }`}
              />
            </button>
          ))}
        </div>

        {/* Average Rating Display */}
        {totalRatings > 0 && (
          <div className="text-sm text-muted-theme">
            <span className="font-medium">{safeAverageRating.toFixed(1)}</span>
            <span className="text-muted-theme ml-1">
              ({t('feedback.ratingsCount', '{{count}} ratings', { count: totalRatings })})
            </span>
          </div>
        )}
      </div>
      <FeedbackIdentityModal
        isOpen={showIdentityModal}
        onClose={() => setShowIdentityModal(false)}
        onSubmit={handleIdentitySubmit}
        feedbackType={t('feedback.rating', 'rating')}
      />
    </>
  );
};