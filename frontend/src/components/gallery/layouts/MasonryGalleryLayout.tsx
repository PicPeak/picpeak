import React, { useEffect, useRef, useState, useMemo } from 'react';
import { MessageSquare, Star, Heart } from 'lucide-react';
import { useTheme } from '../../../contexts/ThemeContext';
import { PhotoCard } from '../PhotoCard';
import {
  calculateJustifiedLayout,
  createJustifiedPhotos,
  type JustifiedLayoutItem,
} from '../../../utils/justifiedLayoutCalculator';
// Flickr's justified-layout library
import justifiedLayout from 'justified-layout';
import type { BaseGalleryLayoutProps } from './BaseGalleryLayout';
import type { Photo } from '../../../types';

// Count-style feedback indicators shared by all masonry modes (top-left).
// `withTitles` matches the columns-mode markup, which carries title attributes.
const FeedbackCountIndicators: React.FC<{ photo: Photo; withTitles?: boolean }> = ({ photo, withTitles = false }) => {
  if (!((photo.comment_count ?? 0) > 0 || (photo.average_rating ?? 0) > 0 || (photo.like_count ?? 0) > 0)) {
    return null;
  }
  return (
    <div className="absolute top-2 left-2 flex gap-1 z-10">
      {(photo.comment_count ?? 0) > 0 && (
        <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1" title={withTitles ? `${photo.comment_count ?? 0} comments` : undefined}>
          <MessageSquare className="w-3.5 h-3.5 text-accent" fill="currentColor" />
          <span className="text-xs font-medium text-neutral-700">{photo.comment_count ?? 0}</span>
        </div>
      )}
      {(photo.average_rating ?? 0) > 0 && (
        <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1" title={withTitles ? `Rating: ${Number(photo.average_rating ?? 0).toFixed(1)}` : undefined}>
          <Star className="w-3.5 h-3.5 text-yellow-500" fill="currentColor" />
          <span className="text-xs font-medium text-neutral-700">{Number(photo.average_rating ?? 0).toFixed(1)}</span>
        </div>
      )}
      {(photo.like_count ?? 0) > 0 && (
        <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1" title={withTitles ? `${photo.like_count ?? 0} likes` : undefined}>
          <Heart className="w-3.5 h-3.5 text-red-500" fill="currentColor" />
          <span className="text-xs font-medium text-neutral-700">{photo.like_count ?? 0}</span>
        </div>
      )}
    </div>
  );
};

interface MasonryPhotoProps {
  photo: Photo;
  isSelected: boolean;
  isSelectionMode: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDownload: (e: React.MouseEvent) => void;
  onToggleSelect: () => void;
  style?: React.CSSProperties;
  allowDownloads?: boolean;
  feedbackEnabled?: boolean;
  slug?: string;
  feedbackOptions?: {
    allowLikes?: boolean;
    allowComments?: boolean;
    requireNameEmail?: boolean;
  };
  onQuickComment?: () => void;
  // Column width for calculating proper aspect-ratio-based height
  columnWidth?: number;
  // Optimistic "I liked this" state + callback (lifted to parent)
  liked?: boolean;
  onLikeSuccess?: () => void;
}

