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
  /** Dimensions of the loaded rendition, which can differ from the original. */
  onLoad?: (dimensions: { width: number; height: number }) => void;
  /**
   * Told whether `fallbackSrc` is what is on screen instead of `src`, when it
   * changes and when the callback is first handed over.
   */
  onFallbackChange?: (showsFallback: boolean) => void;
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
  /**
   * Retries before giving up, in place of the default three. Grid tiles ask
   * for two (issue 1733, E9) so a thumbnail that will not come settles on
   * its placeholder within seconds rather than a quarter of a minute.
   */
  maxRetries?: number;
  /**
   * Told whether the image has been given up on: every retry spent and no
   * fallback to show, so what is on screen is the empty box for good. Fired
   * when it changes and when the callback is first handed over.
   */
  onUnavailable?: (unavailable: boolean) => void;
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
  onFallbackChange,
  queuePriority = 'normal',
  maxRetries = MAX_RETRIES,
  onUnavailable,
  ...props
}) => {

  const [imageSrc, setImageSrc] = useState<string>('');
  const [error, setError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  // What is on screen is `fallbackSrc`, not `src`. Marked on the element as
  // data-fallback: a fallback thumbnail can be a centre crop, so anything
  // positioned relative to the whole picture must not trust it.
  const [showsFallback, setShowsFallback] = useState(false);
  // Either way the fallback gets on screen: fetched, or as a plain <img>.
  const fallbackShown = showsFallback || (error && !!fallbackSrc);
  const onFallbackChangeRef = useRef(onFallbackChange);
  onFallbackChangeRef.current = onFallbackChange;
  const reportsFallback = !!onFallbackChange;
  useEffect(() => {
    if (reportsFallback) onFallbackChangeRef.current?.(fallbackShown);
  }, [fallbackShown, reportsFallback]);
  const [canvasReady, setCanvasReady] = useState(false);
  const [canvasFailed, setCanvasFailed] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  // Release the backing store immediately when a lightbox slide stops being
  // a canvas, including when the carousel retains its detached DOM node.
  const setCanvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
    if (canvasRef.current && canvasRef.current !== canvas) {
      canvasRef.current.width = 0;
      canvasRef.current.height = 0;
    }
    canvasRef.current = canvas;
  }, []);
  // Retry state (#1287). The nonce is a dependency of the fetch effect, so
  // bumping it is the retry; the counter is per src, so a new image gets a
  // fresh budget without an extra effect run to reset it.
  const [retryNonce, setRetryNonce] = useState(0);
  const attemptsRef = useRef(0);
  // Read where the budget is spent, which includes a callback that must stay
  // stable (backToStandIn).
  const maxRetriesRef = useRef(maxRetries);
  maxRetriesRef.current = maxRetries;
  // Cooldown the server asked for on the last failure (#1287). The backoff
  // alone would spend all three retries inside a 15-minute rate-limit window
  // and leave the tile blank after the limit had actually lifted.
  const retryAfterRef = useRef(0);
  const lastSrcRef = useRef<string | undefined>(undefined);
  const retryRef = useRef<HTMLElement | null>(null);
  // The element the retry waits on, in state so the observer is bound again
  // when a render swaps it (<img> for <canvas>, or the reverse). `retryAtRef`
  // is when the pending retry is due, so rebinding does not restart its delay.
  const [retryEl, setRetryEl] = useState<HTMLElement | null>(null);
  const retryAtRef = useRef(0);
  // A fetch run is under way. A quiet retry behind a fallback changes nothing
  // on screen, so without this the next retry would be armed the moment the
  // current one starts instead of when it fails.
  const [fetching, setFetching] = useState(true);
  // The fallback shown in place of a `src` that failed for a reason a retry
  // can cure (issue 1936). The lightbox passes the thumbnail as fallback, so
  // a preview answered 503 while storage was briefly unreachable used to
  // stay a thumbnail for good. The stand-in stays on screen while `src` is
  // asked again; `standInUrlRef` keeps its blob alive across those runs,
  // which the per-run cleanup below would otherwise revoke.
  const [standIn, setStandIn] = useState(false);
  const standInUrlRef = useRef<string | null>(null);
  // Both fetches rejected (not a decode failure of a 200), with a fallback.
  const fetchFailedRef = useRef(false);
  const imageKeyRef = useRef<string | undefined>(undefined);
  // The retried `src` that took the stand-in's place and has yet to decode.
  const swappedInUrlRef = useRef<string | null>(null);
  const dropStandIn = useCallback(() => {
    if (standInUrlRef.current) URL.revokeObjectURL(standInUrlRef.current);
    standInUrlRef.current = null;
    swappedInUrlRef.current = null;
  }, []);
  useEffect(() => dropStandIn, [dropStandIn]);
  // A retried `src` that arrived is only known to be good once it decodes, so
  // the stand-in's blob outlives the swap: released when `src` has loaded,
  // put back on screen when it will not decode. That answer is final. Both
  // act only on the URL that was swapped in: a canvas decode of the previous
  // image can still report after the next image's stand-in has been fetched.
  const srcDecoded = useCallback((url: string) => {
    if (swappedInUrlRef.current === url) dropStandIn();
  }, [dropStandIn]);
  const backToStandIn = useCallback((url: string) => {
    const kept = standInUrlRef.current;
    if (!kept || swappedInUrlRef.current !== url) return false;
    swappedInUrlRef.current = null;
    // The bytes that would not decode are of no further use.
    URL.revokeObjectURL(url);
    attemptsRef.current = maxRetriesRef.current;
    setStandIn(true);
    setImageSrc(kept);
    setCanvasFailed(false);
    setCanvasReady(false);
    return true;
  }, []);
  // Read at enqueue time, never a dependency of the fetch effect (#1734).
  // The lightbox keeps a slide's element across navigation and only flips
  // this prop when the slide moves between neighbour and current; as a
  // dependency that flip tore the effect down — aborting the in-flight
  // request or revoking the loaded blob — and fetched the same image again,
  // which threw away exactly the prefetch the tiers exist for.
  const queuePriorityRef = useRef(queuePriority);
  queuePriorityRef.current = queuePriority;

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
    // A retry of the same image that has a fallback on screen keeps showing
    // it; anything else starts from the loading placeholder.
    const imageKey = `${src ?? ''}\n${fallbackSrc ?? ''}\n${slug ?? ''}`;
    const sameImage = imageKeyRef.current === imageKey;
    imageKeyRef.current = imageKey;
    if (!sameImage) {
      dropStandIn();
      setStandIn(false);
      fetchFailedRef.current = false;
    }
    const quietRetry = sameImage && Boolean(fallbackSrc) && (standInUrlRef.current !== null || fetchFailedRef.current);

    // Determine which token to use based on context
    if (!src) {
      setImageSrc(fallbackSrc || '');
      setShowsFallback(!!fallbackSrc);
      setError(false);
      setIsLoading(false);
      setFetching(false);
      return;
    }

    setFetching(true);
    if (!quietRetry) {
      setIsLoading(true);
      setError(false);
      setCanvasFailed(false);
      setCanvasReady(false);
    }

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
      }, { priority: queuePriorityRef.current });
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
          setShowsFallback(false);
          setError(false);
          fetchFailedRef.current = false;
          if (standInUrlRef.current) {
            // The canvas keeps the stand-in's pixels, and stays visible,
            // until the new image has been drawn over them.
            swappedInUrlRef.current = primaryUrl;
            setStandIn(false);
            setCanvasFailed(false);
          }
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
          attemptsRef.current = maxRetriesRef.current;
        }
        retryAfterRef.current = err instanceof HttpError ? err.retryAfterMs : 0;
        setIsLoading(false);
        // The stand-in from an earlier attempt is still on screen: keep it.
        if (standInUrlRef.current) return;
        if (fallbackSrc && fallbackSrc !== src) {
          try {
            const fallbackUrl = await fetchWithAuth(fallbackSrc);
            if (!aborted) {
              // Out of this run's list: it has to outlive the run's cleanup
              // for as long as it stands in (dropStandIn revokes it).
              objectUrls.splice(objectUrls.indexOf(fallbackUrl), 1);
              standInUrlRef.current = fallbackUrl;
              setStandIn(true);
              setImageSrc(fallbackUrl);
              setShowsFallback(true);
              setError(false);
            }
            return;
          } catch (fallbackError) {
            // Swallow and mark error below. The retry asks for both again,
            // so it waits out the longer of the two cooldowns.
            if (fallbackError instanceof HttpError) {
              retryAfterRef.current = Math.max(retryAfterRef.current, fallbackError.retryAfterMs);
            }
          }
          if (!aborted) fetchFailedRef.current = true;
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

    fetchImage().finally(() => {
      if (!aborted) setFetching(false);
    });

    // Cleanup function
    return () => {
      aborted = true;
      // Free the connection slot rather than leaving the request to run for
      // a tile that is gone (#1287).
      controller.abort();
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [src, fallbackSrc, slug, retryNonce, dropStandIn]);

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
  // With a fallback the retry is for `src` behind it: while the fallback
  // stands in, or when both fetches were rejected. A fallback shown because
  // a 200 would not decode is final, as before.
  const retryable = (standIn || (error && (!fallbackSrc || fetchFailedRef.current)))
    && !fetching && attemptsRef.current < maxRetries;
  // Given up (issue 1733, E9): the box stays empty and nothing will ask
  // again until `src` changes or the tile is remounted. With a fallback the
  // fallback is what is on screen, so that is not this state.
  const unavailable = error && !fallbackSrc && !fetching && attemptsRef.current >= maxRetries;
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;
  const reportsUnavailable = !!onUnavailable;
  useEffect(() => {
    if (reportsUnavailable) onUnavailableRef.current?.(unavailable);
  }, [unavailable, reportsUnavailable]);
  // After every render, because which element is in the document is decided
  // by the render itself. Set only when it changed: an unchanged value still
  // costs a render, on every tile of a grid where nothing failed. A
  // stand-in drawn to a canvas has no retryRef: the canvas ref has to stay
  // the one stable callback, or every render would release its pixels.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const next = retryable ? retryRef.current ?? canvasRef.current : null;
    if (next !== retryEl) setRetryEl(next);
  });
  useEffect(() => {
    if (!retryable) {
      retryAtRef.current = 0;
      return;
    }
    const el = retryEl;
    if (!el) return;
    // Armed once per failure, with what that failure said: the attempt count
    // and the server's cooldown are both final by the time `fetching` clears.
    if (!retryAtRef.current) {
      retryAtRef.current = Date.now()
        + Math.max(RETRY_BASE_DELAY_MS * 2 ** attemptsRef.current, retryAfterRef.current);
    }

    let cancelled = false;
    let delayElapsed = false;
    let onScreen = typeof IntersectionObserver === 'undefined';

    const retry = () => {
      if (cancelled || !delayElapsed || !onScreen) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      cancelled = true;
      attemptsRef.current += 1;
      // In the same render as the spent attempt: otherwise the last retry
      // reads as given up (the previous error, no fetch yet) for one commit
      // before the fetch effect marks it in flight.
      setFetching(true);
      setRetryNonce((n) => n + 1);
    };

    const timer = setTimeout(() => {
      delayElapsed = true;
      retry();
    }, Math.max(0, retryAtRef.current - Date.now()));

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
  }, [retryable, retryEl]);

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
      const dimensions = { width: img.naturalWidth, height: img.naturalHeight };
      const drawn = drawToCanvas();
      srcDecoded(imageSrc);
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
      onLoad?.(dimensions);
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
  }, [imageSrc, useCanvasRendering, drawToCanvas, onLoad, srcDecoded]);

  if (isLoading) {
    return (
      <div className={props.className} style={{ backgroundColor: '#f3f4f6', ...props.style }}>
        {/* Show a placeholder while loading */}
      </div>
    );
  }

  if (error && fallbackSrc) {
    return <img ref={(el) => { retryRef.current = el; }} src={fallbackSrc} alt={alt} data-fallback="true" {...props} />;
  }

  if (error) {
    // Same box as the loading placeholder, and the element the retry effect
    // observes. Returning null here (as this used to) left nothing to watch
    // and nothing for the user to see either.
    return (
      <div ref={(el) => { retryRef.current = el; }} className={props.className} style={{ backgroundColor: '#f3f4f6', ...props.style }} />
    );
  }

  if (!imageSrc) {
    return null;
  }

  // Canvas rendering mode - only if enabled and not failed
  if (useCanvasRendering && !canvasFailed) {
    return (
      <canvas
        ref={setCanvasRef}
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
        data-fallback={showsFallback ? 'true' : undefined}
      />
    );
  }

  // onError as well as the fetch catch. A derivative that is present but
  // undecodable - a truncated write, or an original a browser cannot render -
  // comes back as HTTP 200, so the fetch succeeds and only the decode fails.
  // Without this the tile silently shows nothing and the fallback never runs.
  return (
    <img
      ref={(el) => { if (standIn) retryRef.current = el; }}
      src={imageSrc}
      alt={alt}
      data-fallback={showsFallback ? 'true' : undefined}
      onLoad={(event) => {
        srcDecoded(imageSrc);
        onLoad?.({
          width: event.currentTarget.naturalWidth,
          height: event.currentTarget.naturalHeight,
        });
      }}
      {...props}
      onError={(e) => {
        if (!backToStandIn(imageSrc)) setError(true);
        props.onError?.(e);
      }}
    />
  );
};
