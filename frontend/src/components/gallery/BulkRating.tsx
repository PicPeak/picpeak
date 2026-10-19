import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Star, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { BULK_RATING_MAX_PHOTOS, feedbackService } from '../../services/feedback.service';
import { FeedbackIdentityModal } from './FeedbackIdentityModal';
import { useGuestIdentityOptional } from '../../contexts/GuestIdentityContext';
import { getGuestIdentity } from '../../utils/guestIdentityStorage';
import type { GalleryData, Photo } from '../../types';

interface BulkRatingProps {
  slug: string;
  /** The selection. */
  photoIds: number[];
  requireNameEmail?: boolean;
  /** Told when the name-and-email dialog opens and closes. */
  onDialogChange?: (open: boolean) => void;
  /**
   * The name and email once given, held by a host that outlives this control
   * (the phone's rating sheet unmounts it on close). Kept locally without one.
   */
  identity?: { name: string; email: string } | null;
  onIdentityChange?: (identity: { name: string; email: string }) => void;
  className?: string;
}

type Rating = { rating: number; guest_name?: string; guest_email?: string; identityChanged?: boolean };
// The selection and the guest are taken at the press: offline, the request
// waits for the network and runs with whatever the component renders by then.
type Submission = Rating & { photoIds: number[]; guestId: number | null };
type RatedRow = { average_rating?: number; total_ratings?: number };

/**
 * "Rate selected" (issue 1733): one star press rates the whole selection
 * through the bulk route instead of a request per photo. Like TileRating it
 * writes the result into the cached `gallery-photos` lists in place; the
 * selection is often most of the gallery, and the list is not refetched for
 * it. The X clears the rating of every selected photo (#884).
 */
export const BulkRating: React.FC<BulkRatingProps> = ({
  slug,
  photoIds,
  requireNameEmail = false,
  onDialogChange,
  identity: hostIdentity,
  onIdentityChange,
  className = '',
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const guestIdentity = useGuestIdentityOptional();
  const [pendingRating, setPendingRating] = useState<number | null>(null);
  const [ownIdentity, setOwnIdentity] = useState<{ name: string; email: string } | null>(null);
  const identity = onIdentityChange ? hostIdentity ?? null : ownIdentity;
  const setIdentity = onIdentityChange ?? setOwnIdentity;
  const onDialogChangeRef = useRef(onDialogChange);
  onDialogChangeRef.current = onDialogChange;
  const dialogOpen = pendingRating !== null;
  useEffect(() => {
    if (!dialogOpen) return;
    onDialogChangeRef.current?.(true);
    return () => onDialogChangeRef.current?.(false);
  }, [dialogOpen]);

  // Keyed, so the guard outlives this control: on a phone it sits in a sheet
  // that can be closed and reopened while a run is still out, and a fresh
  // control must not start a second run over the same selection.
  const mutationKey = ['bulk-rating', slug];
  const busy = useIsMutating({ mutationKey }) > 0;

  const mutation = useMutation({
    mutationKey,
    mutationFn: async (data: Submission) => {
      // The server caps a request; a larger selection goes in several. One
      // the rating budget refuses ends the run, and what the earlier ones
      // rated stays on the tiles.
      let ratedCount = 0;
      let error: unknown = null;
      let listMustRestart = data.identityChanged === true;
      // The API client reads the stored guest token per request. Once another
      // tab has switched the guest, the rest of the run would be filed under
      // the new one, so it ends there.
      const { photoIds: ids } = data;
      const sameGuest = () => (getGuestIdentity(slug)?.id ?? null) === data.guestId;
      for (let i = 0; i < ids.length && !error && sameGuest(); i += BULK_RATING_MAX_PHOTOS) {
        const rated = new Map<number, RatedRow>();
        try {
          const response = await feedbackService.submitBulkRating(
            slug,
            ids.slice(i, i + BULK_RATING_MAX_PHOTOS),
            data.rating,
            { guest_name: data.guest_name, guest_email: data.guest_email },
          );
          for (const row of response.results) {
            if (row.success) rated.set(row.photo_id, { average_rating: row.average_rating, total_ratings: row.total_ratings });
          }
        } catch (caught) {
          error = caught;
        }
        // The lists now belong to another guest and the provider has already
        // restarted them; these ratings are not theirs to see.
        if (rated.size === 0 || !sameGuest()) continue;
        ratedCount += rated.size;
        // Written per request, not once at the end: by then the viewer may
        // have rated one of these photos again on its tile, and the late
        // write would put this run's stars back over theirs.
        // Same care as TileRating: a list request that is out carries the
        // rows from before the rating and would land on top of the patch.
        if (listMustRestart || queryClient.isFetching({ queryKey: ['gallery-photos', slug] }) > 0) {
          listMustRestart = true;
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
      }
      return { ratedCount, error, listMustRestart, guestChanged: !sameGuest() };
    },
    onSuccess: ({ ratedCount, error, listMustRestart, guestChanged }, data) => {
      if (guestChanged) return;
      if (ratedCount > 0) {
        // Guest-mode Rated chip + filter are built from /my-feedback (#538).
        queryClient.invalidateQueries({ queryKey: ['my-feedback', slug] });
        // The lightbox's feedback panel has its own per-photo copy of the
        // rating, open or cached from an earlier look.
        queryClient.invalidateQueries({ queryKey: ['photo-feedback', slug] });
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
      } else if (ratedCount < data.photoIds.length) {
        toast.error(t('feedback.bulkRatingPartial', '{{rated}} of {{total}} photos were rated', {
          rated: ratedCount,
          total: data.photoIds.length,
        }));
      }
    },
  });

  const submit = (data: Rating) =>
    mutation.mutate({ ...data, photoIds, guestId: getGuestIdentity(slug)?.id ?? null });

  const rate = async (rating: number) => {
    if (busy || photoIds.length === 0) return;
    if (guestIdentity?.identityMode === 'guest') {
      const identityBefore = guestIdentity.identity?.id ?? null;
      let ensured;
      try {
        ensured = await guestIdentity.ensureIdentity();
      } catch {
        return;
      }
      submit({ rating, identityChanged: (ensured?.id ?? null) !== identityBefore });
    } else if (requireNameEmail && !identity) {
      setPendingRating(rating);
    } else {
      submit({ rating, guest_name: identity?.name, guest_email: identity?.email });
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
            disabled={busy}
            onClick={() => void rate(star)}
            aria-label={t('feedback.rateStar', 'Rate {{count}} stars', { count: star })}
          >
            <Star className="w-4 h-4" />
          </button>
        ))}
        <button
          type="button"
          className="p-1 disabled:opacity-50 text-muted-theme hover:text-theme"
          disabled={busy}
          onClick={() => void rate(0)}
          aria-label={t('feedback.removeRating', 'Remove rating')}
          title={t('feedback.removeRating', 'Remove rating')}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      {/* Portalled to the body: the sidebar this sits in slides with a CSS
          transform, and a fixed overlay inside a transformed box is laid out
          against that box, not the viewport. */}
      {pendingRating !== null && createPortal(
        <FeedbackIdentityModal
          isOpen
          onClose={() => setPendingRating(null)}
          onSubmit={(name, email) => {
            setIdentity({ name, email });
            setPendingRating(null);
            submit({ rating: pendingRating, guest_name: name, guest_email: email });
          }}
          feedbackType={t('feedback.rating', 'rating')}
        />,
        document.body,
      )}
    </>
  );
};
