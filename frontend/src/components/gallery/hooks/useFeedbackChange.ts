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
 *
 * `patchRows: false` always refetches. A PIN client's list carries the
 * aggregate counts even when the gallery hides them from guests, and the
 * per-photo answer does not, so patching from it would wipe them.
 */
export function useFeedbackChange(slug: string, refetch: () => unknown, { patchRows = true }: { patchRows?: boolean } = {}) {
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
    if (!patchRows || toggledPhotoId === undefined || queryClient.isFetching({ queryKey: listKey }) > 0) {
      refetch();
      return;
    }

    const request = (latestRequest.current.get(toggledPhotoId) ?? 0) + 1;
    latestRequest.current.set(toggledPhotoId, request);
    // When each cached list was last fetched. A list fetched after this row
    // was asked for is newer than the answer (a refetch after a later toggle,
    // another guest's list after an identity switch) and must not be patched
    // with it.
    const lists = () => queryClient.getQueryCache().findAll({ queryKey: listKey });
    const fetchedAt = new Map(lists().map((query) => [query.queryHash, query.state.dataUpdatedAt]));
    feedbackService.getPhotoFeedback(slug, String(toggledPhotoId))
      .then((fresh) => {
        if (latestRequest.current.get(toggledPhotoId) !== request) return;
        for (const query of lists()) {
          if (fetchedAt.get(query.queryHash) !== query.state.dataUpdatedAt) continue;
          queryClient.setQueryData<GalleryData>(query.queryKey, (old) =>
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
          // The patch is not a fetch: the list keeps its fetch time, so the
          // answer to a second photo asked for meanwhile still applies.
          { updatedAt: query.state.dataUpdatedAt });
        }
      })
      .catch(() => { refetch(); });
  }, [queryClient, slug, refetch, patchRows]);
}
