import { useEffect, useState } from 'react';
import {
  HttpError,
  MAX_PENDING_POLLS,
  fetchImageBlob,
  isFinalStatus,
} from '../../../utils/authenticatedImageFetch';

/** Floor for the wait between asks, when the server names no Retry-After. */
const MIN_POLL_DELAY_MS = 2000;

/**
 * An object URL for `src` that follows a poster the server is still building
 * (issue 2275), for places that need a URL rather than an element: the
 * `<video poster>` of the lightbox player.
 *
 * Since issue 2263 a video thumbnail that is not built yet answers at once
 * with the placeholder, `X-Poster-Pending` and `Retry-After`. A plain
 * `poster={url}` never asks again, so it kept the placeholder until the
 * lightbox was reopened. This asks again on the same budget AuthenticatedImage
 * uses (MAX_PENDING_POLLS), only while the document is visible, and swaps in
 * the real poster when it comes. A final 4xx stops; a spent budget keeps the
 * stand-in. Undefined until the first answer; `src` itself when the first ask
 * fails, so the element tries as it did before.
 */
export function usePendingAwareImageUrl(
  src: string | null | undefined,
  { slug }: { slug?: string } = {},
): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    setUrl(undefined);
    if (!src) return undefined;

    let cancelled = false;
    let current: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onVisible: (() => void) | null = null;
    let polls = 0;
    const controller = new AbortController();

    const show = (blob: Blob) => {
      const next = URL.createObjectURL(blob);
      if (current) URL.revokeObjectURL(current);
      current = next;
      setUrl(next);
    };

    const askAgain = (delayMs: number) => {
      if (polls >= MAX_PENDING_POLLS) return;
      timer = setTimeout(function fire() {
        timer = null;
        if (cancelled) return;
        // A backgrounded tab asks when it comes back, not while it is away.
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          onVisible = () => {
            if (document.visibilityState === 'hidden') return;
            document.removeEventListener('visibilitychange', onVisible!);
            onVisible = null;
            if (!cancelled) fire();
          };
          document.addEventListener('visibilitychange', onVisible);
          return;
        }
        polls += 1;
        void load();
      }, Math.max(MIN_POLL_DELAY_MS, delayMs));
    };

    const load = async () => {
      try {
        const { blob, pendingMs } = await fetchImageBlob(src, {
          slug,
          signal: controller.signal,
          // The player is the slide being looked at.
          priority: 'high',
        });
        if (cancelled) return;
        show(blob);
        if (pendingMs !== null) askAgain(pendingMs);
      } catch (error) {
        if (cancelled) return;
        // Nothing fetched yet: hand the element the URL itself, as before.
        if (!current) {
          setUrl(src);
          return;
        }
        // Final for this URL: an expired token, a photo that is gone. The
        // stand-in stays.
        if (error instanceof HttpError && isFinalStatus(error.status)) return;
        askAgain(error instanceof HttpError ? error.retryAfterMs : 0);
      }
    };

    void load();

    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      if (onVisible) document.removeEventListener('visibilitychange', onVisible);
      if (current) URL.revokeObjectURL(current);
    };
  }, [src, slug]);

  return url;
}
