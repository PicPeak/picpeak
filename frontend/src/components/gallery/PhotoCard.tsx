import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Download, Maximize2, Check, MessageSquare, Heart, Loader2 } from 'lucide-react';
import { useInView } from 'react-intersection-observer';
import { AuthenticatedImage } from '../common';
import { thumbnailUrlForTile } from './imageTiers';
import { TileImage } from './TileImage';
import { FeedbackIdentityModal } from './FeedbackIdentityModal';
import { feedbackService } from '../../services/feedback.service';
import { feedbackLockKind } from '../../utils/feedbackLock';
import { ColorLabelBadge } from './ColorLabelBadge';
import { TileRating } from './TileRating';
import { FirstLookBadge, FolderHintPill } from './GalleryTileBadges';
import { usePhotoLabels } from './PhotoLabels';
import { useGuestIdentityOptional } from '../../contexts/GuestIdentityContext';
import { useDownloadQuota } from '../../contexts/DownloadQuotaContext';
import { downloadLimitReachedMessage } from '../../utils/downloadLimit';
import { useInputMode } from '../../hooks/useInputMode';
import { usePhotoDownloadPending, preparingDownloadMessage } from '../../hooks/usePhotoDownloadPending';
import { useGridDensity } from './gridDensity';
import { PhotoPurchaseBadge } from '../../features/photo-sales/PhotoPurchaseBadge';
import { usePhotoSales } from '../../features/photo-sales/PhotoSalesContext';
import type { Photo } from '../../types';

export /** Action buttons (36px) + gap + rating pill (28px); below this the row would overlap the buttons. */
const MIN_TILE_HEIGHT_FOR_RATING_ROW = 104;

interface PhotoCardFeedbackOptions {
  allowLikes?: boolean;
  allowFavorites?: boolean;
  allowRatings?: boolean;
  allowComments?: boolean;
  requireNameEmail?: boolean;
}

export interface PhotoCardProps {
  photo: Photo;
  isSelected: boolean;
  isSelectionMode: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDownload: (e: React.MouseEvent) => void;
  onToggleSelect: () => void;
  /** Full container className (layout-specific positioning/animation/rounding). */
  className: string;
  style?: React.CSSProperties;
  /** Extra attributes for the container div (e.g. role/tabIndex/onKeyDown). */
  containerProps?: React.HTMLAttributes<HTMLDivElement>;
  /** Props passed verbatim to AuthenticatedImage. */
  imageProps: React.ComponentProps<typeof AuthenticatedImage>;
  /** Lazy-render via IntersectionObserver with a skeleton placeholder. */
  lazy?: boolean;
  inViewRootMargin?: string;
  /**
   * Outer band, in `rootMargin` form. When set, a tile that leaves it is
   * unmounted again rather than kept for the life of the page (#1287). Opt-in
   * per layout: only a layout whose skeleton holds the tile's box can release
   * without reflowing. Since issue 1733 that is every grid layout — each one
   * sizes its tile from the stored dimensions (`aspect-square`, an explicit
   * `aspectRatio`, or a computed px box) rather than from the image.
   */
  releaseRootMargin?: string;
  skeletonClassName?: string;
  /** Keep container at opacity 0 until in view (only meaningful with `lazy`). */
  fadeInWhenVisible?: boolean;
  /**
   * Static overlay classes — positioning, backdrop, spacing. Visibility and
   * hit-testing are owned by this component for every layout (#1263), so a
   * layout must NOT pass its own `opacity-*` / `group-hover:*` here.
   */
  overlayBaseClassName: string;
  /** 'light' = white/90 buttons with dark icons; 'dark' = white/20 buttons with white icons. */
  actionVariant?: 'light' | 'dark';
  allowDownloads?: boolean;
  feedbackEnabled?: boolean;
  feedbackOptions?: PhotoCardFeedbackOptions;
  slug?: string;
  onQuickComment?: () => void;
  onFeedbackChange?: (toggledPhotoId?: number) => void;
  liked?: boolean;
  onLikeSuccess?: () => void;
  /** 'self': card owns the identity modal; 'parent': delegate via onRequireIdentity. */
  identityMode?: 'self' | 'parent';
  savedIdentity?: { name: string; email: string } | null;
  onRequireIdentity?: (action: 'like', photoId: number) => void;
  /** Identity collected by the tile's rating control; the layout stores it as savedIdentity. */
  onIdentitySaved?: (identity: { name: string; email: string }) => void;
  /** Use Like/Unlike toggle labels on the like button (Masonry columns). */
  likeToggleLabels?: boolean;
  /** Render the Like button before the Comment button (Mosaic/Timeline). */
  likeBeforeComment?: boolean;
  /** Render data-testid on the selection checkbox. */
  checkboxTestId?: boolean;
  /** Rendered between the image and the hover overlay. */
  beforeOverlay?: React.ReactNode;
  /** Rendered between the overlay and the selection checkbox. */
  afterOverlay?: React.ReactNode;
  /** Rendered after the selection checkbox. */
  children?: React.ReactNode;
  /**
   * Where the first-look pill sits (issue 1562). Bottom-left by default; a
   * layout that keeps its own chips in that corner lifts it above them.
   */
  firstLookClassName?: string;
  /**
   * A control that takes the tile's top-left corner: the client's visibility
   * toggle (issue 1992). The colour-label dots, which own that corner
   * otherwise, line up to its right in one row, followed by `topLeftExtras`.
   */
  topLeftControl?: React.ReactNode;
  /** Rendered last in the `topLeftControl` row (Masonry's count chips). */
  topLeftExtras?: React.ReactNode;
}

