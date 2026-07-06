import React, { useState, useEffect } from 'react';
import { api } from '../../config/api';

interface AdminAuthenticatedImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string;
  fallback?: React.ReactNode;
}

export const AdminAuthenticatedImage: React.FC<AdminAuthenticatedImageProps> = ({
  src,
  fallback,
  alt,
  ...props
}) => {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    const loadImage = async () => {
      try {
        setLoading(true);
        setError(false);
        setImageSrc(null);

        // Make authenticated request to get the image
        const response = await api.get(src, {
          responseType: 'blob',
        });

        if (!cancelled) {
          // Create object URL from blob
          objectUrl = URL.createObjectURL(response.data);
          setImageSrc(objectUrl);
          setLoading(false);
        }
      } catch {
        // Image loading failed - handled by error state
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      }
    };

    if (src) {
      loadImage();
    }

    // Cleanup function
    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [src]);

  if (loading) {
    return (
      <div className="w-full h-full bg-neutral-200 animate-pulse" />
    );
  }

  if (error) {
    return fallback ? (
      <>{fallback}</>
    ) : (
      <div className="w-full h-full bg-neutral-100 flex items-center justify-center text-neutral-400">
        <span className="text-xs">Failed to load</span>
      </div>
    );
  }

  return <img src={imageSrc || ''} alt={alt} {...props} />;
};
