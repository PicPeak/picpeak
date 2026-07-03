import React, { useEffect, useState } from 'react';
import { buildResourceUrl } from '../../utils/url';
import {
  getActiveGallerySlug,
  getGalleryToken,
  inferGallerySlugFromLocation,
  resolveSlugFromRequestUrl,
} from '../../utils/galleryAuthStorage';

interface AuthenticatedVideoProps extends React.VideoHTMLAttributes<HTMLVideoElement> {
  src: string;
  fallbackSrc?: string;
  slug?: string;
}

export const AuthenticatedVideo: React.FC<AuthenticatedVideoProps> = ({
  src,
  fallbackSrc,
  slug,
  ...props
}) => {
  const [videoSrc, setVideoSrc] = useState<string>('');
  const [error, setError] = useState(false);

  useEffect(() => {
    let aborted = false;
    const objectUrls: string[] = [];

    if (!src) {
      setVideoSrc('');
      setError(true);
      return;
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

      const fullUrl = rawUrl.startsWith('/')
        ? buildResourceUrl(rawUrl)
        : rawUrl;

      const headers: Record<string, string> = {};
      const slugForRequest = resolveSlug(rawUrl);
      const token = getGalleryToken(slugForRequest);
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(fullUrl, {
        credentials: 'include',
        headers: Object.keys(headers).length ? headers : undefined,
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch media: ${response.status} ${response.statusText}`);
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      objectUrls.push(objectUrl);
      return objectUrl;
    };

    const load = async () => {
      try {
        const primaryUrl = await fetchWithAuth(src);
        if (!aborted) {
          setVideoSrc(primaryUrl);
          setError(false);
        }
      } catch (err) {
        if (fallbackSrc && fallbackSrc !== src) {
          try {
            const fallbackUrl = await fetchWithAuth(fallbackSrc);
            if (!aborted) {
              setVideoSrc(fallbackUrl);
              setError(false);
            }
            return;
          } catch (_) {
            // ignore and set error below
          }
        }
        if (!aborted) {
          setError(true);
          setVideoSrc('');
        }
      }
    };

    load();

    return () => {
      aborted = true;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, fallbackSrc, slug]);

  if (error || !videoSrc) {
    return null;
  }

  return (
    <video
      src={videoSrc}
      controls
      preload="metadata"
      {...props}
    />
  );
};
