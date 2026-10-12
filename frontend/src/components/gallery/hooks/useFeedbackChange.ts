import { useCallback, useEffect, useRef } from 'react';
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
  // How many times each cached list has been fetched. Counted from the cache's
  // own events, because a list's dataUpdatedAt also moves on a manual write
  // (a tile rating patches the same lists), and that is not a newer snapshot.
  const listFetches = useRef(new Map<string, number>());
  useEffect(() => queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) return;
    const [scope, eventSlug] = event.query.queryKey as unknown[];
    if (scope !== 'gallery-photos' || eventSlug !== slug) return;
    listFetches.current.set(event.query.queryHash, (listFetches.current.get(event.query.queryHash) ?? 0) + 1);
  }), [queryClient, slug]);
  // Once the gallery is left (or the slug changes) nothing counts the list
  // fetches any more, so an answer still on its way could no longer be told
  // from a stale one: it would land on the list of a later visit, or of the
  // next guest. Answers asked for before that point are dropped.
  const visit = useRef(0);
  // The gallery this hook currently serves, null once it is left. A tile's
  // submit can finish after that and still call the handler it captured.
  const servedSlug = useRef<string | null>(null);
  useEffect(() => {
    servedSlug.current = slug;
    return () => { servedSlug.current = null; visit.current += 1; };
  }, [slug]);

  return useCallback((toggledPhotoId?: number) => {
    // Guest-mode Rated/Liked filter membership + chip counts come
    // from my-feedback, not the photo rows (#538) — refresh it too
    // so e.g. a cleared rating (#884) leaves the Rated filter.
    queryClient.invalidateQueries({ queryKey: ['my-feedback', slug] });
    const listKey = ['gallery-photos', slug];
    // Nothing from a visit that has ended is written into the lists. They are
    // invalidated instead: the list is cached for minutes, and a guest coming
    // back would otherwise see the hearts and counts from before the toggle.
    // A list nobody is showing is only marked stale; one that is on screen
    // again (the guest already came back) is fetched now.
    const leaveStale = () => queryClient.invalidateQueries({ queryKey: listKey });
    // Called for a gallery that has been left.
    if (servedSlug.current !== slug) { leaveStale(); return; }

    // A list request already out may carry the row from before the toggle and
    // would land on top of the patch, so it is restarted instead.
    if (!patchRows || toggledPhotoId === undefined || queryClient.isFetching({ queryKey: listKey }) > 0) {
      refetch();
      return;
    }

    const request = (latestRequest.current.get(toggledPhotoId) ?? 0) + 1;
    latestRequest.current.set(toggledPhotoId, request);
    // The lists as they stand now. One fetched after this row was asked for
    // is newer than the answer (a refetch after a later toggle, another
    // guest's list after an identity switch) and must not be patched with it.
    const lists = () => queryClient.getQueryCache().findAll({ queryKey: listKey });
    const fetchesAtRequest = new Map(lists().map((query) => [query.queryHash, listFetches.current.get(query.queryHash) ?? 0]));
    const visitAtRequest = visit.current;
    feedbackService.getPhotoFeedback(slug, String(toggledPhotoId))
      .then((fresh) => {
        if (visit.current !== visitAtRequest) { leaveStale(); return; }
        if (latestRequest.current.get(toggledPhotoId) !== request) return;
        for (const query of lists()) {
          if (fetchesAtRequest.get(query.queryHash) !== (listFetches.current.get(query.queryHash) ?? 0)) continue;
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
              : old);
        }
      })
      .catch(() => { if (visit.current === visitAtRequest) refetch(); else leaveStale(); });
  }, [queryClient, slug, refetch, patchRows]);
}
