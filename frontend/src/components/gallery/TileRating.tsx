import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { feedbackService } from '../../services/feedback.service';
import { FeedbackIdentityModal } from './FeedbackIdentityModal';
import { useGuestIdentityOptional } from '../../contexts/GuestIdentityContext';
import type { GalleryData, Photo } from '../../types';

interface TileRatingProps {
  photo: Photo;
  slug: string;
  /** 'light' = white pill with dark empty stars; 'dark' = translucent pill with white stars. */
  variant?: 'light' | 'dark';
  requireNameEmail?: boolean;
  savedIdentity?: { name: string; email: string } | null;
  /**
   * Called with the name/email the viewer typed into this tile's identity
   * modal, so the card and the layout can reuse it for every other tile.
   */
  onIdentitySaved?: (identity: { name: string; email: string }) => void;
  /** Called after a star was pressed, so the tile can drop its tap-to-reveal overlay. */
  onDone?: () => void;
}

/**
 * The five-star control on a grid tile (issue 1733, A3a). Reads the viewer's
 * own rating from `photo.my_rating` and writes the new value back into every
 * cached `gallery-photos` query in place, so the tile and the lightbox (which
 * reads the same list) agree without refetching the whole gallery. Same
 * request as the lightbox and PhotoRating: `feedbackService.submitFeedback`
 * with feedback_type 'rating'; 0 clears (#884).
 */
export const TileRating: React.FC<TileRatingProps> = ({
  photo,
  slug,
  variant = 'light',
  requireNameEmail = false,
  savedIdentity,
  onIdentitySaved,
  onDone,
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const guestIdentity = useGuestIdentityOptional();
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [pendingRating, setPendingRating] = useState(0);
  const [ownIdentity, setOwnIdentity] = useState<{ name: string; email: string } | null>(null);
  const identity = savedIdentity ?? ownIdentity;
  const current = photo.my_rating ?? 0;

  const mutation = useMutation({
    mutationFn: (data: { rating: number; guest_name?: string; guest_email?: string; identityChanged?: boolean }) =>
      feedbackService.submitFeedback(slug, String(photo.id), {
        feedback_type: 'rating',
        rating: data.rating,
        guest_name: data.guest_name,
        guest_email: data.guest_email,
      }),
    onSuccess: async (_result, data) => {
      // A list request that is out while the rating settles carries the row
      // from before it, and would land after the patch below and put the old
      // stars and aggregates back. Two ways to be in that state: a refresh
      // was already in flight (any identity mode), or this very rating
      // established or switched the guest identity, which makes
      // GuestIdentityProvider invalidate gallery-photos. Exactly then the
      // request is cancelled and, once the patch is in, asked for again —
      // it may also carry other photos' changes. In the common case, nothing
      // in flight and a known identity, neither happens: proofing a
      // 300-photo shoot must not refetch the gallery per star.
      const listMustRestart = data.identityChanged === true
        || queryClient.isFetching({ queryKey: ['gallery-photos', slug] }) > 0;
      if (listMustRestart) {
        await queryClient.cancelQueries({ queryKey: ['gallery-photos', slug] });
      }
      // In place, not a refetch: a 500-photo list re-hydrated per star is
      // what the lightbox path already costs, and the tile is meant to be
      // the fast route. The key prefix matches every filter/guest variant.
      const patchPhoto = (patch: Partial<Photo>) =>
        queryClient.setQueriesData<GalleryData>({ queryKey: ['gallery-photos', slug] }, (old) =>
          old
            ? {
              ...old,
              photos: old.photos.map((p) => (p.id === photo.id ? { ...p, ...patch } : p)),
            }
            : old,
        );
      patchPhoto({ my_rating: data.rating || null });
      // Guest-mode Rated chip + filter are built from /my-feedback (#538).
      queryClient.invalidateQueries({ queryKey: ['my-feedback', slug] });
      // The tile badges in every layout, and outside guest mode the Rated
      // chip and its filter too, read average_rating / total_ratings off the
      // list row. One per-photo summary request (what the lightbox fetches
      // too) keeps them in step without re-hydrating the whole list.
      try {
        const fresh = await feedbackService.getPhotoFeedback(slug, String(photo.id));
        patchPhoto({
          average_rating: Number(fresh.summary?.average_rating) || 0,
          total_ratings: Number(fresh.summary?.total_ratings) || 0,
        });
      } catch {
        // The star itself is already right; the aggregates catch up on the
        // next list fetch.
      }
      if (listMustRestart) {
        // Last, because setQueryData clears the invalidated flag: a background
        // refetch while the patched row stays on screen.
        void queryClient.invalidateQueries({ queryKey: ['gallery-photos', slug] });
      }
    },
    onError: (error: any) => {
      if (error?.response?.status === 429) {
        toast.error(t('feedback.rateLimited', 'Please wait before rating again'));
      } else {
        toast.error(t('feedback.ratingError', 'Failed to submit rating'));
      }
    },
  });

  const rate = async (star: number) => {
    if (mutation.isPending) return;
    // Pressing the current rating again clears it (#884).
    const next = star === current ? 0 : star;
    if (guestIdentity?.identityMode === 'guest') {
      const identityBefore = guestIdentity.identity?.id ?? null;
      let ensured;
      try {
        ensured = await guestIdentity.ensureIdentity();
      } catch {
        onDone?.();
        return;
      }
      mutation.mutate({ rating: next, identityChanged: (ensured?.id ?? null) !== identityBefore });
    } else if (requireNameEmail && !identity) {
      setPendingRating(next);
      setShowIdentityModal(true);
      return;
    } else {
      mutation.mutate({ rating: next, guest_name: identity?.name, guest_email: identity?.email });
    }
    onDone?.();
  };

  const pillClass = variant === 'dark'
    ? 'bg-white/20 hover:bg-white/40'
    : 'bg-white/90 hover:bg-white';
  const emptyStarClass = variant === 'dark' ? 'text-white/70' : 'text-neutral-400';

  return (
    <>
      <div
        className={`flex items-center rounded-full px-1 transition-colors ${pillClass}`}
        role="group"
        aria-label={t('feedback.rating', 'Rating')}
        onClick={(e) => e.stopPropagation()}
      >
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            type="button"
            className="p-1 disabled:opacity-50"
            disabled={mutation.isPending}
            onClick={(e) => {
              e.stopPropagation();
              void rate(star);
            }}
            aria-label={star === current
              ? t('feedback.removeRating', 'Remove rating')
              : t('feedback.rateStar', 'Rate {{count}} stars', { count: star })}
            aria-pressed={star <= current}
          >
            <Star
              className={`w-3.5 h-3.5 ${star <= current ? 'text-yellow-500 fill-yellow-500' : emptyStarClass}`}
            />
          </button>
        ))}
      </div>
      {/* Portalled out of the overlay: the overlay hides with `opacity-0`, which
          would take a fixed-position modal rendered inside it along. React events
          still bubble through a portal, so the wrapper keeps a click in the form
          from reaching the tile and opening the photo. */}
      {requireNameEmail && showIdentityModal && createPortal(
        <div onClick={(e) => e.stopPropagation()}>
          <FeedbackIdentityModal
            isOpen
            onClose={() => setShowIdentityModal(false)}
            onSubmit={(name, email) => {
              setOwnIdentity({ name, email });
              onIdentitySaved?.({ name, email });
              setShowIdentityModal(false);
              mutation.mutate({ rating: pendingRating, guest_name: name, guest_email: email });
              onDone?.();
            }}
            feedbackType={t('feedback.rating', 'rating')}
          />
        </div>,
        document.body,
      )}
    </>
  );
};
