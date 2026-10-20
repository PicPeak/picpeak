import React, { useEffect, useRef, useState, useMemo } from 'react';
import { MessageSquare, Star, Heart } from 'lucide-react';
import { useTheme } from '../../../contexts/ThemeContext';
import { PhotoCard } from '../PhotoCard';
import { firstLookAboveChips } from '../GalleryTileBadges';
import { ClientVisibilityToggle, isHiddenFromGuests } from '../ClientVisibilityToggle';
import {
  calculateJustifiedLayout,
  createJustifiedPhotos,
} from '../../../utils/justifiedLayoutCalculator';
// Flickr's justified-layout library
import justifiedLayout from 'justified-layout';
import type { BaseGalleryLayoutProps } from './BaseGalleryLayout';
import type { Photo } from '../../../types';
import { useLazyBands } from './lazyBands';
import { useWindowedItems, WINDOW_MIN_PHOTOS } from './rowWindow';
import { densityColumnDelta, densitySizeFactor, useGridDensity } from '../gridDensity';

// Count-style feedback indicators shared by all masonry modes (top-left).
// `withTitles` matches the columns-mode markup, which carries title attributes.
// `inline` drops the corner positioning: beside the client's visibility
// toggle they join PhotoCard's top-left row instead (issue 1992).
const FeedbackCountIndicators: React.FC<{ photo: Photo; withTitles?: boolean; inline?: boolean }> = ({ photo, withTitles = false, inline = false }) => {
  if (!((photo.comment_count ?? 0) > 0 || (photo.average_rating ?? 0) > 0 || (photo.like_count ?? 0) > 0)) {
    return null;
  }
  return (
    <div className={inline ? 'flex gap-1' : 'absolute top-2 left-2 flex gap-1 z-10'}>
      {(photo.comment_count ?? 0) > 0 && (
        <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1" title={withTitles ? `${photo.comment_count ?? 0} comments` : undefined}>
          <MessageSquare className="w-3.5 h-3.5 text-accent" fill="currentColor" />
          <span className="text-xs font-medium text-neutral-700">{photo.comment_count ?? 0}</span>
        </div>
      )}
      {(photo.average_rating ?? 0) > 0 && (
        <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1" title={withTitles ? `Rating: ${Number(photo.average_rating ?? 0).toFixed(1)}` : undefined}>
          <Star className="w-3.5 h-3.5 text-rating" fill="currentColor" />
          <span className="text-xs font-medium text-neutral-700">{Number(photo.average_rating ?? 0).toFixed(1)}</span>
        </div>
      )}
      {(photo.like_count ?? 0) > 0 && (
        <div className="bg-white/90 backdrop-blur-sm rounded-full px-2 py-1 flex items-center gap-1" title={withTitles ? `${photo.like_count ?? 0} likes` : undefined}>
          <Heart className="w-3.5 h-3.5 text-danger" fill="currentColor" />
          <span className="text-xs font-medium text-neutral-700">{photo.like_count ?? 0}</span>
        </div>
      )}
    </div>
  );
};

/** Four 36px action buttons (view, download, comment, like) and their three 8px gaps. */
const MIN_TILE_WIDTH_FOR_ACTION_ROW = 168;

