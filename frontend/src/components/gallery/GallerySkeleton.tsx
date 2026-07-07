import React, { useEffect, useState } from 'react';
import { Skeleton, SkeletonGalleryGrid } from '../common';

/**
 * Loading placeholder shown while a gallery is resolving (slug → info →
 * auto-login → photos). The tile grid is delayed 300ms so fast loads
 * never flash an empty grid before the real photos render (#321 follow-up).
 */
export const GallerySkeleton: React.FC = () => {
  const [showGrid, setShowGrid] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShowGrid(true), 300);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--color-background, #fafafa)' }}>
      <header className="bg-surface border-b border-surface sticky top-0 z-40">
        <div className="container py-4">
          <div className="flex items-center justify-between">
            <div>
              <Skeleton height={32} width={200} className="mb-2" />
              <Skeleton height={20} width={300} />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton height={40} width={120} />
              <Skeleton height={40} width={100} />
            </div>
          </div>
        </div>
      </header>
      {showGrid && (
        <div className="container mt-6">
          <Skeleton height={80} className="mb-6" />
          <SkeletonGalleryGrid count={12} />
        </div>
      )}
    </div>
  );
};
