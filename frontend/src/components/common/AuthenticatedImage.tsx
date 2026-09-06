import React, { useState, useEffect, useRef, useCallback } from 'react';
import { buildResourceUrl } from '../../utils/url';
import { withImageFetchSlot } from '../../utils/imageFetchQueue';
import {
  getActiveGallerySlug,
  getGalleryToken,
  inferGallerySlugFromLocation,
  resolveSlugFromRequestUrl,
} from '../../utils/galleryAuthStorage';

interface AuthenticatedImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'onLoad'> {
  src: string;
  fallbackSrc?: string;
  isGallery?: boolean;
  slug?: string;
  useCanvasRendering?: boolean;
  /** Fired when the canvas branch blocks a context-menu attempt. The only
   *  protection callback this component actually implements (#1297). */
  onProtectionViolation?: (violationType: string) => void;
  onLoad?: () => void;
  /**
   * Priority in the shared fetch queue (#1287). NOT the native `fetchPriority`
   * DOM attribute, which stays available on this component and takes
   * "low"|"high"|"auto" — hence the distinct name.
   *
   *   'high'     the image the user is looking at now (current lightbox slide)
   *   'prefetch' one interaction away (lightbox neighbours)
   *   'normal'   grid thumbnails
   */
  queuePriority?: 'high' | 'prefetch' | 'normal';
}

/**
 * Retry budget for a fetch that rejects (#1287). Three attempts with a
 * doubling delay — 2 s, 4 s, 8 s — and each one waits until the placeholder
 * is actually on screen and the document is visible before it fires.
 */
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

