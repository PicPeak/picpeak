import React, { useState } from 'react';
import { createPortal } from 'react-dom';
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
  /** The server accepted the toggle. */
  onSaved?: (photoId: string) => void;
  /** The server accepted the toggle; unlike onSaved, keeps the list refresh. */
  onAccepted?: (photoId: string) => void;
  /** 'toolbar': a round button for the lightbox's black bar (issue 1733). */
  variant?: 'panel' | 'toolbar';
}

export const PhotoFavorites: React.FC<PhotoFavoritesProps> = ({
  photoId,
  gallerySlug,
  isFavorited,
  favoriteCount,
  isEnabled,
  requireNameEmail = false,
  onFavoriteChange,
  onSaved,
  onAccepted,
  variant = 'panel'
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
    // The photo travels with the call. The function and the callbacks below
    // are the latest render's, which in the lightbox can already show another
    // photo: a toggle paused offline would otherwise be sent for that one.
    mutationFn: (data: { photoId: string; guest_name?: string; guest_email?: string }) =>
      feedbackService.submitFeedback(gallerySlug, data.photoId, {
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
    onSuccess: (_data, variables) => {
      const savedPhotoId = variables.photoId;
      queryClient.invalidateQueries({ queryKey: ['photo-feedback', gallerySlug, savedPhotoId] });
      onAccepted?.(savedPhotoId);
      // The parent refreshes this photo's row; without one, the whole list.
      if (onSaved) onSaved(savedPhotoId);
      else queryClient.invalidateQueries({ queryKey: ['gallery-photos', gallerySlug] });
      // In guest identity mode the Favorited filter and the filename list
      // read the guest's own rows from my-feedback, so refresh it now that
      // the toggle is accepted (as PhotoRating does).
      queryClient.invalidateQueries({ queryKey: ['my-feedback', gallerySlug] });
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
      submitFavoriteMutation.mutate({ photoId });
      return;
    }

    if (requireNameEmail && !savedIdentity) {
      setShowIdentityModal(true);
    } else {
      const identityPayload = savedIdentity
        ? { guest_name: savedIdentity.name, guest_email: savedIdentity.email }
        : {};
      submitFavoriteMutation.mutate({ ...identityPayload, photoId });
    }
  };

  const handleIdentitySubmit = (name: string, email: string) => {
    setSavedIdentity({ name, email });
    setShowIdentityModal(false);
    submitFavoriteMutation.mutate({ photoId, guest_name: name, guest_email: email });
  };

  if (!isEnabled) return null;

  return (
    <>
      <button
      onClick={handleFavoriteClick}
      disabled={isSubmitting}
      className={`group flex items-center transition-all ${
        variant === 'toolbar'
          ? `gap-1 p-2 rounded-full text-white ${isFavorited ? 'bg-warning hover:opacity-90' : 'bg-white/10 hover:bg-white/20'}`
          : `gap-2 px-3 py-2 rounded-lg ${isFavorited ? 'status-chip hue-warning hover:brightness-95' : 'bg-elevated text-muted-theme hover-surface'}`
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
      {(variant === 'panel' || favoriteCount > 0) && (
        <span className="text-sm font-medium">
          {favoriteCount > 0 ? favoriteCount : ''}
        </span>
      )}
      </button>
      {/* Portalled to the body: in the lightbox bar (issue 1733) the bar's
          z-index would hold the dialog under the feedback panel. */}
      {showIdentityModal && createPortal(
        <FeedbackIdentityModal
          isOpen
          onClose={() => setShowIdentityModal(false)}
          onSubmit={handleIdentitySubmit}
          feedbackType={t('feedback.favorite', 'favorite')}
        />,
        document.body
      )}
      {limitModal}
    </>
  );
};
