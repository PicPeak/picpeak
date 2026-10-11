import { useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { feedbackService } from '../../../services/feedback.service';
import type { GalleryData } from '../../../types';

/**
 * What the gallery does when a guest's feedback changed.
 *
 * A like or favourite toggle names its photo, and only that row is brought up
 * to date: one per-photo request, written into the cached `gallery-photos`
 * lists in place (as TileRating does for a star). Refetching the list instead
 * downloaded and re-hydrated every photo of the gallery per like, which on a
 * 1,000-photo gallery stalled iOS Safari after a handful of likes (issue
 * 1891). Every other change, and a toggle that cannot be patched safely,
 * still refetches the list.
 */
export function useFeedbackChange(slug: string, refetch: () => unknown) {
  const queryClient = useQueryClient();
  // Two toggles on one photo can answer out of order; only the last one asked
  // for may write the row.
  const latestRequest = useRef(new Map<number, number>());

  return useCallback((toggledPhotoId?: number) => {
    // Guest-mode Rated/Liked filter membership + chip counts come
    // from my-feedback, not the photo rows (#538) — refresh it too
    // so e.g. a cleared rating (#884) leaves the Rated filter.
    queryClient.invalidateQueries({ queryKey: ['my-feedback', slug] });

    const listKey = ['gallery-photos', slug];
    // A list request already out may carry the row from before the toggle and
    // would land on top of the patch, so it is restarted instead.
    if (toggledPhotoId === undefined || queryClient.isFetching({ queryKey: listKey }) > 0) {
      refetch();
      return;
    }

    const request = (latestRequest.current.get(toggledPhotoId) ?? 0) + 1;
    latestRequest.current.set(toggledPhotoId, request);
    feedbackService.getPhotoFeedback(slug, String(toggledPhotoId))
      .then((fresh) => {
        if (latestRequest.current.get(toggledPhotoId) !== request) return;
        queryClient.setQueriesData<GalleryData>({ queryKey: listKey }, (old) =>
          old
            ? {
              ...old,
              photos: old.photos.map((p) => (p.id === toggledPhotoId
                ? {
                  ...p,
                  is_liked: Boolean(fresh.my_feedback?.liked),
                  like_count: Number(fresh.summary?.like_count) || 0,
                  favorite_count: Number(fresh.summary?.favorite_count) || 0,
                }
                : p)),
            }
            : old,
        );
      })
      .catch(() => { refetch(); });
  }, [queryClient, slug, refetch]);
}