// Who owns the tile's top-left corner. With the client's visibility toggle
// the count chips join its row, right of it and the colour-label dots
// (issue 1992); without it they keep the corner as before.
const cornerProps = (toggle: React.ReactNode, counts: React.ReactNode) => (toggle
  ? { topLeftControl: toggle, topLeftExtras: counts }
  : { beforeOverlay: counts });

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
    allowRatings?: boolean;
    allowComments?: boolean;
    requireNameEmail?: boolean;
  };
  /** One identity per viewer, held by the layout so no second tile asks again. */
  savedIdentity?: { name: string; email: string } | null;
  onIdentitySaved?: (identity: { name: string; email: string }) => void;
  onQuickComment?: () => void;
  onFeedbackChange?: (toggledPhotoId?: number) => void;
  // Column width for calculating proper aspect-ratio-based height
  columnWidth?: number;
  // Optimistic "I liked this" state + callback (lifted to parent)
  liked?: boolean;
  onLikeSuccess?: () => void;
  /** The client's hide/show button (issue 1992), when the viewer is the client. */
  visibilityToggle?: React.ReactNode;
  /** Dim the photo: the client hid it from guests. */
  dimmed?: boolean;
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
  onFeedbackChange,
  columnWidth = 300,
  liked = false,
  onLikeSuccess,
  savedIdentity,
  onIdentitySaved,
  visibilityToggle,
  dimmed = false,
}) => {
  const bands = useLazyBands();
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
      // The collage chip owns bottom-left (issue 1562).
      firstLookClassName={firstLookAboveChips(photo.type === 'collage' ? 1 : 0)}
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
      /*
       * Lazy, with Grid's bands (issue 1733). AuthenticatedImage fetches in an
       * effect the moment it mounts, so `loading: 'lazy'` below deferred
       * nothing: every tile entered the fetch queue on first render. The
       * explicit px height above holds the box with or without the image, so
       * a far-off tile can be released without reflowing the column.
       *
       * No `content-visibility` here, unlike the other masonry modes. It was
       * left out when this card rendered its FeedbackIdentityModal
       * (`identityMode="self"`) inline: layout containment would have made
       * the tile the containing block of that `position: fixed` modal. The
       * modal is portalled now, so that reason is gone; not revisited here.
       */
      lazy
      inViewRootMargin={bands.load}
      releaseRootMargin={bands.keep}
      // A released tile in this mode is not skipped by content-visibility
      // (see above), so its placeholder must not animate: the default
      // `.skeleton` is `animate-pulse`, and hundreds of far-off tiles would
      // keep the compositor busy for the life of the page (issue 1733).
      skeletonClassName="w-full h-full rounded-lg bg-border-token"
      imageProps={{
        src: photo.thumbnail_url || photo.url,
        alt: photo.filename,
        className: `w-full h-full object-cover rounded-lg${dimmed ? ' opacity-40' : ''}`,
        loading: 'lazy',
        isGallery: true,
      }}
      overlayBaseClassName="absolute inset-0 bg-black/40 transition-opacity duration-200 rounded-lg flex items-center justify-center gap-2"
      allowDownloads={allowDownloads}
      feedbackEnabled={feedbackEnabled}
      feedbackOptions={feedbackOptions}
      slug={slug}
      onQuickComment={onQuickComment}
      onFeedbackChange={onFeedbackChange}
      liked={liked}
      onLikeSuccess={onLikeSuccess}
      identityMode="self"
      savedIdentity={savedIdentity}
      onIdentitySaved={onIdentitySaved}
      likeToggleLabels
      checkboxTestId
      {...cornerProps(
        visibilityToggle,
        feedbackEnabled ? <FeedbackCountIndicators photo={photo} withTitles inline={Boolean(visibilityToggle)} /> : undefined,
      )}
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
  feedbackOptions,
  onFeedbackChange,
  isClient = false,
  onToggleVisibility,
}) => {
  const bands = useLazyBands();
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(3);
  const [containerWidth, setContainerWidth] = useState(0);
  // Optimistic "I liked this" state — lifted here so it survives re-renders
  // of individual MasonryPhoto components during layout reflow/resize.
  const [likedPhotoIds, setLikedPhotoIds] = useState<Set<number>>(new Set());
  // Likewise the identity a viewer typed into one tile's modal (like or
  // rating, issue 1733): every other tile reuses it instead of asking again.
  const [savedIdentity, setSavedIdentity] = useState<{ name: string; email: string } | null>(null);
  // Seed from server is_liked on first non-empty photos payload (#590
  // follow-up). Mount-only: subsequent refetches don't clobber in-session
  // optimistic toggles, only the first arrival of photos initializes.
  const likedSeededRef = useRef(false);
  useEffect(() => {
    if (likedSeededRef.current || photos.length === 0) return;
    setLikedPhotoIds(new Set(photos.filter(p => p.is_liked).map(p => p.id)));
    likedSeededRef.current = true;
  }, [photos]);
  // Toggle, not add — the /feedback like endpoint toggles server-side, so
  // click 2 on a liked photo unlikes it; the optimistic UI must follow suit
  // (#590).
  const toggleLiked = (photoId: number) => {
    setLikedPhotoIds((prev) => {
      const next = new Set(prev);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  };
  // The tile feedback wiring of columns mode (MasonryPhoto), for the PhotoCards
  // the rows, flickr and quilted modes render directly (issue 1733).
  // `tileWidth` is the layout's px width where it computes one: these modes
  // put a portrait next to a landscape at one row height, so a tile can be
  // narrower than the four action buttons. Such a tile wraps them onto a
  // second line, which is where the rating row would sit, so it leaves the
  // stars to the lightbox, as PhotoCard itself does on a short tile.
  const tileFeedbackProps = (photo: Photo, index: number, tileWidth?: number) => {
    const narrow = tileWidth !== undefined && tileWidth < MIN_TILE_WIDTH_FOR_ACTION_ROW;
    return {
      overlayBaseClassName: `absolute inset-0 bg-black/40 transition-opacity duration-200 rounded-lg flex items-center justify-center gap-2${narrow ? ' flex-wrap content-center' : ''}`,
      feedbackEnabled,
      feedbackOptions: narrow && feedbackOptions ? { ...feedbackOptions, allowRatings: false } : feedbackOptions,
      slug,
      onQuickComment: () => onOpenPhotoWithFeedback && onOpenPhotoWithFeedback(index),
      onFeedbackChange,
      liked: likedPhotoIds.has(photo.id),
      onLikeSuccess: () => toggleLiked(photo.id),
      identityMode: 'self' as const,
      savedIdentity,
      onIdentitySaved: setSavedIdentity,
      likeToggleLabels: true,
    };
  };
  // The client's per-photo hide/show button and dimmed hidden photos, as in
  // Grid (issue 1992). Every mode puts the button in the tile's top-left.
  const showVisibilityToggle = isClient && Boolean(onToggleVisibility);
  const visibilityToggle = (photo: Photo) => (isClient && onToggleVisibility
    ? <ClientVisibilityToggle photo={photo} onToggle={onToggleVisibility} />
    : null);
  const dimmed = (photo: Photo) => showVisibilityToggle && isHiddenFromGuests(photo);
  const dimClass = (photo: Photo) => (dimmed(photo) ? ' opacity-40' : '');
  const gallerySettings = theme.gallerySettings || {};
  const gutter = gallerySettings.masonryGutter || 16;
  // 'justified' is the picker's "Google Photos" option: the same justified rows.
  const storedMode = gallerySettings.masonryMode || 'columns';
  const mode = storedMode === 'justified' ? 'rows' : storedMode;
  // The viewer's density (issue 1733, E4): a column more or less in columns
  // mode, a shorter or taller row (or quilted cell) in the others.
  const density = useGridDensity();
  const sizeFactor = densitySizeFactor(density);
  const targetRowHeight = Math.round((gallerySettings.masonryRowHeight || 250) * sizeFactor);
  const quiltedCell = Math.round(200 * sizeFactor);
  const lastRowBehavior = gallerySettings.masonryLastRowBehavior || 'left';
  const scale = gallerySettings.thumbnailScale || 'md';

  const scaleOffsets: Record<string, number> = { xs: 3, sm: 1, md: 0, lg: -1, xl: -2 };
  const applyScale = (cols: number) => Math.max(1, cols + (scaleOffsets[scale] ?? 0) + densityColumnDelta(density));

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

  // Rows mode mounts only the rows near the viewport in a large gallery
  // (issue 1733); the other modes never have items here.
  const { visible: visibleRowItems } = useWindowedItems(
    containerRef,
    rowsLayout.items,
    containerWidth,
    mode === 'rows' && photos.length >= WINDOW_MIN_PHOTOS,
    targetRowHeight,
  );

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

  // Position of each photo in `photos`, which is what the lightbox indexes
  // by. Columns mode renders out of order, and a `findIndex` per tile made
  // every render of an N-photo gallery O(N²) (issue 1733).
  const photoIndexById = useMemo(() => {
    const map = new Map<number, number>();
    photos.forEach((photo, index) => map.set(photo.id, index));
    return map;
  }, [photos]);

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
              <div key={photo.id} className="aspect-square bg-border-token rounded-lg animate-pulse" />
            ))}
          </div>
        ) : visibleRowItems.map((layoutItem) => {
          const index = photoIndexById.get(layoutItem.photoId);
          if (index === undefined) return null;
          const photo = photos[index];

          return (
            <PhotoCard
              key={photo.id}
              firstLookClassName={firstLookAboveChips(photo.type === 'collage' ? 1 : 0)}
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
                // Issue 1733: the box is the layout's own px result, so a
                // skipped tile occupies exactly what a rendered one would.
                contentVisibility: 'auto',
                containIntrinsicSize: `${layoutItem.width}px ${layoutItem.height}px`,
              }}
              // Lazy mount + release with Grid's bands (issue 1733); the
              // absolute px box holds the tile either way.
              lazy
              inViewRootMargin={bands.load}
              releaseRootMargin={bands.keep}
              imageProps={{
                src: photo.thumbnail_url || photo.url,
                alt: photo.filename,
                className: `w-full h-full object-cover rounded-lg transition-transform duration-300 group-hover:scale-[1.02]${dimClass(photo)}`,
                loading: 'lazy',
                isGallery: true,
              }}
              actionVariant="dark"
              allowDownloads={allowDownloads}
              {...tileFeedbackProps(photo, index, layoutItem.width)}
              {...cornerProps(
                visibilityToggle(photo),
                feedbackEnabled ? <FeedbackCountIndicators photo={photo} inline={showVisibilityToggle} /> : undefined,
              )}
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
              <div key={photo.id} className="aspect-square bg-border-token rounded-lg animate-pulse" />
            ))}
          </div>
        ) : photos.map((photo, index) => {
          const box = flickrLayout.boxes[index];
          if (!box) return null;

          return (
            <PhotoCard
              key={photo.id}
              firstLookClassName={firstLookAboveChips(photo.type === 'collage' ? 1 : 0)}
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
                // Issue 1733, as in rows mode above.
                contentVisibility: 'auto',
                containIntrinsicSize: `${box.width}px ${box.height}px`,
              }}
              lazy
              inViewRootMargin={bands.load}
              releaseRootMargin={bands.keep}
              imageProps={{
                src: photo.thumbnail_url || photo.url,
                alt: photo.filename,
                className: `w-full h-full object-cover rounded-lg transition-transform duration-300 group-hover:scale-[1.02]${dimClass(photo)}`,
                loading: 'lazy',
                isGallery: true,
              }}
              actionVariant="dark"
              allowDownloads={allowDownloads}
              {...tileFeedbackProps(photo, index, box.width)}
              {...cornerProps(
                visibilityToggle(photo),
                feedbackEnabled ? <FeedbackCountIndicators photo={photo} inline={showVisibilityToggle} /> : undefined,
              )}
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
          gridTemplateColumns: `repeat(auto-fill, minmax(${quiltedCell}px, 1fr))`,
          gridAutoRows: `${quiltedCell}px`,
          gap: `${gutter}px`,
          gridAutoFlow: 'dense', // Fill gaps automatically
        }}
      >
        {photos.map((photo, index) => {
          const spanClasses = getSpanClasses(photo);

          return (
            <PhotoCard
              key={photo.id}
              firstLookClassName={firstLookAboveChips(photo.type === 'collage' ? 1 : 0)}
              photo={photo}
              isSelected={selectedPhotos.has(photo.id)}
              isSelectionMode={isSelectionMode}
              onClick={() => onPhotoClick(index)}
              onDownload={(e) => onDownload(photo, e)}
              onToggleSelect={() => onPhotoSelect && onPhotoSelect(photo.id)}
              className={`photo-card group cursor-pointer relative overflow-hidden rounded-lg bg-elevated ${spanClasses}`}
              // Issue 1733: the grid's fixed-height rows and the span classes size
              // the cell, not the image, so the box survives both a skipped
              // tile and a released one. No intrinsic size, as in Grid.
              style={{ contentVisibility: 'auto' }}
              lazy
              inViewRootMargin={bands.load}
              releaseRootMargin={bands.keep}
              imageProps={{
                src: photo.thumbnail_url || photo.url,
                alt: photo.filename,
                className: `w-full h-full object-cover transition-transform duration-300 group-hover:scale-105${dimClass(photo)}`,
                loading: 'lazy',
                isGallery: true,
              }}
              actionVariant="dark"
              allowDownloads={allowDownloads}
              {...tileFeedbackProps(photo, index)}
              // After the spread: the quilted cell clips with its own rounding.
              overlayBaseClassName="absolute inset-0 bg-black/40 transition-opacity duration-200 flex items-center justify-center gap-2"
              {...cornerProps(
                visibilityToggle(photo),
                feedbackEnabled ? <FeedbackCountIndicators photo={photo} inline={showVisibilityToggle} /> : undefined,
              )}
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
      {containerWidth === 0 ? (
        // Same gate the rows mode above already applies, for the same reason:
        // the column count starts at 3 and the greedy distribution runs with a
        // hardcoded 300px estimate until the container has been measured.
        // Mounting cards into that guess costs a full remount when it settles
        // — photos move to a different parent column, so React tears them down
        // — and since #1095 each mount picks a tier from its own width, the two
        // mounts request two DIFFERENT urls. On a 1440px desktop that was 45 of
        // 62 photos downloading twice, plus 17 left on the larger file.
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {photos.slice(0, 8).map((photo) => (
            <div key={photo.id} className="aspect-square bg-border-token rounded-lg animate-pulse" />
          ))}
        </div>
      ) : photoColumns.map((column, columnIndex) => (
        <div
          key={columnIndex}
          className="flex-1 flex flex-col"
          style={{ gap: `${gutter}px` }}
        >
          {column.map((photo) => {
            const originalIndex = photoIndexById.get(photo.id) ?? -1;
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
                onFeedbackChange={onFeedbackChange}
                columnWidth={columnWidth}
                savedIdentity={savedIdentity}
                onIdentitySaved={setSavedIdentity}
                liked={likedPhotoIds.has(photo.id)}
                onLikeSuccess={() => toggleLiked(photo.id)}
                visibilityToggle={visibilityToggle(photo)}
                dimmed={dimmed(photo)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
};