/** A non-OK response, with its status so the retry can tell transient from final. */
class HttpError extends Error {
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
function parseRetryAfter(value: string | null): number {
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
const isFinalStatus = (status: number) =>
  status >= 400 && status < 500 && status !== 408 && status !== 429;

/**
 * Fetches an image with the gallery's bearer token and renders it.
 *
 * IMAGE PROTECTION IS NOT IMPLEMENTED HERE (#1297). This component used to
 * accept the whole protection prop surface — protectFromDownload,
 * watermarkText, fragmentGrid, blockKeyboardShortcuts, detectPrintScreen,
 * detectDevTools, protectionLevel and the rest — and discard every one of
 * them in a `void unusedProps` block. Callers computed them from the event's
 * protection level and passed them in good faith, so raising that level
 * produced canvas rendering (via the layouts' own OR on
 * `protectionLevel === 'maximum'`) and nothing else it implies.
 *
 * They are removed rather than implemented, so the interface states what the
 * component actually does. The implementation those props describe already
 * exists in `ProtectedImage` — which is exported and currently rendered
 * nowhere. Wiring that in is a deliberate product decision about what
 * protection level should mean, not a silent side effect of a cleanup.
 *
 * Two props survive because they are real:
 *   useCanvasRendering    draws to a canvas instead of an <img>
 *   onProtectionViolation fires from the canvas context-menu handler below
 *
 * `useWatermark` was removed too. #1297 did not list it — it sat outside the
 * `unusedProps` block — but it was equally inert: declared, defaulted, never
 * read.
 */
export const AuthenticatedImage: React.FC<AuthenticatedImageProps> = ({
  src,
  fallbackSrc,
  alt,
  isGallery = false,
  slug,
  useCanvasRendering,
  onProtectionViolation,
  onLoad,
  queuePriority = 'normal',
  ...props
}) => {

  const [imageSrc, setImageSrc] = useState<string>('');
  const [error, setError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [canvasReady, setCanvasReady] = useState(false);
  const [canvasFailed, setCanvasFailed] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  // Retry state (#1287). The nonce is a dependency of the fetch effect, so
  // bumping it is the retry; the counter is per src, so a new image gets a
  // fresh budget without an extra effect run to reset it.
  const [retryNonce, setRetryNonce] = useState(0);
  const attemptsRef = useRef(0);
  // Cooldown the server asked for on the last failure (#1287). The backoff
  // alone would spend all three retries inside a 15-minute rate-limit window
  // and leave the tile blank after the limit had actually lifted.
  const retryAfterRef = useRef(0);
  const lastSrcRef = useRef<string | undefined>(undefined);
  const retryRef = useRef<HTMLDivElement | null>(null);

  // Draw image to canvas when canvas rendering is enabled
  // Returns whether the pixels actually made it onto the canvas, so the
  // caller knows if the source image is still needed (#1287).
  const drawToCanvas = useCallback(() => {
    if (!useCanvasRendering || !canvasRef.current || !imageRef.current) return false;

    const canvas = canvasRef.current;
    const img = imageRef.current;
    const ctx = canvas.getContext('2d');

    if (!ctx || !img.complete || img.naturalWidth === 0) return false;

    // Set canvas dimensions to match image
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;

    // Draw the image
    ctx.drawImage(img, 0, 0);

    setCanvasReady(true);
    return true;
  }, [useCanvasRendering]);

  useEffect(() => {
    let aborted = false;
    const objectUrls: string[] = [];
    // #1287 — the previous cleanup only set a flag. The request itself kept
    // running, holding a connection slot for a tile that is no longer on
    // screen, which on a several-hundred-photo gallery is most of them.
    const controller = new AbortController();

    if (lastSrcRef.current !== src) {
      lastSrcRef.current = src;
      attemptsRef.current = 0;
    }

    // Determine which token to use based on context
    if (!src) {
      setImageSrc(fallbackSrc || '');
      setError(false);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(false);
    setCanvasFailed(false);
    setCanvasReady(false);

    const resolveSlug = (candidateSrc?: string): string | null => {
      if (slug) {
        return slug;
      }
      const fromUrl = candidateSrc ? resolveSlugFromRequestUrl(candidateSrc) : null;
      if (fromUrl) {
        return fromUrl;
      }
      return getActiveGallerySlug() || inferGallerySlugFromLocation();
    };

    const fetchWithAuth = async (rawUrl: string | undefined | null): Promise<string> => {
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
        const slugForRequest = resolveSlug(rawUrl);
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
      const blob = await withImageFetchSlot(async () => {
        const response = await fetch(fullImageUrl, {
          credentials: 'include',
          headers: Object.keys(headers).length ? headers : undefined,
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new HttpError(
            response.status,
            response.statusText,
            response.headers?.get?.('Retry-After') ?? null,
          );
        }

        return await response.blob();
      }, { priority: queuePriority });
      const objectUrl = URL.createObjectURL(blob);
      // The effect may have been torn down while this was in flight. Revoke
      // immediately rather than pushing onto an array nobody will read again.
      if (aborted) {
        URL.revokeObjectURL(objectUrl);
        throw new Error('aborted');
      }
      objectUrls.push(objectUrl);
      return objectUrl;
    };

    const fetchImage = async () => {
      try {
        const primaryUrl = await fetchWithAuth(src);
        if (!aborted) {
          setImageSrc(primaryUrl);
          setError(false);
        }
      } catch (err) {
        // Torn down mid-flight (#1287): the abort is expected, not a failure.
        // Returning here also stops the fallback below from firing a second
        // request against an already-aborted signal.
        if (aborted) return;
        // A final 4xx exhausts the retry budget: on a 68-tile viewport, three
        // retries per tile against an expired token would be ~200 requests
        // that cannot succeed.
        if (err instanceof HttpError && isFinalStatus(err.status)) {
          attemptsRef.current = MAX_RETRIES;
        }
        retryAfterRef.current = err instanceof HttpError ? err.retryAfterMs : 0;
        setIsLoading(false);
        if (fallbackSrc && fallbackSrc !== src) {
          try {
            const fallbackUrl = await fetchWithAuth(fallbackSrc);
            if (!aborted) {
              setImageSrc(fallbackUrl);
              setError(false);
            }
            return;
          } catch (fallbackError) {
            // Swallow and mark error below
          }
        }
        if (!aborted) {
          setError(true);
          setImageSrc('');
        }
        return;
      }
      if (!aborted) {
        setIsLoading(false);
      }
    };

    fetchImage();

    // Cleanup function
    return () => {
      aborted = true;
      // Free the connection slot rather than leaving the request to run for
      // a tile that is gone (#1287).
      controller.abort();
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, fallbackSrc, slug, queuePriority, retryNonce]);

  // Retry a failed fetch once the tile is back on screen (#1287).
  //
  // Before this, a rejected fetch set `error` and nothing ever asked again:
  // the effect above only re-runs when its inputs change, and for a grid
  // tile they never do. On the original reporter's install that was the
  // difference between a transient failure and a permanently blank tile —
  // a hiccup on cellular, or Safari cancelling loads when the tab goes to
  // the background, left a tile with no image, no request in flight and
  // nothing in any log, for as long as the gallery stayed open. That is the
  // retry-on-scrolling-back-into-view the reporter asked for in the issue.
  //
  // Bounded, and gated on visibility. The delay doubles per attempt so a
  // server that is actually down is not hammered, and an attempt does not
  // fire until the placeholder intersects the viewport and the document is
  // visible — a tile that failed while backgrounded retries when the user
  // comes back, not while they are still away. Without IntersectionObserver
  // the placeholder counts as visible.
  const retryable = error && !fallbackSrc && attemptsRef.current < MAX_RETRIES;
  useEffect(() => {
    if (!retryable) return;
    const el = retryRef.current;
    if (!el) return;

    let cancelled = false;
    let delayElapsed = false;
    let onScreen = typeof IntersectionObserver === 'undefined';

    const retry = () => {
      if (cancelled || !delayElapsed || !onScreen) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      cancelled = true;
      attemptsRef.current += 1;
      setRetryNonce((n) => n + 1);
    };

    const timer = setTimeout(() => {
      delayElapsed = true;
      retry();
    }, Math.max(RETRY_BASE_DELAY_MS * 2 ** attemptsRef.current, retryAfterRef.current));

    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver((entries) => {
        onScreen = entries.some((entry) => entry.isIntersecting);
        retry();
      });
      observer.observe(el);
    }
    document.addEventListener('visibilitychange', retry);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      observer?.disconnect();
      document.removeEventListener('visibilitychange', retry);
    };
  }, [retryable, retryNonce]);

  // Effect to draw to canvas when image is loaded and canvas rendering is enabled
  useEffect(() => {
    if (!useCanvasRendering || !imageSrc) return;

    // Create a hidden image to load and then draw to canvas
    const img = new Image();
    // Only set crossOrigin for non-blob URLs (blob URLs are same-origin)
    // Setting crossOrigin on blob URLs can cause silent failures
    if (!imageSrc.startsWith('blob:')) {
      img.crossOrigin = 'anonymous';
    }

    img.onload = () => {
      imageRef.current = img;
      const drawn = drawToCanvas();
      // Once drawImage has copied the pixels into the canvas the source
      // decode is dead weight, so drop it here rather than at unmount. The
      // grid is not virtualised — a 546-photo event mounts 546 of these and
      // none of them unmount while the gallery is open — so a cleanup-only
      // release never actually runs for the case it was meant to fix
      // (#1287). Nothing redraws from `imageRef` afterwards: drawToCanvas
      // has this one caller.
      if (drawn) {
        // Handlers off BEFORE the src goes. Measured in Chromium and WebKit:
        // neither fires `error` when the attribute is removed after a
        // successful load, so this is not fixing an observed bug — but if any
        // engine ever did, `onerror` would set canvasFailed, swap the canvas
        // for a plain <img>, and decode the image a second time, which is the
        // exact opposite of what this release is for. The ordering is free.
        img.onload = null;
        img.onerror = null;
        imageRef.current = null;
        img.removeAttribute('src');
      }
      onLoad?.();
    };

    img.onerror = (e) => {
      // Fall back to regular img if canvas loading fails
      console.warn('Canvas image load failed, falling back to img tag:', e);
      setCanvasFailed(true);
    };

    img.src = imageSrc;

    return () => {
      img.onload = null;
      img.onerror = null;
      // Fallback release for the paths the onload handler above cannot
      // cover: the draw failed, or the source changed / the component
      // unmounted before onload ever fired. `imageRef` is what drawToCanvas
      // reads and it was never cleared, so a detached Image — and the decode
      // behind it — stayed pinned by a live JS reference. A decoded <img> in
      // the document is evictable under memory pressure; one held by a ref
      // is not.
      if (imageRef.current === img) {
        imageRef.current = null;
      }
      img.removeAttribute('src');
    };
  }, [imageSrc, useCanvasRendering, drawToCanvas, onLoad]);

  if (isLoading) {
    return (
      <div className={props.className} style={{ backgroundColor: '#f3f4f6', ...props.style }}>
        {/* Show a placeholder while loading */}
      </div>
    );
  }

  if (error && fallbackSrc) {
    return <img src={fallbackSrc} alt={alt} {...props} />;
  }

  if (error) {
    // Same box as the loading placeholder, and the element the retry effect
    // observes. Returning null here (as this used to) left nothing to watch
    // and nothing for the user to see either.
    return (
      <div ref={retryRef} className={props.className} style={{ backgroundColor: '#f3f4f6', ...props.style }} />
    );
  }

  if (!imageSrc) {
    return null;
  }

  // Canvas rendering mode - only if enabled and not failed
  if (useCanvasRendering && !canvasFailed) {
    return (
      <canvas
        ref={canvasRef}
        className={props.className}
        style={{
          ...props.style,
          // Hide canvas until it's ready to prevent flash
          opacity: canvasReady ? 1 : 0,
          transition: 'opacity 0.2s ease-in-out',
        }}
        // Prevent context menu on canvas
        onContextMenu={(e) => {
          e.preventDefault();
          onProtectionViolation?.('canvas_context_menu');
          return false;
        }}
        // Prevent drag
        onDragStart={(e) => {
          e.preventDefault();
          return false;
        }}
        aria-label={alt}
        role="img"
      />
    );
  }

  return <img src={imageSrc} alt={alt} onLoad={onLoad} {...props} />;
};
