import React, { useState, useEffect, useRef, useCallback } from 'react';
import { buildResourceUrl } from '../../utils/url';
import {
  getActiveGallerySlug,
  getGalleryToken,
  inferGallerySlugFromLocation,
  resolveSlugFromRequestUrl,
} from '../../utils/galleryAuthStorage';

interface AuthenticatedImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'onLoad'> {
  src: string;
  fallbackSrc?: string;
  useWatermark?: boolean;
  isGallery?: boolean;
  protectFromDownload?: boolean;
  slug?: string;
  photoId?: number;
  requiresToken?: boolean;
  secureUrlTemplate?: string;
  downloadUrlTemplate?: string;
  onProtectionViolation?: (violationType: string) => void;
  watermarkText?: string;
  overlayProtection?: boolean;
  fragmentGrid?: boolean;
  scrambleFragments?: boolean;
  useCanvasRendering?: boolean;
  blockKeyboardShortcuts?: boolean;
  detectPrintScreen?: boolean;
  detectDevTools?: boolean;
  protectionLevel?: 'basic' | 'standard' | 'enhanced' | 'maximum';
  useEnhancedProtection?: boolean;
  onLoad?: () => void;
}

export const AuthenticatedImage: React.FC<AuthenticatedImageProps> = ({
  src,
  fallbackSrc,
  alt,
  useWatermark = false,
  isGallery = false,
  protectFromDownload,
  slug,
  photoId,
  requiresToken,
  secureUrlTemplate,
  downloadUrlTemplate,
  onProtectionViolation,
  watermarkText,
  overlayProtection,
  fragmentGrid,
  scrambleFragments,
  useCanvasRendering,
  blockKeyboardShortcuts,
  detectPrintScreen,
  detectDevTools,
  protectionLevel,
  useEnhancedProtection,
  onLoad,
  ...props
}) => {
  const unusedProps = {
    protectFromDownload,
    photoId,
    requiresToken,
    secureUrlTemplate,
    downloadUrlTemplate,
    onProtectionViolation,
    watermarkText,
    overlayProtection,
    fragmentGrid,
    scrambleFragments,
    blockKeyboardShortcuts,
    detectPrintScreen,
    detectDevTools,
    protectionLevel,
    useEnhancedProtection
  };
  void unusedProps;

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

      // Build full URL for the image
      const fullImageUrl = rawUrl.startsWith('/admin')
        ? buildResourceUrl(`/api${rawUrl}`)
        : rawUrl.startsWith('/')
          ? buildResourceUrl(rawUrl)
          : rawUrl;

      const headers: Record<string, string> = {};
      const slugForRequest = resolveSlug(rawUrl);
      const token = getGalleryToken(slugForRequest);
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(fullImageUrl, {
        credentials: 'include',
        headers: Object.keys(headers).length ? headers : undefined,
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
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
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, fallbackSrc, slug]);

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
