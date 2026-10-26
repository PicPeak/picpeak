import { buildResourceUrl } from './url';
import { withImageFetchSlot, type ImageFetchOptions } from './imageFetchQueue';
import {
  getActiveGallerySlug,
  getGalleryToken,
  inferGallerySlugFromLocation,
  resolveSlugFromRequestUrl,
} from './galleryAuthStorage';

/**
 * Fetching a gallery image with the gallery's credentials, shared by
 * AuthenticatedImage and usePendingAwareImageUrl (issue 2275): both read the
 * same X-Poster-Pending / Retry-After answer the same way.
 */

/**
 * Asks for a stand-in the server is still replacing (X-Poster-Pending), on a
 * budget of their own: a queued video poster can take a minute or two behind
 * other builds, longer than the failure retries last. At the server's 10 s
 * Retry-After this is two minutes; after it the stand-in stays.
 */
export const MAX_PENDING_POLLS = 12;

/** A non-OK response, with its status so the retry can tell transient from final. */
export class HttpError extends Error {
  status: number;
  /** Server-stated cooldown from `Retry-After`, in ms; 0 when absent. */
  retryAfterMs: number;
  constructor(status: number, statusText: string, retryAfter: string | null) {
    super(`Failed to fetch image: ${status} ${statusText}`);
    this.status = status;
    this.retryAfterMs = parseRetryAfter(retryAfter);
  }
}

/** `Retry-After` is either delay-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

/**
 * A 4xx other than 408 (timeout) and 429 (rate limited) is the server's final
 * answer for this URL — an expired gallery token, a missing photo — and asking
 * again cannot change it. Everything else (network failure, 5xx, aborts that
 * were not ours) may.
 */
export const isFinalStatus = (status: number) =>
  status >= 400 && status < 500 && status !== 408 && status !== 429;

/**
 * The image at `rawUrl` as a blob. `pendingMs` is set when the server
 * answered with a stand-in it is still replacing (X-Poster-Pending: a video
 * poster queued for a rebuild): the bytes are shown and the same URL is asked
 * again after Retry-After.
 */
export async function fetchImageBlob(
  rawUrl: string | undefined | null,
  { slug, signal, priority }: { slug?: string; signal?: AbortSignal; priority?: ImageFetchOptions['priority'] } = {},
): Promise<{ blob: Blob; pendingMs: number | null }> {
  if (!rawUrl) {
    throw new Error('No URL provided');
  }

  // Build full URL for the image. Only relative paths are app-owned;
  // an absolute URL is passed through untouched.
  const isRelative = rawUrl.startsWith('/');
  const fullImageUrl = rawUrl.startsWith('/admin')
    ? buildResourceUrl(`/api${rawUrl}`)
    : isRelative
      ? buildResourceUrl(rawUrl)
      : rawUrl;

  const headers: Record<string, string> = {};
  // Attach the gallery bearer token ONLY to relative (same-app) image
  // paths. Never send it to an absolute/external URL — that would leak
  // gallery credentials cross-origin. AuthenticatedImage does not
  // support external URLs by design.
  if (isRelative) {
    const slugForRequest = slug
      || resolveSlugFromRequestUrl(rawUrl)
      || getActiveGallerySlug()
      || inferGallerySlugFromLocation();
    const token = getGalleryToken(slugForRequest);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  // Queued (#1287). Without a cap, a 546-photo grid hands the browser
  // several hundred simultaneous fetches and some never come back —
  // pending forever, so nothing is logged and nothing is "failed".
  //
  // The BODY read has to happen inside the slot. `fetch` resolves as soon
  // as the headers arrive, so releasing there would free the slot while
  // the image bytes are still streaming on that connection — the cap
  // would bound header round-trips and nothing else, which is not the
  // workload that stalls a large gallery.
  return withImageFetchSlot(async () => {
    const response = await fetch(fullImageUrl, {
      credentials: 'include',
      headers: Object.keys(headers).length ? headers : undefined,
      signal,
    });

    if (!response.ok) {
      throw new HttpError(
        response.status,
        response.statusText,
        response.headers?.get?.('Retry-After') ?? null,
      );
    }

    const pending = response.headers?.get?.('X-Poster-Pending') === '1';
    return {
      blob: await response.blob(),
      pendingMs: pending ? parseRetryAfter(response.headers?.get?.('Retry-After') ?? null) : null,
    };
  }, { priority });
}
