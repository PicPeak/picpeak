import React, { useState } from 'react';
import { Bookmark } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { feedbackService } from '../../services/feedback.service';
import { toast } from 'react-toastify';
import { FeedbackIdentityModal } from './FeedbackIdentityModal';
import { useGuestIdentityOptional } from '../../contexts/GuestIdentityContext';
import { useFeedbackLimitModal } from '../../hooks/useFeedbackLimitModal';

interface PhotoFavoritesProps {
  photoId: string;
  gallerySlug: string;
  isFavorited: boolean;
  favoriteCount: number;
  isEnabled: boolean;
  requireNameEmail?: boolean;
  onFavoriteChange?: (favorited: boolean) => void;
}

export const PhotoFavorites: React.FC<PhotoFavoritesProps> = ({
  photoId,
  gallerySlug,
  isFavorited,
  favoriteCount,
  isEnabled,
  requireNameEmail = false,
  onFavoriteChange
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const guestIdentity = useGuestIdentityOptional();
  const { modal: limitModal, handleError: handleLimitError } = useFeedbackLimitModal();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [savedIdentity, setSavedIdentity] = useState<{ name: string; email: string } | null>(null);

  const submitFavoriteMutation = useMutation({
    mutationFn: (data: { guest_name?: string; guest_email?: string } = {}) => 
      feedbackService.submitFeedback(gallerySlug, photoId, {
        feedback_type: 'favorite',
        guest_name: data.guest_name || undefined,
        guest_email: data.guest_email || undefined
      }),
    onMutate: async () => {
      setIsSubmitting(true);
      setAnimating(true);
      // Optimistic update
      if (onFavoriteChange) {
        onFavoriteChange(!isFavorited);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['photo-feedback', gallerySlug, photoId] });
      queryClient.invalidateQueries({ queryKey: ['gallery-photos'] });
    },
    onError: (error: any) => {
      // Revert optimistic update
      if (onFavoriteChange) {
        onFavoriteChange(isFavorited);
      }
      // Per-guest cap reached (#655) — surface the modal instead of a toast.
      if (handleLimitError(error)) return;
      if (error.response?.status === 429) {
        toast.error(t('feedback.rateLimited', 'Please wait before favoriting again'));
      } else {
        toast.error(t('feedback.favoriteError', 'Failed to update favorite'));
      }
    },
    onSettled: () => {
      setIsSubmitting(false);
      setTimeout(() => setAnimating(false), 300);
    }
  });

  const handleFavoriteClick = async () => {
    if (!isEnabled || isSubmitting) return;

    if (guestIdentity?.identityMode === 'guest') {
      try {
        await guestIdentity.ensureIdentity();
      } catch {
        return;
      }
      submitFavoriteMutation.mutate({});
      return;
    }

    if (requireNameEmail && !savedIdentity) {
      setShowIdentityModal(true);
    } else {
      const identityPayload = savedIdentity
        ? { guest_name: savedIdentity.name, guest_email: savedIdentity.email }
        : {};
      submitFavoriteMutation.mutate(identityPayload);
    }
  };

  const handleIdentitySubmit = (name: string, email: string) => {
    setSavedIdentity({ name, email });
    setShowIdentityModal(false);
    submitFavoriteMutation.mutate({ guest_name: name, guest_email: email });
  };

  if (!isEnabled) return null;

  return (
    <>
      <button
      onClick={handleFavoriteClick}
      disabled={isSubmitting}
      className={`group flex items-center gap-2 px-3 py-2 rounded-lg transition-all ${
        isFavorited 
          ? 'bg-amber-50 text-amber-600 hover:bg-amber-100' 
          : 'bg-surface text-muted-theme hover:bg-black/10'
      } ${isSubmitting ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
      aria-label={isFavorited ? t('feedback.unfavorite', 'Remove from favorites') : t('feedback.favorite', 'Add to favorites')}
    >
      <Bookmark
        className={`w-5 h-5 transition-all ${
          animating ? 'scale-125' : 'scale-100'
        } ${
          isFavorited ? 'fill-current' : 'group-hover:scale-110'
        }`}
      />
      <span className="text-sm font-medium">
        {favoriteCount > 0 ? favoriteCount : ''}
      </span>
      </button>
      <FeedbackIdentityModal
        isOpen={showIdentityModal}
        onClose={() => setShowIdentityModal(false)}
        onSubmit={handleIdentitySubmit}
        feedbackType={t('feedback.favorite', 'favorite')}
      />
      {limitModal}
    </>
  );
};