export const PhotoCard: React.FC<PhotoCardProps> = ({
  photo,
  isSelected,
  isSelectionMode,
  onClick,
  onDownload,
  onToggleSelect,
  className,
  style,
  containerProps,
  imageProps,
  lazy = false,
  inViewRootMargin,
  releaseRootMargin,
  skeletonClassName = 'skeleton bg-border-token w-full h-full rounded-lg',
  fadeInWhenVisible = false,
  overlayBaseClassName,
  actionVariant = 'light',
  allowDownloads = true,
  feedbackEnabled = false,
  feedbackOptions,
  slug,
  onQuickComment,
  onFeedbackChange,
  liked = false,
  onLikeSuccess,
  identityMode = 'parent',
  savedIdentity,
  onRequireIdentity,
  onIdentitySaved,
  likeToggleLabels = false,
  likeBeforeComment = false,
  checkboxTestId = false,
  beforeOverlay,
  afterOverlay,
  children,
  firstLookClassName = 'bottom-2 left-2',
  topLeftControl,
  topLeftExtras,
}) => {
  const guestIdentity = useGuestIdentityOptional();
  // Photo sales: in a priced gallery every photo is
  // delivered through the checkout, so the direct download button is hidden and the price chip is the single
  // entry point into the cart.
  const hideDownloadBySales = usePhotoSales().checkoutReady;
  // Download limit (issue 1560): shown as unavailable once nothing is left.
  // aria-disabled rather than disabled, so the click still reaches the
  // handler (which explains the refusal) instead of falling through to the
  // tile and opening the lightbox.
  const withinDownloadLimit = useDownloadQuota().canDownload(photo);
  // Issue 2043: while this photo's download is being prepared the button
  // spins, and the overlay stays up so a touch user sees it.
  const downloadPending = usePhotoDownloadPending(photo.id);
  const [overlayVisible, setOverlayVisible] = useState(false);
  // #1275 — the input in use right now, not what the device is capable of.
  // On a hybrid the two disagree, and acting on the device's primary pointer
  // handles one of its two inputs as if it were the other.
  const { t } = useTranslation();
  const isTouchDevice = useInputMode() === 'touch';
  const overlayTimeoutRef = useRef<number | null>(null);

  // Self-managed identity modal state (identityMode === 'self')
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<null | { type: 'like'; photoId: number }>(null);
  const [selfIdentity, setSelfIdentity] = useState<{ name: string; email: string } | null>(null);

  // Self mode still honours an identity the layout already holds (typed into
  // another tile), so one viewer is asked once per gallery, not once per card.
  const savedIdentityValue = identityMode === 'self' ? (selfIdentity ?? savedIdentity ?? null) : savedIdentity;

  const hideOverlay = useCallback(() => {
    if (overlayTimeoutRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(overlayTimeoutRef.current);
    }
    overlayTimeoutRef.current = null;
    setOverlayVisible(false);
  }, []);

  const showOverlayTemporarily = useCallback(() => {
    setOverlayVisible(true);
    if (overlayTimeoutRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(overlayTimeoutRef.current);
    }
    if (typeof window !== 'undefined') {
      overlayTimeoutRef.current = window.setTimeout(() => {
        overlayTimeoutRef.current = null;
        setOverlayVisible(false);
      }, 2500);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (overlayTimeoutRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(overlayTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (isSelectionMode) {
      hideOverlay();
    }
  }, [isSelectionMode, hideOverlay]);

  // Lazy loading with intersection observer.
  //
  // Two bands with a deliberate gap between them (#1287). The inner one, from
  // `inViewRootMargin`, decides when a tile starts loading. The outer one,
  // from `releaseRootMargin`, decides when it is far enough away to unmount —
  // and unmounting is the part that frees anything, because AuthenticatedImage
  // revokes its object URL and drops any protection canvas in its cleanup, and
  // neither is reclaimable while the tile stays mounted. On a 546-photo grid
  // the old latch meant every tile scrolled past was retained for the life of
  // the page, which is the memory profile iOS Safari discards a tab over.
  //
  // The gap between the bands is the hysteresis: a tile is not released until
  // it is well outside the band that would immediately reload it, so scrolling
  // back and forth across one edge cannot thrash. Without a release band the
  // observer keeps its original `triggerOnce` latch, so every other layout
  // behaves exactly as before.
  const releases = Boolean(lazy && releaseRootMargin);
  const { ref: loadBandRef, inView: withinLoadBand } = useInView({
    triggerOnce: !releases,
    threshold: 0.1,
    rootMargin: inViewRootMargin,
  });
  const { ref: keepBandRef, inView: withinKeepBand } = useInView({
    skip: !releases,
    threshold: 0,
    rootMargin: releaseRootMargin,
  });
  // The self-managed identity modal lives inside the released subtree and
  // does not lock page scrolling, so a tile that let go while the form was
  // open threw away a half-typed name and email (issue 1733). Hold it.
  const holdsModal = identityMode === 'self' && showIdentityModal;
  const [rendered, setRendered] = useState(false);
  useEffect(() => {
    if (!releases) return;
    if (withinLoadBand) setRendered(true);
    else if (!withinKeepBand && !holdsModal) setRendered(false);
  }, [releases, withinLoadBand, withinKeepBand, holdsModal]);
  const inView = !lazy || (releases ? rendered : withinLoadBand);

  // Tile width for the responsive tier (#1095), measured rather than inferred.
  // Measured for lazy and eager cards alike: Masonry and Timeline were eager
  // when this landed, and those are exactly the layouts a breakpoint guess
  // gets most wrong.
  //
  // Gated: the image is not rendered until this has run, so AuthenticatedImage
  // never mounts with a src it would have to replace. Attaching the observer
  // ref unconditionally instead would refetch every tile — React flushes
  // passive effects before the synchronous re-render a layout effect triggers,
  // so the fetch fires once with the fallback and again with the measurement.
  //
  // useLayoutEffect, so the extra commit lands before paint and the skeleton
  // branch below is never actually seen. One reflow per commit, not per card:
  // nothing writes to the DOM between the reads, so the browser batches them.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [tile, setTile] = useState<{ width: number | null } | null>(null);
  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (!lazy) return;
    loadBandRef(node);
    if (releases) keepBandRef(node);
  }, [loadBandRef, keepBandRef, lazy, releases]);

  // A layout that hands the card its px width (Masonry rows, Flickr) also
  // animates it (transition-all), so that target is read rather than where a
  // running transition happens to be — after the viewer's tile-size change
  // (issue 1733, E4), say, while the card comes into the load band.
  const targetWidth = typeof style?.width === 'number' ? style.width : null;
  useLayoutEffect(() => {
    if (!inView || tile) return;
    // 0 means not laid out (a hidden tab, say), not a 0px tile — null falls
    // back to the viewport estimate rather than pinning the smallest tier.
    setTile({ width: targetWidth || containerRef.current?.offsetWidth || null });
  }, [inView, tile, targetWidth]);

  // The viewer's tile size (issue 1733, E4) resizes mounted tiles in place.
  // A tile that grew is measured again so it moves up a tier; one that shrank
  // keeps the larger file it already has rather than fetching a smaller one.
  const density = useGridDensity();
  const measuredDensity = useRef(density);
  useLayoutEffect(() => {
    if (measuredDensity.current === density) return;
    measuredDensity.current = density;
    if (!tile?.width) return;
    const width = targetWidth ?? (containerRef.current?.offsetWidth || 0);
    if (width > tile.width) setTile({ width });
  }, [density, tile, targetWidth]);

  const showFeedbackActions = feedbackEnabled && Boolean(feedbackOptions);

  // The rating row needs its own band under the centred action buttons:
  // 36px of buttons, a gap, and a 28px pill. On a panoramic Mosaic/Masonry
  // tile shorter than that the row would sit on the buttons and take their
  // clicks, so it is withheld there (the lightbox still rates). Measured
  // with a ResizeObserver; where none exists (old WebView, jsdom) the row
  // stays, as it did before the measurement existed.
  const wantsRatingRow = showFeedbackActions && Boolean(feedbackOptions?.allowRatings) && Boolean(slug);
  const [tooShortForRating, setTooShortForRating] = useState(false);
  useEffect(() => {
    const node = containerRef.current;
    if (!wantsRatingRow || !node || typeof ResizeObserver === 'undefined') return undefined;
    const check = (height: number) => setTooShortForRating(height > 0 && height < MIN_TILE_HEIGHT_FOR_RATING_ROW);
    check(node.offsetHeight);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      check(entry?.contentRect?.height ?? node.offsetHeight);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [wantsRatingRow, inView]);

  // #1263 - opacity hides pixels, not hit-testing. An `opacity-0` control is
  // still tappable, and on a touchscreen (no hover) it is invisible for good,
  // so a tap in the middle of a tile silently downloaded or liked instead of
  // opening the photo. Every visibility toggle below therefore moves
  // pointer-events with it, in both the tap-to-reveal and the hover branch.
  //
  // The hover variants are emitted while a mouse is in use, and withheld while
  // a finger is. Not behind `md:`: width is the wrong proxy for hover, and a
  // mouse user with a window under 768px got no overlay at all. Not behind the
  // device's primary pointer either (#1275) — on a hybrid that answers for the
  // wrong input. Withholding them on touch is what the breakpoint was really
  // for, since :hover latches on a touchscreen once a tile has been tapped.
  const revealed = (visible: boolean) => {
    // A control reached by keyboard reveals its overlay: opacity-0 hides
    // pixels, not focus, so Tab landed on an invisible button (issue 2074).
    // :focus-visible, not :focus-within, so a mouse click leaves it hidden.
    // `has-` covers the overlay (a control inside it has focus), `focus-visible:`
    // the checkbox, which is itself the focused control.
    const base = visible
      ? 'opacity-100 pointer-events-auto'
      : 'opacity-0 pointer-events-none has-[:focus-visible]:opacity-100 has-[:focus-visible]:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto';
    return isTouchDevice
      ? base
      : `${base} group-hover:opacity-100 group-hover:pointer-events-auto`;
  };

  const overlayClassName = `${overlayBaseClassName} ${revealed(overlayVisible || (downloadPending && !isSelectionMode))}`;

  const checkboxVisibilityClass = revealed(
    isSelected || isSelectionMode || overlayVisible,
  );

  // The folder hint ("All photos", issue 1786) shares the top-right corner
  // with the checkbox, so it steps aside whenever the checkbox shows.
  const folderHintVisibilityClass = isSelected || isSelectionMode || overlayVisible
    ? 'opacity-0'
    : isTouchDevice
      ? 'opacity-100 group-has-[:focus-visible]:opacity-0'
      : 'opacity-100 group-hover:opacity-0 group-has-[:focus-visible]:opacity-0';

  const buttonType = actionVariant === 'dark' ? ('button' as const) : undefined;
  const actionButtonClass =
    actionVariant === 'dark'
      ? 'p-2 bg-white/20 hover:bg-white/40 rounded-full transition-colors'
      : 'p-2 bg-white/90 rounded-full hover:bg-white transition-colors';
  const actionIconClass = actionVariant === 'dark' ? 'w-5 h-5 text-white' : 'w-5 h-5 text-neutral-800';

  const handlePhotoClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Photo sales: cart controls let the click bubble to
    // Snipcart's document-level delegation; the tile must ignore those
    // clicks instead of opening the lightbox.
    if ((e.target as HTMLElement | null)?.closest?.('.snipcart-add-item, .snipcart-checkout')) {
      return;
    }
    if (isTouchDevice && !overlayVisible && !isSelectionMode) {
      e.preventDefault();
      e.stopPropagation();
      showOverlayTemporarily();
      return;
    }

    onClick(e);
    if (isTouchDevice) {
      hideOverlay();
    }
  };

  const handleLike = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (guestIdentity?.identityMode === 'guest') {
      try {
        await guestIdentity.ensureIdentity();
      } catch {
        hideOverlay();
        return;
      }
      // Optimistic UI: mark as liked immediately
      if (onLikeSuccess) onLikeSuccess();
      try {
        await feedbackService.submitFeedback(slug!, String(photo.id), {
          feedback_type: 'like',
        });
      } catch (err) {
        // Refused by a finished selection (issue 1733): nothing was written,
        // so the heart goes back. Any other failure keeps the optimistic UI.
        if (feedbackLockKind(err)) onLikeSuccess?.();
        else console.warn('Like submit failed, keeping optimistic UI', err);
      }
      if (onFeedbackChange) onFeedbackChange(photo.id);
      hideOverlay();
      return;
    }
    if (
      feedbackOptions?.requireNameEmail &&
      !savedIdentityValue &&
      (identityMode === 'self' || onRequireIdentity)
    ) {
      if (identityMode === 'self') {
        setPendingAction({ type: 'like', photoId: photo.id });
        setShowIdentityModal(true);
      } else if (onRequireIdentity) {
        onRequireIdentity('like', photo.id);
      }
      hideOverlay();
      return;
    }
    // Optimistic UI: mark as liked immediately
    if (onLikeSuccess) onLikeSuccess();
    try {
      await feedbackService.submitFeedback(slug!, String(photo.id), {
        feedback_type: 'like',
        guest_name: savedIdentityValue?.name,
        guest_email: savedIdentityValue?.email,
      });
    } catch (err) {
      // A locked pick goes back; otherwise keep the optimistic state, a
      // refresh will reconcile.
      if (feedbackLockKind(err)) onLikeSuccess?.();
      else console.warn('Like submit failed, keeping optimistic UI', err);
    }
    if (onFeedbackChange) onFeedbackChange(photo.id);
    hideOverlay();
  };

  const commentButton =
    showFeedbackActions && feedbackOptions?.allowComments && onQuickComment ? (
      <button
        className={actionButtonClass}
        onClick={(e) => {
          e.stopPropagation();
          onQuickComment();
          hideOverlay();
        }}
        aria-label={t('gallery.tile.commentOnPhoto', 'Comment on photo')}
        title={t('gallery.tile.comment', 'Comment')}
      >
        <MessageSquare className={actionIconClass} />
      </button>
    ) : null;

  const likeButton =
    showFeedbackActions && feedbackOptions?.allowLikes ? (
      <button
        className={`p-2 rounded-full transition-colors ${
          liked ? 'bg-danger hover:opacity-90' : 'bg-white/90 hover:bg-white'
        }`}
        onClick={handleLike}
        aria-label={likeToggleLabels && liked ? t('gallery.tile.unlikePhoto', 'Unlike photo') : t('gallery.tile.likePhoto', 'Like photo')}
        aria-pressed={liked}
        title={likeToggleLabels && liked ? t('gallery.tile.unlike', 'Unlike') : t('gallery.tile.like', 'Like')}
      >
        <Heart className={`w-5 h-5 ${liked ? 'text-white fill-white' : 'text-neutral-800'}`} />
      </button>
    ) : null;

  // Star rating on the tile (issue 1733, A3a). Its own row under the action
  // buttons rather than in them: five stars beside three or four round
  // buttons overflow a two-column phone tile, and the corners are already
  // taken (badge, checkbox, indicators, video chip). Absolute inside the
  // overlay, so it reveals and hides with it and inherits its hit-testing.
  // Just under the centre on a normal tile, but never past the bottom edge:
  // a panoramic Mosaic tile can be ~50px high and clips with overflow-hidden,
  // so the row stops one pill height above the bottom.
  const ratingRow =
    wantsRatingRow && !tooShortForRating && feedbackOptions?.allowRatings && slug ? (
      <div
        className="absolute inset-x-0 flex justify-center"
        style={{ top: 'min(calc(50% + 1.5rem), calc(100% - 1.75rem))' }}
      >
        <TileRating
          photo={photo}
          slug={slug}
          variant={actionVariant}
          requireNameEmail={feedbackOptions.requireNameEmail}
          savedIdentity={savedIdentityValue}
          onIdentitySaved={(identity) => {
            // One identity per viewer, not per tile: the like button on this
            // card and every other tile (through the layout) reuse it.
            if (identityMode === 'self') setSelfIdentity(identity);
            onIdentitySaved?.(identity);
          }}
          onDone={hideOverlay}
        />
      </div>
    ) : null;

  // Responsive grid tier (#1095). Applied here rather than in each layout
  // because six of the seven funnel their tile through this one image; the
  // seventh, Carousel, renders 80px filmstrip thumbs that the canonical 300
  // already covers at DPR 3.
  //
  // Only when the src IS the thumbnail route: layouts fall back to photo.url
  // when thumbnail_url is null, and ?w= on the original-photo route means
  // something else. Videos are excluded because their thumbnail is a poster
  // frame from the video pipeline — the tier route would hand the video file
  // itself to Sharp.
  const isVideo = photo.media_type === 'video' || photo.type === 'video';
  const tileSrc = !isVideo && photo.thumbnail_url && imageProps.src === photo.thumbnail_url
    ? (thumbnailUrlForTile(photo.thumbnail_url, photo, tile?.width) ?? imageProps.src)
    : imageProps.src;
  // Neutral photo labels (issue 1733, E6) replace the filename the layouts
  // pass as alt text, and the name in the checkbox's label.
  const photoLabels = usePhotoLabels();
  const tileAlt = typeof imageProps.alt === 'string' ? photoLabels.of(photo, imageProps.alt) : imageProps.alt;

  return (
    <div
      ref={setContainerRef}
      className={className}
      style={lazy ? { ...style, opacity: !inView && fadeInWhenVisible ? 0 : 1 } : style}
      onClick={handlePhotoClick}
      {...containerProps}
    >
      {inView && tile ? (
        <>
          {/* Inside the mounted branch on purpose: the blurred placeholder
              (issue 1733) is decoded only for tiles that are mounted, and
              goes with them when the release band lets a tile go. */}
          <TileImage {...imageProps} src={tileSrc} alt={tileAlt} thumbHash={photo.thumb_hash} />

          {/* The guest's own colour label (#1044) — visible without hovering
              or opening anything, which is the point: the client watches
              their selection progress across the grid. */}
          {topLeftControl ? (
            <>
              <ColorLabelBadge
                colorLabel={photo.my_color_label}
                otherColorLabels={photo.other_color_labels}
                decision={photo.my_decision}
                part="ring"
              />
              {/* The toggle takes the corner; the dots sit right of it, so
                  neither covers the other (issue 1992). */}
              <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5">
                {topLeftControl}
                <ColorLabelBadge
                  colorLabel={photo.my_color_label}
                  otherColorLabels={photo.other_color_labels}
                  decision={photo.my_decision}
                  part="dots"
                />
                {topLeftExtras}
              </div>
            </>
          ) : (
            <ColorLabelBadge
              colorLabel={photo.my_color_label}
              otherColorLabels={photo.other_color_labels}
              decision={photo.my_decision}
            />
          )}

          <FirstLookBadge photo={photo} className={firstLookClassName} />
          <FolderHintPill photo={photo} className={`top-2 right-2 ${folderHintVisibilityClass}`} />

          {beforeOverlay}

          {/* Photo sales: always-visible price chip; one
              tap puts the photo into the Snipcart cart. */}
          <PhotoPurchaseBadge photo={photo} />

          {/* Hover Overlay */}
          <div className={overlayClassName}>
            {!isSelectionMode && (
              <>
                <button
                  type={buttonType}
                  className={actionButtonClass}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClick(e);
                    hideOverlay();
                  }}
                  aria-label={t('gallery.tile.viewFullSize', 'View full size')}
                >
                  <Maximize2 className={actionIconClass} />
                </button>
                {allowDownloads && !hideDownloadBySales && (
                  <button
                    type={buttonType}
                    className={actionButtonClass}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDownload(e);
                      hideOverlay();
                    }}
                    aria-label={downloadPending ? preparingDownloadMessage() : t('gallery.tile.downloadPhoto', 'Download photo')}
                    aria-disabled={!withinDownloadLimit || downloadPending || undefined}
                    aria-busy={downloadPending || undefined}
                    title={withinDownloadLimit ? undefined : downloadLimitReachedMessage()}
                    style={withinDownloadLimit ? (downloadPending ? { cursor: 'wait' } : undefined) : { opacity: 0.5, cursor: 'not-allowed' }}
                  >
                    {downloadPending
                      ? <Loader2 className={`${actionIconClass} animate-spin`} aria-hidden="true" />
                      : <Download className={actionIconClass} />}
                  </button>
                )}
                {likeBeforeComment ? (
                  <>
                    {likeButton}
                    {commentButton}
                  </>
                ) : (
                  <>
                    {commentButton}
                    {likeButton}
                  </>
                )}
                {ratingRow}
              </>
            )}
          </div>

          {/* Identity Modal (self-managed mode). Portalled to the body, as
              TileRating's is: a tile with `content-visibility` (Masonry rows,
              flickr, quilted) is the containing block of a `position: fixed`
              descendant and clips it. React events still bubble through a
              portal, so the wrapper keeps a click in the form from reaching
              the tile and opening the photo. */}
          {identityMode === 'self' && showIdentityModal && createPortal(
            <div onClick={(e) => e.stopPropagation()}>
              <FeedbackIdentityModal
                isOpen
                onClose={() => { setShowIdentityModal(false); setPendingAction(null); }}
                onSubmit={async (name, email) => {
                  setSelfIdentity({ name, email });
                  onIdentitySaved?.({ name, email });
                  setShowIdentityModal(false);
                  if (pendingAction) {
                    if (pendingAction.type === 'like' && onLikeSuccess) {
                      onLikeSuccess();
                    }
                    try {
                      await feedbackService.submitFeedback(slug!, String(pendingAction.photoId), {
                        feedback_type: pendingAction.type,
                        guest_name: name,
                        guest_email: email,
                      });
                    } catch (err) {
                      // Refused by a finished selection: the heart goes back.
                      if (!feedbackLockKind(err)) throw err;
                      if (pendingAction.type === 'like') onLikeSuccess?.();
                    }
                    if (onFeedbackChange) onFeedbackChange(pendingAction.photoId);
                    setPendingAction(null);
                  }
                }}
                feedbackType="like"
              />
            </div>,
            document.body,
          )}

          {afterOverlay}

          {/* Selection Checkbox (visible on hover or when selected) */}
          <button
            type="button"
            aria-label={t('gallery.tile.selectPhoto', 'Select {{name}}', { name: photoLabels.of(photo, photo.filename) })}
            role="checkbox"
            aria-checked={isSelected}
            data-testid={checkboxTestId ? `gallery-photo-checkbox-${photo.id}` : undefined}
            className={`absolute top-2 right-2 z-20 transition-opacity ${checkboxVisibilityClass}`}
            onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
          >
            <div className={`w-6 h-6 rounded-full border-2 ${isSelected ? 'bg-accent-dark border-accent-dark' : 'bg-white/90 border-white'} flex items-center justify-center transition-colors`}>
              {isSelected && <Check className="w-4 h-4 text-white" />}
            </div>
          </button>

          {children}
        </>
      ) : (
        <div className={skeletonClassName} />
      )}
    </div>
  );
};
