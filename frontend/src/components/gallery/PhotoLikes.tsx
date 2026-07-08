import React, { useState } from 'react';
import { Heart } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { feedbackService } from '../../services/feedback.service';
import { toast } from 'react-toastify';
import { FeedbackIdentityModal } from './FeedbackIdentityModal';
import { useGuestIdentityOptional } from '../../contexts/GuestIdentityContext';
import { useFeedbackLimitModal } from '../../hooks/useFeedbackLimitModal';

interface PhotoLikesProps {
  photoId: string;
  gallerySlug: string;
  isLiked: boolean;
  likeCount: number;
  isEnabled: boolean;
  requireNameEmail?: boolean;
  onLikeChange?: (liked: boolean) => void;
}

export const PhotoLikes: React.FC<PhotoLikesProps> = ({
  photoId,
  gallerySlug,
  isLiked,
  likeCount,
  isEnabled,
  requireNameEmail = false,
  onLikeChange
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const guestIdentity = useGuestIdentityOptional();
  const { modal: limitModal, handleError: handleLimitError } = useFeedbackLimitModal();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [savedIdentity, setSavedIdentity] = useState<{ name: string; email: string } | null>(null);

  const submitLikeMutation = useMutation({
    mutationFn: (data: { guest_name?: string; guest_email?: string } = {}) => 
      feedbackService.submitFeedback(gallerySlug, photoId, {
        feedback_type: 'like',
        guest_name: data.guest_name || undefined,
        guest_email: data.guest_email || undefined
      }),
    onMutate: async () => {
      setIsSubmitting(true);
      setAnimating(true);
      // Optimistic update
      if (onLikeChange) {
        onLikeChange(!isLiked);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['photo-feedback', gallerySlug, photoId] });
      queryClient.invalidateQueries({ queryKey: ['gallery-photos'] });
    },
    onError: (error: any) => {
      // Revert optimistic update
      if (onLikeChange) {
        onLikeChange(isLiked);
      }
      // Per-guest cap reached (#655) — surface the modal instead of a toast.
      if (handleLimitError(error)) return;
      if (error.response?.status === 429) {
        toast.error(t('feedback.rateLimited', 'Please wait before liking again'));
      } else {
        toast.error(t('feedback.likeError', 'Failed to update like'));
      }
    },
    onSettled: () => {
      setIsSubmitting(false);
      setTimeout(() => setAnimating(false), 300);
    }
  });

  const handleLikeClick = async () => {
    if (!isEnabled || isSubmitting) return;

    // Guest identity mode: ensure we have a per-person guest token. The
    // server will read name/email from the token — body values are ignored.
    if (guestIdentity?.identityMode === 'guest') {
      try {
        await guestIdentity.ensureIdentity();
      } catch {
        // User cancelled the prompt — silently abort.
        return;
      }
      submitLikeMutation.mutate({});
      return;
    }

    // Simple mode (or no provider at all): legacy inline prompt flow.
    if (requireNameEmail && !savedIdentity) {
      setShowIdentityModal(true);
    } else {
      const identityPayload = savedIdentity
        ? { guest_name: savedIdentity.name, guest_email: savedIdentity.email }
        : {};
      submitLikeMutation.mutate(identityPayload);
    }
  };

  const handleIdentitySubmit = (name: string, email: string) => {
    setSavedIdentity({ name, email });
    setShowIdentityModal(false);
    submitLikeMutation.mutate({ guest_name: name, guest_email: email });
  };

  if (!isEnabled) return null;

  return (
    <>
      <button
      onClick={handleLikeClick}
      disabled={isSubmitting}
      className={`group flex items-center gap-2 px-3 py-2 rounded-lg transition-all ${
        // Filled solid-red state matches the lightbox toolbar (#538 bug
        // 2). The previous `bg-red-50 text-red-600` was almost invisible
        // — particularly on dark themes and coloured gallery backgrounds
        // — so the user couldn't tell the like had registered.
        isLiked
          ? 'bg-red-500/80 text-white hover:bg-red-500'
          : 'bg-surface text-muted-theme hover:bg-black/10'
      } ${isSubmitting ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
      aria-label={isLiked ? t('feedback.unlike', 'Unlike') : t('feedback.like', 'Like')}
    >
      <Heart
        className={`w-5 h-5 transition-all ${
          animating ? 'scale-125' : 'scale-100'
        } ${
          isLiked ? 'fill-current' : 'group-hover:scale-110'
        }`}
      />
      <span className="text-sm font-medium">
        {likeCount > 0 ? likeCount : ''}
      </span>
      </button>
      <FeedbackIdentityModal
        isOpen={showIdentityModal}
        onClose={() => setShowIdentityModal(false)}
        onSubmit={handleIdentitySubmit}
        feedbackType={t('feedback.like', 'like')}
      />
      {limitModal}
    </>
  );
};
