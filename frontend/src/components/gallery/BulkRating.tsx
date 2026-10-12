import React, { useState } from 'react';
import { Star, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { BULK_RATING_MAX_PHOTOS, feedbackService } from '../../services/feedback.service';
import { FeedbackIdentityModal } from './FeedbackIdentityModal';
import { useGuestIdentityOptional } from '../../contexts/GuestIdentityContext';
import type { GalleryData, Photo } from '../../types';

interface BulkRatingProps {
  slug: string;
  /** The selection. */
  photoIds: number[];
  requireNameEmail?: boolean;
  className?: string;
}

type Submission = { rating: number; guest_name?: string; guest_email?: string; identityChanged?: boolean };
type RatedRow = { average_rating?: number; total_ratings?: number };

/**
 * "Rate selected" (issue 1733): one star press rates the whole selection
 * through the bulk route instead of a request per photo. Like TileRating it
 * writes the result into the cached `gallery-photos` lists in place; the
 * selection is often most of the gallery, and the list is not refetched for
 * it. The X clears the rating of every selected photo (#884).
 */
export const BulkRating: React.FC<BulkRatingProps> = ({ slug, photoIds, requireNameEmail = false, className = '' }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const guestIdentity = useGuestIdentityOptional();
  const [pendingRating, setPendingRating] = useState<number | null>(null);
  const [identity, setIdentity] = useState<{ name: string; email: string } | null>(null);

  const mutation = useMutation({
    mutationFn: async (data: Submission) => {
      // The server caps a request; a larger selection goes in several. One
      // the rating budget refuses ends the run, and what the earlier ones
      // rated is reported so the tiles still show it.
      const rated = new Map<number, RatedRow>();
      let error: unknown = null;
      for (let i = 0; i < photoIds.length && !error; i += BULK_RATING_MAX_PHOTOS) {
        try {
          const response = await feedbackService.submitBulkRating(
            slug,
            photoIds.slice(i, i + BULK_RATING_MAX_PHOTOS),
            data.rating,
            { guest_name: data.guest_name, guest_email: data.guest_email },
          );
          for (const row of response.results) {
            if (row.success) rated.set(row.photo_id, { average_rating: row.average_rating, total_ratings: row.total_ratings });
          }
        } catch (caught) {
          error = caught;
        }
      }
      return { rated, error };
    },
    onSuccess: async ({ rated, error }, data) => {
      if (rated.size > 0) {
        // Same care as TileRating: a list request that is out carries the
        // rows from before the rating and would land on top of the patch.
        const listMustRestart = data.identityChanged === true
          || queryClient.isFetching({ queryKey: ['gallery-photos', slug] }) > 0;
        if (listMustRestart) {
          await queryClient.cancelQueries({ queryKey: ['gallery-photos', slug] });
        }
        queryClient.setQueriesData<GalleryData>({ queryKey: ['gallery-photos', slug] }, (old) =>
          old
            ? {
              ...old,
              photos: old.photos.map((p): Photo => {
                const row = rated.get(p.id);
                if (!row) return p;
                return {
                  ...p,
                  my_rating: data.rating || null,
                  // Sent only when the gallery shares feedback; otherwise the
                  // row keeps what the list gave it.
                  ...(row.average_rating !== undefined ? { average_rating: row.average_rating } : {}),
                  ...(row.total_ratings !== undefined ? { total_ratings: row.total_ratings } : {}),
                };
              }),
            }
            : old,
        );
        // Guest-mode Rated chip + filter are built from /my-feedback (#538).
        queryClient.invalidateQueries({ queryKey: ['my-feedback', slug] });
        if (listMustRestart) {
          void queryClient.invalidateQueries({ queryKey: ['gallery-photos', slug] });
        }
      }
      if (error) {
        if ((error as { response?: { status?: number } })?.response?.status === 429) {
          toast.error(t('feedback.ratingLimitReached', 'Rating limit reached. Try again later.'));
        } else {
          toast.error(t('feedback.ratingError', 'Failed to submit rating'));
        }
      } else if (rated.size < photoIds.length) {
        toast.error(t('feedback.bulkRatingPartial', '{{rated}} of {{total}} photos were rated', {
          rated: rated.size,
          total: photoIds.length,
        }));
      }
    },
  });

  const rate = async (rating: number) => {
    if (mutation.isPending || photoIds.length === 0) return;
    if (guestIdentity?.identityMode === 'guest') {
      const identityBefore = guestIdentity.identity?.id ?? null;
      let ensured;
      try {
        ensured = await guestIdentity.ensureIdentity();
      } catch {
        return;
      }
      mutation.mutate({ rating, identityChanged: (ensured?.id ?? null) !== identityBefore });
    } else if (requireNameEmail && !identity) {
      setPendingRating(rating);
    } else {
      mutation.mutate({ rating, guest_name: identity?.name, guest_email: identity?.email });
    }
  };

  return (
    <>
      <div
        className={`gallery-bulk-rating flex items-center gap-1 flex-wrap ${className}`}
        role="group"
        aria-label={t('feedback.rateSelected', 'Rate selected')}
      >
        <span className="text-xs sm:text-sm text-muted-theme mr-1">{t('feedback.rateSelected', 'Rate selected')}</span>
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            type="button"
            className="p-1 disabled:opacity-50 text-muted-theme hover:text-rating"
            disabled={mutation.isPending}
            onClick={() => void rate(star)}
            aria-label={t('feedback.rateStar', 'Rate {{count}} stars', { count: star })}
          >
            <Star className="w-4 h-4" />
          </button>
        ))}
        <button
          type="button"
          className="p-1 disabled:opacity-50 text-muted-theme hover:text-theme"
          disabled={mutation.isPending}
          onClick={() => void rate(0)}
          aria-label={t('feedback.removeRating', 'Remove rating')}
          title={t('feedback.removeRating', 'Remove rating')}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      {pendingRating !== null && (
        <FeedbackIdentityModal
          isOpen
          onClose={() => setPendingRating(null)}
          onSubmit={(name, email) => {
            setIdentity({ name, email });
            setPendingRating(null);
            mutation.mutate({ rating: pendingRating, guest_name: name, guest_email: email });
          }}
          feedbackType={t('feedback.rating', 'rating')}
        />
      )}
    </>
  );
};
