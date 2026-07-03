import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Download, Maximize2, Check, MessageSquare, Star, Heart } from 'lucide-react';
import { useTheme } from '../../../contexts/ThemeContext';
import { AuthenticatedImage } from '../../common';
import { FeedbackIdentityModal } from '../../gallery/FeedbackIdentityModal';
import { feedbackService } from '../../../services/feedback.service';
import { useGuestIdentityOptional } from '../../../contexts/GuestIdentityContext';
import {
  calculateJustifiedLayout,
  createJustifiedPhotos,
  type JustifiedLayoutItem,
} from '../../../utils/justifiedLayoutCalculator';
// Flickr's justified-layout library
import justifiedLayout from 'justified-layout';
import type { BaseGalleryLayoutProps } from './BaseGalleryLayout';
import type { Photo } from '../../../types';

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
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<null | { type: 'like'; photoId: number }>(null);
  const [savedIdentity, setSavedIdentity] = useState<{ name: string; email: string } | null>(null);
  const guestIdentity = useGuestIdentityOptional();

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
    <div
      className="photo-card relative group cursor-pointer transition-all duration-300 hover:scale-[1.02]"
      onClick={onClick}
      style={{
        ...style,
        height: `${imageHeight}px`,
        breakInside: 'avoid'
      }}
    >
      <AuthenticatedImage
        src={photo.thumbnail_url || photo.url}
        alt={photo.filename}
        className="w-full h-full object-cover rounded-lg"
        loading="lazy"
        isGallery={true}
        protectFromDownload={!allowDownloads}
      />
      
      {/* Feedback Indicators */}
      {feedbackEnabled && ((photo.comment_count ?? 0) > 0 || (photo.average_rating ?? 0) > 0 || (photo.like_count ?? 0) > 0) && (
        <div className="absolute top-2 left-2 flex gap-1 z-10">
          {(photo.comment_count ?? 0) > 0 && (
            <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1" title={`${photo.comment_count ?? 0} comments`}>
              <MessageSquare className="w-3.5 h-3.5 text-accent" fill="currentColor" />
              <span className="text-xs font-medium text-neutral-700">{photo.comment_count ?? 0}</span>
            </div>
          )}
          {(photo.average_rating ?? 0) > 0 && (
            <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1" title={`Rating: ${Number(photo.average_rating ?? 0).toFixed(1)}`}>
              <Star className="w-3.5 h-3.5 text-yellow-500" fill="currentColor" />
              <span className="text-xs font-medium text-neutral-700">{Number(photo.average_rating ?? 0).toFixed(1)}</span>
            </div>
          )}
          {(photo.like_count ?? 0) > 0 && (
            <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1" title={`${photo.like_count ?? 0} likes`}>
              <Heart className="w-3.5 h-3.5 text-red-500" fill="currentColor" />
              <span className="text-xs font-medium text-neutral-700">{photo.like_count ?? 0}</span>
            </div>
          )}
        </div>
      )}
      
      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-200 rounded-lg flex items-center justify-center gap-2">
        {!isSelectionMode && (
          <>
            <button
              className="p-2 bg-white/90 rounded-full hover:bg-white transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                onClick(e);
              }}
              aria-label="View full size"
            >
              <Maximize2 className="w-5 h-5 text-neutral-800" />
            </button>
            {allowDownloads && (
              <button
                className="p-2 bg-white/90 rounded-full hover:bg-white transition-colors"
                onClick={onDownload}
                aria-label="Download photo"
              >
                <Download className="w-5 h-5 text-neutral-800" />
              </button>
            )}
            {feedbackEnabled && feedbackOptions?.allowComments && onQuickComment && (
              <button
                className="p-2 bg-white/90 rounded-full hover:bg-white transition-colors"
                onClick={(e) => { e.stopPropagation(); onQuickComment(); }}
                aria-label="Comment on photo"
                title="Comment"
              >
                <MessageSquare className="w-5 h-5 text-neutral-800" />
              </button>
            )}
            {feedbackEnabled && feedbackOptions?.allowLikes && (
              <button
                className={`p-2 rounded-full transition-colors ${
                  liked
                    ? 'bg-red-500/90 hover:bg-red-500'
                    : 'bg-white/90 hover:bg-white'
                }`}
                onClick={async (e) => {
                  e.stopPropagation();
                  if (guestIdentity?.identityMode === 'guest') {
                    try {
                      await guestIdentity.ensureIdentity();
                    } catch {
                      return;
                    }
                    // Optimistic UI: mark as liked immediately
                    if (onLikeSuccess) onLikeSuccess();
                    try {
                      await feedbackService.submitFeedback(slug!, String(photo.id), {
                        feedback_type: 'like',
                      });
                    } catch (err) {
                      // eslint-disable-next-line no-console
                      console.warn('Like submit failed, keeping optimistic UI', err);
                    }
                    return;
                  }
                  if (feedbackOptions?.requireNameEmail && !savedIdentity) {
                    setPendingAction({ type: 'like', photoId: photo.id });
                    setShowIdentityModal(true);
                    return;
                  }
                  // Optimistic UI: mark as liked immediately
                  if (onLikeSuccess) onLikeSuccess();
                  try {
                    await feedbackService.submitFeedback(slug!, String(photo.id), {
                      feedback_type: 'like',
                      guest_name: savedIdentity?.name,
                      guest_email: savedIdentity?.email,
                    });
                  } catch (err) {
                    // eslint-disable-next-line no-console
                    console.warn('Like submit failed, keeping optimistic UI', err);
                  }
                }}
                aria-label={liked ? 'Unlike photo' : 'Like photo'}
                aria-pressed={liked}
                title={liked ? 'Unlike' : 'Like'}
              >
                <Heart
                  className={`w-5 h-5 ${liked ? 'text-white fill-white' : 'text-neutral-800'}`}
                />
              </button>
            )}
          </>
        )}
      </div>

      {/* Identity Modal */}
      <FeedbackIdentityModal
        isOpen={showIdentityModal}
        onClose={() => { setShowIdentityModal(false); setPendingAction(null); }}
        onSubmit={async (name, email) => {
          setSavedIdentity({ name, email });
          setShowIdentityModal(false);
          if (pendingAction) {
            if (pendingAction.type === 'like' && onLikeSuccess) {
              onLikeSuccess();
            }
            await feedbackService.submitFeedback(slug!, String(pendingAction.photoId), {
              feedback_type: pendingAction.type,
              guest_name: name,
              guest_email: email,
            });
            setPendingAction(null);
          }
        }}
        feedbackType="like"
      />

      {/* Selection Checkbox (visible on hover or when selected) */}
      <button
        type="button"
        aria-label={`Select ${photo.filename}`}
        role="checkbox"
        aria-checked={isSelected}
        data-testid={`gallery-photo-checkbox-${photo.id}`}
        className={`absolute top-2 right-2 z-20 transition-opacity ${
          isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
        onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
      >
        <div className={`w-6 h-6 rounded-full border-2 ${isSelected ? 'bg-accent-dark border-accent-dark' : 'bg-white/90 border-white'} flex items-center justify-center transition-colors`}>
          {isSelected && <Check className="w-4 h-4 text-white" />}
        </div>
      </button>

      {photo.type === 'collage' && (
        <div className="absolute bottom-2 left-2">
          <span className="px-2 py-1 bg-black/60 text-white text-xs rounded">
            Collage
          </span>
        </div>
      )}
    </div>
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
            <div
              key={photo.id}
              className="photo-card absolute group cursor-pointer transition-all duration-300 hover:z-10"
              style={{
                left: layoutItem.x,
                top: layoutItem.y,
                width: layoutItem.width,
                height: layoutItem.height,
              }}
              onClick={() => onPhotoClick(index)}
            >
              <AuthenticatedImage
                src={photo.thumbnail_url || photo.url}
                alt={photo.filename}
                className="w-full h-full object-cover rounded-lg transition-transform duration-300 group-hover:scale-[1.02]"
                loading="lazy"
                isGallery={true}
                protectFromDownload={!allowDownloads}
              />

              {/* Feedback Indicators */}
              {feedbackEnabled && ((photo.comment_count ?? 0) > 0 || (photo.average_rating ?? 0) > 0 || (photo.like_count ?? 0) > 0) && (
                <div className="absolute top-2 left-2 flex gap-1 z-10">
                  {(photo.comment_count ?? 0) > 0 && (
                    <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1">
                      <MessageSquare className="w-3.5 h-3.5 text-accent" fill="currentColor" />
                      <span className="text-xs font-medium text-neutral-700">{photo.comment_count ?? 0}</span>
                    </div>
                  )}
                  {(photo.average_rating ?? 0) > 0 && (
                    <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1">
                      <Star className="w-3.5 h-3.5 text-yellow-500" fill="currentColor" />
                      <span className="text-xs font-medium text-neutral-700">{Number(photo.average_rating ?? 0).toFixed(1)}</span>
                    </div>
                  )}
                  {(photo.like_count ?? 0) > 0 && (
                    <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1">
                      <Heart className="w-3.5 h-3.5 text-red-500" fill="currentColor" />
                      <span className="text-xs font-medium text-neutral-700">{photo.like_count ?? 0}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Hover overlay with actions */}
              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-200 rounded-lg flex items-center justify-center gap-2">
                {!isSelectionMode && (
                  <>
                    <button
                      type="button"
                      aria-label="View full size"
                      className="p-2 bg-white/20 hover:bg-white/40 rounded-full transition-colors"
                      onClick={(e) => { e.stopPropagation(); onPhotoClick(index); }}
                    >
                      <Maximize2 className="w-5 h-5 text-white" />
                    </button>
                    {allowDownloads && (
                      <button
                        type="button"
                        aria-label="Download photo"
                        className="p-2 bg-white/20 hover:bg-white/40 rounded-full transition-colors"
                        onClick={(e) => { e.stopPropagation(); onDownload(photo, e); }}
                      >
                        <Download className="w-5 h-5 text-white" />
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* Selection Checkbox */}
              <button
                type="button"
                aria-label={`Select ${photo.filename}`}
                role="checkbox"
                aria-checked={selectedPhotos.has(photo.id)}
                className={`absolute top-2 right-2 z-20 transition-opacity ${
                  selectedPhotos.has(photo.id) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
                onClick={(e) => { e.stopPropagation(); onPhotoSelect && onPhotoSelect(photo.id); }}
              >
                <div className={`w-6 h-6 rounded-full border-2 ${selectedPhotos.has(photo.id) ? 'bg-accent-dark border-accent-dark' : 'bg-white/90 border-white'} flex items-center justify-center transition-colors`}>
                  {selectedPhotos.has(photo.id) && <Check className="w-4 h-4 text-white" />}
                </div>
              </button>
            </div>
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
            <div
              key={photo.id}
              className="photo-card absolute group cursor-pointer transition-all duration-300 hover:z-10"
              style={{
                left: box.left,
                top: box.top,
                width: box.width,
                height: box.height,
              }}
              onClick={() => onPhotoClick(index)}
            >
              <AuthenticatedImage
                src={photo.thumbnail_url || photo.url}
                alt={photo.filename}
                className="w-full h-full object-cover rounded-lg transition-transform duration-300 group-hover:scale-[1.02]"
                loading="lazy"
                isGallery={true}
                protectFromDownload={!allowDownloads}
              />

              {/* Feedback Indicators */}
              {feedbackEnabled && ((photo.comment_count ?? 0) > 0 || (photo.average_rating ?? 0) > 0 || (photo.like_count ?? 0) > 0) && (
                <div className="absolute top-2 left-2 flex gap-1 z-10">
                  {(photo.comment_count ?? 0) > 0 && (
                    <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1">
                      <MessageSquare className="w-3.5 h-3.5 text-accent" fill="currentColor" />
                      <span className="text-xs font-medium text-neutral-700">{photo.comment_count ?? 0}</span>
                    </div>
                  )}
                  {(photo.average_rating ?? 0) > 0 && (
                    <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1">
                      <Star className="w-3.5 h-3.5 text-yellow-500" fill="currentColor" />
                      <span className="text-xs font-medium text-neutral-700">{Number(photo.average_rating ?? 0).toFixed(1)}</span>
                    </div>
                  )}
                  {(photo.like_count ?? 0) > 0 && (
                    <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1">
                      <Heart className="w-3.5 h-3.5 text-red-500" fill="currentColor" />
                      <span className="text-xs font-medium text-neutral-700">{photo.like_count ?? 0}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Hover overlay with actions */}
              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-200 rounded-lg flex items-center justify-center gap-2">
                {!isSelectionMode && (
                  <>
                    <button
                      type="button"
                      aria-label="View full size"
                      className="p-2 bg-white/20 hover:bg-white/40 rounded-full transition-colors"
                      onClick={(e) => { e.stopPropagation(); onPhotoClick(index); }}
                    >
                      <Maximize2 className="w-5 h-5 text-white" />
                    </button>
                    {allowDownloads && (
                      <button
                        type="button"
                        aria-label="Download photo"
                        className="p-2 bg-white/20 hover:bg-white/40 rounded-full transition-colors"
                        onClick={(e) => { e.stopPropagation(); onDownload(photo, e); }}
                      >
                        <Download className="w-5 h-5 text-white" />
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* Selection Checkbox */}
              <button
                type="button"
                aria-label={`Select ${photo.filename}`}
                role="checkbox"
                aria-checked={selectedPhotos.has(photo.id)}
                className={`absolute top-2 right-2 z-20 transition-opacity ${
                  selectedPhotos.has(photo.id) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
                onClick={(e) => { e.stopPropagation(); onPhotoSelect && onPhotoSelect(photo.id); }}
              >
                <div className={`w-6 h-6 rounded-full border-2 ${selectedPhotos.has(photo.id) ? 'bg-accent-dark border-accent-dark' : 'bg-white/90 border-white'} flex items-center justify-center transition-colors`}>
                  {selectedPhotos.has(photo.id) && <Check className="w-4 h-4 text-white" />}
                </div>
              </button>

              {photo.type === 'collage' && (
                <div className="absolute bottom-2 left-2">
                  <span className="px-2 py-1 bg-black/60 text-white text-xs rounded">Collage</span>
                </div>
              )}
            </div>
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
            <div
              key={photo.id}
              className={`photo-card group cursor-pointer relative overflow-hidden rounded-lg bg-neutral-100 ${spanClasses}`}
              onClick={() => onPhotoClick(index)}
            >
              <AuthenticatedImage
                src={photo.thumbnail_url || photo.url}
                alt={photo.filename}
                className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                loading="lazy"
                isGallery={true}
                protectFromDownload={!allowDownloads}
              />

              {/* Feedback Indicators */}
              {feedbackEnabled && ((photo.comment_count ?? 0) > 0 || (photo.average_rating ?? 0) > 0 || (photo.like_count ?? 0) > 0) && (
                <div className="absolute top-2 left-2 flex gap-1 z-10">
                  {(photo.comment_count ?? 0) > 0 && (
                    <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1">
                      <MessageSquare className="w-3.5 h-3.5 text-accent" fill="currentColor" />
                      <span className="text-xs font-medium text-neutral-700">{photo.comment_count ?? 0}</span>
                    </div>
                  )}
                  {(photo.average_rating ?? 0) > 0 && (
                    <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1">
                      <Star className="w-3.5 h-3.5 text-yellow-500" fill="currentColor" />
                      <span className="text-xs font-medium text-neutral-700">{Number(photo.average_rating ?? 0).toFixed(1)}</span>
                    </div>
                  )}
                  {(photo.like_count ?? 0) > 0 && (
                    <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1">
                      <Heart className="w-3.5 h-3.5 text-red-500" fill="currentColor" />
                      <span className="text-xs font-medium text-neutral-700">{photo.like_count ?? 0}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Hover overlay with actions */}
              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center gap-2">
                {!isSelectionMode && (
                  <>
                    <button
                      type="button"
                      aria-label="View full size"
                      className="p-2 bg-white/20 hover:bg-white/40 rounded-full transition-colors"
                      onClick={(e) => { e.stopPropagation(); onPhotoClick(index); }}
                    >
                      <Maximize2 className="w-5 h-5 text-white" />
                    </button>
                    {allowDownloads && (
                      <button
                        type="button"
                        aria-label="Download photo"
                        className="p-2 bg-white/20 hover:bg-white/40 rounded-full transition-colors"
                        onClick={(e) => { e.stopPropagation(); onDownload(photo, e); }}
                      >
                        <Download className="w-5 h-5 text-white" />
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* Selection Checkbox */}
              <button
                type="button"
                aria-label={`Select ${photo.filename}`}
                role="checkbox"
                aria-checked={selectedPhotos.has(photo.id)}
                className={`absolute top-2 right-2 z-20 transition-opacity ${
                  selectedPhotos.has(photo.id) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
                onClick={(e) => { e.stopPropagation(); onPhotoSelect && onPhotoSelect(photo.id); }}
              >
                <div className={`w-6 h-6 rounded-full border-2 ${selectedPhotos.has(photo.id) ? 'bg-accent-dark border-accent-dark' : 'bg-white/90 border-white'} flex items-center justify-center transition-colors`}>
                  {selectedPhotos.has(photo.id) && <Check className="w-4 h-4 text-white" />}
                </div>
              </button>

              {photo.type === 'collage' && (
                <div className="absolute bottom-2 left-2">
                  <span className="px-2 py-1 bg-black/60 text-white text-xs rounded">Collage</span>
                </div>
              )}
            </div>
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