const MasonryPhoto: React.FC<MasonryPhotoProps> = ({
  photo,
  isSelected,
  isSelectionMode,
  onClick,
  onDownload,
  onToggleSelect,
  style,
  allowDownloads = true,
  feedbackEnabled = false,
  slug,
  feedbackOptions,
  onQuickComment,
  columnWidth = 300,
  liked = false,
  onLikeSuccess,
}) => {
  // Calculate height based on actual photo aspect ratio
  // This preserves the photo's natural proportions in the masonry layout
  const imageHeight = useMemo(() => {
    const photoWidth = photo.width || 800;
    const photoHeight = photo.height || 600;
    const aspectRatio = photoWidth / photoHeight;

    // Calculate height based on column width and aspect ratio
    // Use dynamic constraints based on column width to preserve aspect ratio variation
    // This allows panoramic images to be short and tall portraits to be tall
    const calculatedHeight = columnWidth / aspectRatio;
    const minHeight = Math.max(80, columnWidth * 0.25); // Allow wide panoramics (4:1)
    const maxHeight = columnWidth * 2.5; // Allow tall portraits (1:2.5)

    return Math.max(minHeight, Math.min(maxHeight, calculatedHeight));
  }, [photo.width, photo.height, columnWidth]);

  return (
    <PhotoCard
      photo={photo}
      isSelected={isSelected}
      isSelectionMode={isSelectionMode}
      onClick={onClick}
      onDownload={onDownload}
      onToggleSelect={onToggleSelect}
      className="photo-card relative group cursor-pointer transition-all duration-300 hover:scale-[1.02]"
      style={{
        ...style,
        height: `${imageHeight}px`,
        breakInside: 'avoid'
      }}
      imageProps={{
        src: photo.thumbnail_url || photo.url,
        alt: photo.filename,
        className: 'w-full h-full object-cover rounded-lg',
        loading: 'lazy',
        isGallery: true,
        protectFromDownload: !allowDownloads,
      }}
      overlayBaseClassName="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-200 rounded-lg flex items-center justify-center gap-2"
      allowDownloads={allowDownloads}
      feedbackEnabled={feedbackEnabled}
      feedbackOptions={feedbackOptions}
      slug={slug}
      onQuickComment={onQuickComment}
      liked={liked}
      onLikeSuccess={onLikeSuccess}
      identityMode="self"
      likeToggleLabels
      checkboxTestId
      beforeOverlay={feedbackEnabled ? <FeedbackCountIndicators photo={photo} withTitles /> : undefined}
    >
      {photo.type === 'collage' && (
        <div className="absolute bottom-2 left-2">
          <span className="px-2 py-1 bg-black/60 text-white text-xs rounded">
            Collage
          </span>
        </div>
      )}
    </PhotoCard>
  );
};

