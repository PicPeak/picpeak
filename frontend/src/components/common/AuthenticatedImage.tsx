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

  // Draw image to canvas when canvas rendering is enabled
  const drawToCanvas = useCallback(() => {
    if (!useCanvasRendering || !canvasRef.current || !imageRef.current) return;

    const canvas = canvasRef.current;
    const img = imageRef.current;
    const ctx = canvas.getContext('2d');

    if (!ctx || !img.complete || img.naturalWidth === 0) return;

    // Set canvas dimensions to match image
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;

    // Draw the image
    ctx.drawImage(img, 0, 0);

    setCanvasReady(true);
  }, [useCanvasRendering]);

  useEffect(() => {
    let aborted = false;
    const objectUrls: string[] = [];
    // #1287 — the previous cleanup only set a flag. The request itself kept
    // running, holding a connection slot for a tile that is no longer on
    // screen, which on a several-hundred-photo gallery is most of them.
    const controller = new AbortController();

    // Determine which token to use based on context
    if (!src) {
      setImageSrc(fallbackSrc || '');
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
          throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
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
  }, [src, fallbackSrc, slug, queuePriority]);

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
      drawToCanvas();
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
