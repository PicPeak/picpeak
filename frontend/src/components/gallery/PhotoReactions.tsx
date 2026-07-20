import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { feedbackService, REACTION_EMOJIS } from '../../services/feedback.service';
import { toast } from 'react-toastify';
import { FeedbackIdentityModal } from './FeedbackIdentityModal';
import { useGuestIdentityOptional } from '../../contexts/GuestIdentityContext';

interface PhotoReactionsProps {
  photoId: string;
  gallerySlug: string;
  /** The guest's current reaction emoji, or null. */
  myReaction: string | null;
  /** Per-emoji visible counts, e.g. { '❤️': 3 }. */
  reactionCounts: Record<string, number>;
  isEnabled: boolean;
  requireNameEmail?: boolean;
  onReactionChange?: (reaction: string | null) => void;
}

// Emoji reaction bar (#839): one reaction per guest per photo, changeable —
// tapping the current emoji removes it, tapping another switches. Fixed
// curated set; identity handling mirrors PhotoLikes (guest-token mode vs.
// legacy inline name/email prompt).
export const PhotoReactions: React.FC<PhotoReactionsProps> = ({
  photoId,
  gallerySlug,
  myReaction,
  reactionCounts,
  isEnabled,
  requireNameEmail = false,
  onReactionChange
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const guestIdentity = useGuestIdentityOptional();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [savedIdentity, setSavedIdentity] = useState<{ name: string; email: string } | null>(null);
  const [pendingEmoji, setPendingEmoji] = useState<string | null>(null);

  const submitReactionMutation = useMutation({
    mutationFn: (data: { emoji: string; guest_name?: string; guest_email?: string }) =>
      feedbackService.submitFeedback(gallerySlug, photoId, {
        feedback_type: 'reaction',
        reaction: data.emoji,
        guest_name: data.guest_name || undefined,
        guest_email: data.guest_email || undefined
      }),
    onMutate: async (data) => {
      setIsSubmitting(true);
      // Optimistic update: same emoji toggles off, another switches. The
      // PRE-mutation value must travel via the mutation context — the
      // onError closure sees the post-optimistic render, so reading
      // `myReaction` there would "revert" to the already-wrong state.
      const previousReaction = myReaction;
      if (onReactionChange) {
        onReactionChange(data.emoji === previousReaction ? null : data.emoji);
      }
      return { previousReaction };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['photo-feedback', gallerySlug, photoId] });
    },
    onError: (_error, _data, context) => {
      if (onReactionChange) {
        onReactionChange(context?.previousReaction ?? null); // revert optimistic update
      }
      toast.error(t('feedback.reactionError', 'Failed to update reaction'));
    },
    onSettled: () => {
      setIsSubmitting(false);
    }
  });

  const handleReactionClick = async (emoji: string) => {
    if (!isEnabled || isSubmitting) return;

    // Guest identity mode: ensure a per-person guest token; the server reads
    // name/email from the token — body values are ignored.
    if (guestIdentity?.identityMode === 'guest') {
      try {
        await guestIdentity.ensureIdentity();
      } catch {
        return; // user cancelled the prompt
      }
      submitReactionMutation.mutate({ emoji });
      return;
    }

    // Simple mode: legacy inline prompt flow.
    if (requireNameEmail && !savedIdentity) {
      setPendingEmoji(emoji);
      setShowIdentityModal(true);
    } else {
      submitReactionMutation.mutate({
        emoji,
        ...(savedIdentity ? { guest_name: savedIdentity.name, guest_email: savedIdentity.email } : {})
      });
    }
  };

  const handleIdentitySubmit = (name: string, email: string) => {
    setSavedIdentity({ name, email });
    setShowIdentityModal(false);
    if (pendingEmoji) {
      submitReactionMutation.mutate({ emoji: pendingEmoji, guest_name: name, guest_email: email });
      setPendingEmoji(null);
    }
  };

  if (!isEnabled) return null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('feedback.reactions', 'Reactions')}>
        {REACTION_EMOJIS.map((emoji) => {
          const count = reactionCounts[emoji] || 0;
          const isMine = myReaction === emoji;
          return (
            <button
              key={emoji}
              type="button"
              onClick={() => handleReactionClick(emoji)}
              disabled={isSubmitting}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-full text-sm transition-all ${
                isMine
                  ? 'bg-primary-100 dark:bg-primary-900/40 ring-1 ring-primary-500 scale-105'
                  : 'bg-surface text-muted-theme hover:bg-black/10 hover:scale-105'
              } ${isSubmitting ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
              aria-pressed={isMine}
              aria-label={isMine
                ? t('feedback.removeReaction', 'Remove {{emoji}} reaction', { emoji })
                : t('feedback.reactWith', 'React with {{emoji}}', { emoji })}
            >
              <span className="text-base leading-none">{emoji}</span>
              {count > 0 && <span className="font-medium">{count}</span>}
            </button>
          );
        })}
      </div>
      <FeedbackIdentityModal
        isOpen={showIdentityModal}
        onClose={() => { setShowIdentityModal(false); setPendingEmoji(null); }}
        onSubmit={handleIdentitySubmit}
        feedbackType={t('feedback.reaction', 'reaction')}
      />
    </>
  );
};