export const MasonryGalleryLayout: React.FC<BaseGalleryLayoutProps> = ({
  photos,
  slug,
  onPhotoClick,
  onOpenPhotoWithFeedback,
  onDownload,
  selectedPhotos = new Set(),
  isSelectionMode = false,
  onPhotoSelect,
  allowDownloads = true,
  feedbackEnabled = false,
  feedbackOptions
}) => {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(3);
  const [containerWidth, setContainerWidth] = useState(0);
  // Optimistic "I liked this" state — lifted here so it survives re-renders
  // of individual MasonryPhoto components during layout reflow/resize.
  const [likedPhotoIds, setLikedPhotoIds] = useState<Set<number>>(new Set());
  // Seed from server is_liked on first non-empty photos payload (#590
  // follow-up). Mount-only: subsequent refetches don't clobber in-session
  // optimistic toggles, only the first arrival of photos initializes.
  const likedSeededRef = useRef(false);
  useEffect(() => {
    if (likedSeededRef.current || photos.length === 0) return;
    setLikedPhotoIds(new Set(photos.filter(p => p.is_liked).map(p => p.id)));
    likedSeededRef.current = true;
  }, [photos]);
  const gallerySettings = theme.gallerySettings || {};
  const gutter = gallerySettings.masonryGutter || 16;
  const mode = gallerySettings.masonryMode || 'columns';
  const targetRowHeight = gallerySettings.masonryRowHeight || 250;
  const lastRowBehavior = gallerySettings.masonryLastRowBehavior || 'left';
  const scale = gallerySettings.thumbnailScale || 'md';

  const scaleOffsets: Record<string, number> = { xs: 3, sm: 1, md: 0, lg: -1, xl: -2 };
  const applyScale = (cols: number) => Math.max(1, cols + (scaleOffsets[scale] ?? 0));

  // Apply scale to columns only in columns mode
  const scaledColumns = mode === 'columns' ? applyScale(columns) : columns;


  // Calculate number of columns based on container width (for columns mode)
  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        const width = containerRef.current.offsetWidth;
        setContainerWidth(width);
        if (width < 640) setColumns(2);
        else if (width < 1024) setColumns(3);
        else if (width < 1280) setColumns(4);
        else setColumns(5);
      }
    };

    updateDimensions();

    // Use ResizeObserver for better performance
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0) {
          setContainerWidth(entry.contentRect.width);
          const width = entry.contentRect.width;
          if (width < 640) setColumns(2);
          else if (width < 1024) setColumns(3);
          else if (width < 1280) setColumns(4);
          else setColumns(5);
        }
      }
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => resizeObserver.disconnect();
  }, []);

  // Calculate justified layout for rows mode
  const rowsLayout = useMemo(() => {
    if (mode !== 'rows' || containerWidth <= 0 || photos.length === 0) {
      return { items: [], containerHeight: 0, rowCount: 0 };
    }

    const justifiedPhotos = createJustifiedPhotos(
      photos.map((p) => ({
        id: p.id,
        width: p.width,
        height: p.height,
      }))
    );

    return calculateJustifiedLayout(justifiedPhotos, {
      containerWidth,
      targetRowHeight,
      spacing: gutter,
      lastRowBehavior,
    });
  }, [mode, photos, containerWidth, targetRowHeight, gutter, lastRowBehavior]);

  // Create a map for quick lookup of layout items by photo ID (rows mode)
  const layoutItemMap = useMemo(() => {
    const map = new Map<number, JustifiedLayoutItem>();
    for (const item of rowsLayout.items) {
      map.set(item.photoId, item);
    }
    return map;
  }, [rowsLayout.items]);

  // Calculate Flickr justified layout
  const flickrLayout = useMemo(() => {
    if (mode !== 'flickr' || containerWidth <= 0 || photos.length === 0) {
      return { containerHeight: 0, boxes: [] };
    }

    // Convert photos to aspect ratios array
    const aspectRatios = photos.map((p) => {
      if (p.width && p.height && p.width > 0 && p.height > 0) {
        return p.width / p.height;
      }
      return 1; // Default to square if no dimensions
    });

    const result = justifiedLayout(aspectRatios, {
      containerWidth,
      targetRowHeight,
      boxSpacing: gutter,
      containerPadding: 0,
      targetRowHeightTolerance: 0.25,
    });

    return result;
  }, [mode, photos, containerWidth, targetRowHeight, gutter]);

  // Distribute photos across columns using greedy "shortest column" algorithm
  // This creates a more balanced masonry layout instead of round-robin
  const photoColumns: Photo[][] = useMemo(() => {
    if (mode !== 'columns' || photos.length === 0) {
      return Array.from({ length: scaledColumns }, () => []);
    }

    const cols: Photo[][] = Array.from({ length: scaledColumns }, () => []);
    const colHeights: number[] = Array(scaledColumns).fill(0);

    // Calculate approximate column width for height estimation
    const approxColWidth = containerWidth > 0 ? (containerWidth - (scaledColumns - 1) * gutter) / scaledColumns : 300;

    photos.forEach((photo) => {
      // Find the shortest column
      let shortestCol = 0;
      let minHeight = colHeights[0];
      for (let i = 1; i < scaledColumns; i++) {
        if (colHeights[i] < minHeight) {
          minHeight = colHeights[i];
          shortestCol = i;
        }
      }

      // Add photo to shortest column
      cols[shortestCol].push(photo);

      // Estimate height based on aspect ratio (using same constraints as MasonryPhoto)
      const photoWidth = photo.width || 800;
      const photoHeight = photo.height || 600;
      const aspectRatio = photoWidth / photoHeight;
      const minHeightConstraint = Math.max(80, approxColWidth * 0.25);
      const maxHeightConstraint = approxColWidth * 2.5;
      const estimatedHeight = Math.max(minHeightConstraint, Math.min(maxHeightConstraint, approxColWidth / aspectRatio));
      colHeights[shortestCol] += estimatedHeight + gutter;
    });

    return cols;
  }, [mode, photos, scaledColumns, containerWidth, gutter]);

  // Calculate approximate column width for aspect ratio calculations
  const columnWidth = useMemo(() => {
    if (containerWidth <= 0 || scaledColumns <= 0) return 300;
    // Account for gaps between columns
    const totalGaps = (scaledColumns - 1) * gutter;
    return (containerWidth - totalGaps) / scaledColumns;
  }, [containerWidth, scaledColumns, gutter]);

  // ROWS MODE - Google Photos style justified layout
  if (mode === 'rows') {
    // Show loading state while measuring container width
    const isCalculating = containerWidth <= 0 || rowsLayout.items.length === 0;

    return (
      <div
        ref={containerRef}
        className="photo-grid relative"
        style={{
          height: isCalculating ? 'auto' : rowsLayout.containerHeight,
          minHeight: isCalculating ? 200 : undefined
        }}
      >
        {isCalculating ? (
          // Render a simple grid while calculating to get container width
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {photos.slice(0, 8).map((photo) => (
              <div key={photo.id} className="aspect-square bg-neutral-200 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : photos.map((photo, index) => {
          const layoutItem = layoutItemMap.get(photo.id);
          if (!layoutItem) return null;

          return (
            <PhotoCard
              key={photo.id}
              photo={photo}
              isSelected={selectedPhotos.has(photo.id)}
              isSelectionMode={isSelectionMode}
              onClick={() => onPhotoClick(index)}
              onDownload={(e) => onDownload(photo, e)}
              onToggleSelect={() => onPhotoSelect && onPhotoSelect(photo.id)}
              className="photo-card absolute group cursor-pointer transition-all duration-300 hover:z-10"
              style={{
                left: layoutItem.x,
                top: layoutItem.y,
                width: layoutItem.width,
                height: layoutItem.height,
              }}
              imageProps={{
                src: photo.thumbnail_url || photo.url,
                alt: photo.filename,
                className: 'w-full h-full object-cover rounded-lg transition-transform duration-300 group-hover:scale-[1.02]',
                loading: 'lazy',
                isGallery: true,
                protectFromDownload: !allowDownloads,
              }}
              overlayBaseClassName="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-200 rounded-lg flex items-center justify-center gap-2"
              actionVariant="dark"
              allowDownloads={allowDownloads}
              beforeOverlay={feedbackEnabled ? <FeedbackCountIndicators photo={photo} /> : undefined}
            />
          );
        })}
      </div>
    );
  }

  // FLICKR MODE - Flickr's justified-layout algorithm
  if (mode === 'flickr') {
    const isCalculating = containerWidth <= 0 || flickrLayout.boxes.length === 0;

    return (
      <div
        ref={containerRef}
        className="photo-grid relative"
        style={{
          height: isCalculating ? 'auto' : flickrLayout.containerHeight,
          minHeight: isCalculating ? 200 : undefined
        }}
      >
        {isCalculating ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {photos.slice(0, 8).map((photo) => (
              <div key={photo.id} className="aspect-square bg-neutral-200 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : photos.map((photo, index) => {
          const box = flickrLayout.boxes[index];
          if (!box) return null;

          return (
            <PhotoCard
              key={photo.id}
              photo={photo}
              isSelected={selectedPhotos.has(photo.id)}
              isSelectionMode={isSelectionMode}
              onClick={() => onPhotoClick(index)}
              onDownload={(e) => onDownload(photo, e)}
              onToggleSelect={() => onPhotoSelect && onPhotoSelect(photo.id)}
              className="photo-card absolute group cursor-pointer transition-all duration-300 hover:z-10"
              style={{
                left: box.left,
                top: box.top,
                width: box.width,
                height: box.height,
              }}
              imageProps={{
                src: photo.thumbnail_url || photo.url,
                alt: photo.filename,
                className: 'w-full h-full object-cover rounded-lg transition-transform duration-300 group-hover:scale-[1.02]',
                loading: 'lazy',
                isGallery: true,
                protectFromDownload: !allowDownloads,
              }}
              overlayBaseClassName="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-200 rounded-lg flex items-center justify-center gap-2"
              actionVariant="dark"
              allowDownloads={allowDownloads}
              beforeOverlay={feedbackEnabled ? <FeedbackCountIndicators photo={photo} /> : undefined}
            >
              {photo.type === 'collage' && (
                <div className="absolute bottom-2 left-2">
                  <span className="px-2 py-1 bg-black/60 text-white text-xs rounded">Collage</span>
                </div>
              )}
            </PhotoCard>
          );
        })}
      </div>
    );
  }

  // QUILTED MODE - Mixed sizes based on aspect ratio
  // Landscape photos span 2 columns, portrait photos span 2 rows
  if (mode === 'quilted') {
    // Determine grid span based on aspect ratio
    const getSpanClasses = (photo: Photo): string => {
      const width = photo.width || 800;
      const height = photo.height || 600;
      const ratio = width / height;

      // Very wide landscape (panoramic) - span 2 columns
      if (ratio > 1.5) return 'col-span-2';
      // Very tall portrait - span 2 rows
      if (ratio < 0.7) return 'row-span-2';
      // Normal aspect ratio - single cell
      return '';
    };

    return (
      <div
        ref={containerRef}
        className="photo-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gridAutoRows: '200px',
          gap: `${gutter}px`,
          gridAutoFlow: 'dense', // Fill gaps automatically
        }}
      >
        {photos.map((photo, index) => {
          const spanClasses = getSpanClasses(photo);

          return (
            <PhotoCard
              key={photo.id}
              photo={photo}
              isSelected={selectedPhotos.has(photo.id)}
              isSelectionMode={isSelectionMode}
              onClick={() => onPhotoClick(index)}
              onDownload={(e) => onDownload(photo, e)}
              onToggleSelect={() => onPhotoSelect && onPhotoSelect(photo.id)}
              className={`photo-card group cursor-pointer relative overflow-hidden rounded-lg bg-neutral-100 ${spanClasses}`}
              imageProps={{
                src: photo.thumbnail_url || photo.url,
                alt: photo.filename,
                className: 'w-full h-full object-cover transition-transform duration-300 group-hover:scale-105',
                loading: 'lazy',
                isGallery: true,
                protectFromDownload: !allowDownloads,
              }}
              overlayBaseClassName="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center gap-2"
              actionVariant="dark"
              allowDownloads={allowDownloads}
              beforeOverlay={feedbackEnabled ? <FeedbackCountIndicators photo={photo} /> : undefined}
            >
              {photo.type === 'collage' && (
                <div className="absolute bottom-2 left-2">
                  <span className="px-2 py-1 bg-black/60 text-white text-xs rounded">Collage</span>
                </div>
              )}
            </PhotoCard>
          );
        })}
      </div>
    );
  }

  // COLUMNS MODE - Pinterest style masonry (default)
  return (
    <div
      ref={containerRef}
      className="photo-grid flex gap-4"
      style={{ gap: `${gutter}px` }}
    >
      {photoColumns.map((column, columnIndex) => (
        <div
          key={columnIndex}
          className="flex-1 flex flex-col"
          style={{ gap: `${gutter}px` }}
        >
          {column.map((photo) => {
            const originalIndex = photos.findIndex(p => p.id === photo.id);
            return (
              <MasonryPhoto
                key={photo.id}
                photo={photo}
                isSelected={selectedPhotos.has(photo.id)}
                isSelectionMode={isSelectionMode}
                onClick={() => onPhotoClick(originalIndex)}
                onDownload={(e) => onDownload(photo, e)}
                onToggleSelect={() => onPhotoSelect && onPhotoSelect(photo.id)}
                allowDownloads={allowDownloads}
                feedbackEnabled={feedbackEnabled}
                slug={slug}
                feedbackOptions={feedbackOptions}
                onQuickComment={() => onOpenPhotoWithFeedback && onOpenPhotoWithFeedback(originalIndex)}
                columnWidth={columnWidth}
                liked={likedPhotoIds.has(photo.id)}
                onLikeSuccess={() => {
                  // Toggle, not add — the /feedback like endpoint toggles
                  // server-side, so click 2 on a liked photo unlikes it;
                  // the optimistic UI must follow suit (#590).
                  setLikedPhotoIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(photo.id)) next.delete(photo.id);
                    else next.add(photo.id);
                    return next;
                  });
                }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
};
