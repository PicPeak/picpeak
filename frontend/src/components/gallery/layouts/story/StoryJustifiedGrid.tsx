import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import justifiedLayout from 'justified-layout';
import { StoryPhotoCard } from './StoryPhotoCard';
import type { Photo } from '../../../../types';

interface StoryJustifiedGridProps {
  id: string;
  photos: Photo[];
  favorites: Set<number>;
  onToggleFavorite: (id: number) => void;
  onPhotoClick: (photo: Photo) => void;
  slug: string;
  allowDownloads?: boolean;
  useEnhancedProtection?: boolean;
  isSelectionMode?: boolean;
  selectedPhotos?: Set<number>;
  onPhotoSelect?: (id: number) => void;
  likesAllowed?: boolean;
}

/**
 * Aspect ratio from the stored dimensions; square when a photo has none, which
 * is the one case that still crops (the box cannot know the frame).
 */
export const storyPhotoAspectRatio = (photo: Pick<Photo, 'width' | 'height'>): number =>
  photo.width && photo.height && photo.width > 0 && photo.height > 0
    ? photo.width / photo.height
    : 1;

/**
 * Issue 1709: the Story grid used fixed-height cells with object-cover, which
 * cropped every portrait photo to a landscape tile. In `storyGridMode:
 * 'natural'` a scene is laid out as justified rows from the stored width and
 * height instead: each box has the photo's own aspect ratio, rows fill the
 * container width, and the boxes are positioned from the dimensions before
 * any image arrives, so nothing reflows while they load.
 */
export const StoryJustifiedGrid: React.FC<StoryJustifiedGridProps> = ({
  id,
  photos,
  favorites,
  onToggleFavorite,
  onPhotoClick,
  slug,
  allowDownloads = true,
  useEnhancedProtection = false,
  isSelectionMode = false,
  selectedPhotos,
  onPhotoSelect,
  likesAllowed = true,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // Measured before paint so the first frame already has the final boxes.
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    if (element.offsetWidth > 0) setContainerWidth(element.offsetWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0) setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => {
    if (containerWidth <= 0 || photos.length === 0) return null;
    // Same breakpoint as the fixed grid: one column of 300px rows on phones,
    // 400px rows from 768px up. The target is a little lower than the fixed
    // cell so a row of three landscape photos still fits a laptop width.
    const mobile = containerWidth < 768;
    return justifiedLayout(photos.map(storyPhotoAspectRatio), {
      containerWidth,
      targetRowHeight: mobile ? 260 : 360,
      targetRowHeightTolerance: 0.25,
      boxSpacing: mobile ? 4 : 16,
      containerPadding: 0,
    });
  }, [photos, containerWidth]);

  return (
    <div
      id={id}
      ref={containerRef}
      className="story-gallery-justified"
      style={{ height: layout ? layout.containerHeight : undefined }}
    >
      {layout && photos.map((photo, index) => {
        const box = layout.boxes[index];
        if (!box) return null;
        // justified-layout clamps a row that would be shorter than half or
        // taller than twice the target height (a lone panorama on a phone, a
        // lone tall portrait) and widens or narrows its boxes to fit, so the
        // box no longer has the photo's ratio. object-cover would crop exactly
        // there; contain keeps the photo whole on the card background instead.
        // An unclamped box keeps the ratio to floating-point precision (the
        // library never rounds per box), so anything past 0.1% is a clamp; a
        // clamp that small letterboxes by a fraction of a pixel, which is
        // invisible, while cropping by the same amount is not always.
        const ratio = storyPhotoAspectRatio(photo);
        const clamped = Math.abs(box.width / box.height - ratio) > ratio * 0.001;
        return (
          <div
            key={photo.id}
            className="story-gallery-justified-box"
            style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
          >
            <StoryPhotoCard
              photo={photo}
              index={index}
              isFavorite={favorites.has(photo.id)}
              onToggleFavorite={onToggleFavorite}
              onClick={() => onPhotoClick(photo)}
              slug={slug}
              galleryId={id}
              allowDownloads={allowDownloads}
              useEnhancedProtection={useEnhancedProtection}
              fit={clamped ? 'contain' : 'cover'}
              isSelectionMode={isSelectionMode}
              isSelected={selectedPhotos?.has(photo.id) ?? false}
              onSelect={onPhotoSelect}
              likesAllowed={likesAllowed}
            />
          </div>
        );
      })}
    </div>
  );
};
