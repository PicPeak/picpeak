import { useEffect, useState } from 'react';
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
  /** Changes whenever the list was reloaded (react-query's dataUpdatedAt). */
  listVersion: number;
}

/**
 * Live refresh (issue 1733, C5). Polls GET /:slug/photos/state while the tab
 * is visible and returns how many photos the server has beyond the loaded
 * list, for the "N new photos" pill. It never reloads anything itself.
 *
 * Any failure (429 included) doubles the interval up to the cap and stays
 * silent; the next success returns to the base interval.
 */
export function useLiveRefresh({ slug, enabled, loadedCount, loadedMaxId, listVersion }: Options): number {
  const [state, setState] = useState<{ count: number; max_id: number | null } | null>(null);

  // A reloaded list makes the last answer stale: it may count photos that
  // were deleted since, and the pill would outlive the click that cleared it.
  useEffect(() => { setState(null); }, [listVersion, slug]);

  useEffect(() => {
    if (!enabled) return undefined;
    let delay = LIVE_REFRESH_INTERVAL_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const controller = new AbortController();

    const schedule = () => {
      if (stopped || timer || document.hidden) return;
      timer = setTimeout(poll, delay);
    };
    const poll = async () => {
      try {
        const next = await galleryService.getPhotoState(slug, controller.signal);
        if (stopped) return;
        setState(next);
        delay = LIVE_REFRESH_INTERVAL_MS;
      } catch {
        delay = Math.min(delay * 2, LIVE_REFRESH_MAX_INTERVAL_MS);
      }
      timer = null;
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
