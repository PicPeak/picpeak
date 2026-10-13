import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { galleryService } from '../../../services/gallery.service';

// 45 requests per 15 minutes per viewer, far inside the gallery viewer
// budget (rateLimitService.js: ten times the general limit, 3000 by default).
export const LIVE_REFRESH_INTERVAL_MS = 20_000;
export const LIVE_REFRESH_MAX_INTERVAL_MS = 5 * 60_000;

interface Options {
  slug: string;
  /** The gallery has the option on and nothing else is polling the list. */
  enabled: boolean;
  /** What the loaded list holds. */
  loadedCount: number;
  loadedMaxId: number | null;
}

/**
 * Live refresh (issue 1733, C5). Polls GET /:slug/photos/state while the tab
 * is visible and returns how many photos the server has beyond the loaded
 * list, for the "N new photos" pill. It never reloads anything itself.
 *
 * Any failure (429 included) doubles the interval up to the cap and stays
 * silent; the next success returns to the base interval.
 */
export function useLiveRefresh({ slug, enabled, loadedCount, loadedMaxId }: Options): number {
  const queryClient = useQueryClient();
  const [state, setState] = useState<{ count: number; max_id: number | null; asked: number } | null>(null);
  // One clock for when a list request and when a poll was sent: whichever
  // was asked for later describes the newer gallery, in whatever order the
  // two come back.
  const clock = useRef(0);
  const listFetchStarted = useRef(new Map<string, number>());
  // When the newest list that has arrived was asked for.
  const listAsked = useRef(0);

  useEffect(() => { setState(null); }, [slug]);
  // A reloaded list makes the last answer stale: it may count photos that
  // were deleted since, and the pill would outlive the click that cleared it.
  // Read from the cache's own events, as useFeedbackChange does: the list's
  // dataUpdatedAt also moves when a like or a rating patches its rows, and
  // that brings no new photos in.
  // Only an answer asked for after that list survives it. (A request that
  // is restarted while out keeps its first start time, the cache reports no
  // second one; a notice from in between then lasts until the next poll.)
  useEffect(() => {
    const started = listFetchStarted.current;
    const stamp = (hash: string) => { clock.current += 1; started.set(hash, clock.current); };
    // A request already out was sent before any poll from here on.
    queryClient.getQueryCache()
      .findAll({ queryKey: ['gallery-photos', slug], fetchStatus: 'fetching' })
      .forEach((query) => stamp(query.queryHash));
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated') return;
      const [scope, eventSlug] = event.query.queryKey as unknown[];
      if (scope !== 'gallery-photos' || eventSlug !== slug) return;
      const hash = event.query.queryHash;
      // 'failed' is one attempt failing: the retry that follows is a new read.
      if (event.action.type === 'fetch' || event.action.type === 'failed') { stamp(hash); return; }
      if (event.action.type !== 'success' || event.action.manual) return;
      const asked = started.get(hash) ?? (clock.current += 1);
      started.delete(hash);
      listAsked.current = Math.max(listAsked.current, asked);
      setState((current) => (current && current.asked > asked ? current : null));
    });
    return () => { unsubscribe(); started.clear(); };
  }, [queryClient, slug]);

  useEffect(() => {
    if (!enabled) return undefined;
    let delay = LIVE_REFRESH_INTERVAL_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let stopped = false;
    const controller = new AbortController();

    const schedule = () => {
      // A request still out schedules the next one itself when it settles.
      if (stopped || timer || inFlight || document.hidden) return;
      timer = setTimeout(poll, delay);
    };
    const poll = async () => {
      timer = null;
      inFlight = true;
      clock.current += 1;
      const asked = clock.current;
      try {
        const next = await galleryService.getPhotoState(slug, controller.signal);
        if (stopped) return;
        if (asked > listAsked.current) setState({ ...next, asked });
        delay = LIVE_REFRESH_INTERVAL_MS;
      } catch {
        delay = Math.min(delay * 2, LIVE_REFRESH_MAX_INTERVAL_MS);
      }
      inFlight = false;
      schedule();
    };
    // A hidden tab stops asking; coming back waits one interval (the current
    // one, so a backed-off viewer cannot reset it by switching tabs).
    const onVisibility = () => {
      if (document.hidden) {
        if (timer) clearTimeout(timer);
        timer = null;
      } else {
        schedule();
      }
    };

    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [slug, enabled]);

  if (!enabled || !state) return 0;
  // A higher id with no higher count is a photo that replaced a deleted one:
  // still worth a reload, and "1" is the least it can be. A lower count
  // (photos deleted) needs no notice.
  const replaced = state.max_id !== null && state.max_id > (loadedMaxId ?? 0) ? 1 : 0;
  return Math.max(state.count - loadedCount, replaced);
}
