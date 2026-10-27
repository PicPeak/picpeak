import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { galleryService } from '../../../services/gallery.service';
import { LIVE_REFRESH_INTERVAL_MS, LIVE_REFRESH_MAX_INTERVAL_MS } from './useLiveRefresh';

interface Options {
  slug: string;
  /** The list says media is still processing and nothing else polls it. */
  enabled: boolean;
  /** What the loaded list holds. */
  loadedCount: number;
  loadedMaxId: number | null;
  /** Reloads the list. */
  onLanded: () => void;
}

// Issue 2274: a row that stays pending (a stuck worker) must not keep every
// open tab polling forever. Give up this long after the first "processing"
// answer; the next list fetch starts over. (No "N unchanged answers" rule: a
// long transcode leaves the numbers unchanged too.)
export const PROCESSING_POLL_DEADLINE_MS = 30 * 60_000;

const statusOf = (error: unknown) => (error as { response?: { status?: number } } | null)?.response?.status;

/**
 * Issue 2263: the guest list leaves out media the worker has not finished (a
 * video still being transcoded), so a gallery opened during an upload would
 * not show it until a manual reload. While the list says something is still
 * processing, this polls GET /:slug/photos/state (one aggregate, no rows) on
 * the live-refresh interval, only while the tab is visible, and reloads the
 * list when the numbers move or nothing is processing any more. The reloaded
 * list says whether to keep going.
 *
 * The state route answers 404 once nothing is processing on a gallery with
 * live refresh off, which is the same news. Any other failure backs off up to
 * the cap and stays silent.
 *
 * Bounded (issue 2274, see the deadline above). Once given up, it waits for
 * the next list fetch and returns true meanwhile, so live refresh can take
 * over.
 */
export function useProcessingRefresh({ slug, enabled, loadedCount, loadedMaxId, onLanded }: Options): boolean {
  const queryClient = useQueryClient();
  // Counts lists fetched from the server. Not dataUpdatedAt: a like or a
  // rating patches the cached rows (a manual success) and moves it too, which
  // would restart a poll that gave up (as in useLiveRefresh).
  const [listFetches, setListFetches] = useState(0);
  const latest = useRef({ loadedCount, loadedMaxId, listFetches, onLanded });
  latest.current = { loadedCount, loadedMaxId, listFetches, onLanded };
  // The list fetch the poll gave up on; a newer one resumes it.
  const [gaveUpOn, setGaveUpOn] = useState<number | null>(null);
  const halted = enabled && gaveUpOn === listFetches;

  useEffect(() => queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) return;
    const [scope, eventSlug] = event.query.queryKey as unknown[];
    if (scope === 'gallery-photos' && eventSlug === slug) setListFetches((n) => n + 1);
  }), [queryClient, slug]);

  useEffect(() => {
    if (!enabled || halted) return undefined;
    let since: number | null = null;
    let delay = LIVE_REFRESH_INTERVAL_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let stopped = false;
    const controller = new AbortController();

    const schedule = () => {
      if (stopped || timer || inFlight || document.hidden) return;
      timer = setTimeout(poll, delay);
    };
    const poll = async () => {
      timer = null;
      inFlight = true;
      try {
        const next = await galleryService.getPhotoState(slug, controller.signal);
        if (stopped) return;
        delay = LIVE_REFRESH_INTERVAL_MS;
        const { loadedCount: count, loadedMaxId: maxId } = latest.current;
        if (next.processing !== false) since ??= Date.now();
        if (next.processing === false || next.count !== count || (next.max_id ?? null) !== maxId) {
          latest.current.onLanded();
        }
      } catch (error) {
        if (stopped) return;
        if (statusOf(error) === 404) {
          latest.current.onLanded();
        } else {
          delay = Math.min(delay * 2, LIVE_REFRESH_MAX_INTERVAL_MS);
        }
      } finally {
        inFlight = false;
      }
      if (since !== null && Date.now() - since >= PROCESSING_POLL_DEADLINE_MS) {
        stopped = true;
        setGaveUpOn(latest.current.listFetches);
        return;
      }
      schedule();
    };
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
    // gaveUpOn too: a list that arrived while giving up resumes at once.
  }, [slug, enabled, halted, gaveUpOn]);

  return halted;
}
