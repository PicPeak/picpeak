import React, { useEffect, useState } from 'react';
import { api } from '../../config/api';

interface AdminAuthenticatedVideoProps extends React.VideoHTMLAttributes<HTMLVideoElement> {
  src: string;
  fallback?: React.ReactNode;
}

export const AdminAuthenticatedVideo: React.FC<AdminAuthenticatedVideoProps> = ({
  src,
  fallback,
  ...props
}) => {
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    const loadVideo = async () => {
      try {
        setLoading(true);
        setError(false);
        setVideoSrc(null);

        const response = await api.get(src, { responseType: 'blob' });

        if (!cancelled) {
          objectUrl = URL.createObjectURL(response.data);
          setVideoSrc(objectUrl);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      }
    };

    if (src) {
      loadVideo();
    }

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [src]);

  if (loading) {
    return <div className="w-full h-full bg-neutral-200 animate-pulse" />;
  }

  if (error || !videoSrc) {
    return fallback ? (
      <>{fallback}</>
    ) : (
      <div className="w-full h-full bg-neutral-100 flex items-center justify-center text-neutral-400">
        <span className="text-xs">Failed to load</span>
      </div>
    );
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
