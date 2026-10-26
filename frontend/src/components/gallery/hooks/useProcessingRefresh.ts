import { useEffect, useRef } from 'react';
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
 */
export function useProcessingRefresh({ slug, enabled, loadedCount, loadedMaxId, onLanded }: Options): void {
  const latest = useRef({ loadedCount, loadedMaxId, onLanded });
  latest.current = { loadedCount, loadedMaxId, onLanded };

  useEffect(() => {
    if (!enabled) return undefined;
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
  }, [slug, enabled]);
}
