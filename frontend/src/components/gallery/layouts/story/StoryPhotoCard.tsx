import React, { useRef, useState } from 'react';
import { motion, useInView } from 'framer-motion';
import { Heart, Check } from 'lucide-react';
import { ColorLabelBadge } from '../../ColorLabelBadge';
import { FirstLookBadge } from '../../GalleryTileBadges';
import { ClientVisibilityToggle, isHiddenFromGuests } from '../../ClientVisibilityToggle';
import type { Photo } from '../../../../types';
import { lightboxImageUrl } from '../../imageTiers';
import { TileImage } from '../../TileImage';
import { usePhotoLabels } from '../../PhotoLabels';

interface StoryPhotoCardProps {
  photo: Photo;
  index: number;
  isFavorite: boolean;
  onToggleFavorite: (id: number) => void;
  onClick?: () => void;
  slug: string;
  allowDownloads?: boolean;
  useEnhancedProtection?: boolean;
  featured?: boolean;
  galleryId: string;
  /**
   * Issue 1709: 'contain' when the box could not take the photo's own aspect
   * ratio (justified-layout clamps a lone very wide or very tall row), so the
   * photo is letterboxed on the card background instead of cropped.
   */
  fit?: 'cover' | 'contain';
  /** Issue 1716: selection mode. The checkbox shows while selecting or when selected. */
  isSelectionMode?: boolean;
  isSelected?: boolean;
  onSelect?: (id: number) => void;
  /** Likes are a per-event sub-toggle (#506); the heart is not offered when they are off. */
  likesAllowed?: boolean;
  /** The client's hide/show handler (issue 1992); set only for the client. */
  onToggleVisibility?: (photoId: number, currentVisibility: string) => void;
  /**
   * The filename caption on hover: 'none' (the default), the stored
   * `filename`, or the uploaded `original_filename` when the gallery shows
   * original filenames (#508), as the lightbox does.
   */
  caption?: StoryCaptionMode;
}

export type StoryCaptionMode = 'none' | 'filename' | 'original';

export const StoryPhotoCard: React.FC<StoryPhotoCardProps> = ({
  photo,
  index,
  isFavorite,
  onToggleFavorite,
  onClick,
  slug,
  featured = false,
  fit = 'cover',
  isSelectionMode = false,
  isSelected = false,
  onSelect,
  likesAllowed = true,
  onToggleVisibility,
  caption = 'none',
  galleryId: _galleryId
}) => {
  // galleryId is kept for potential PhotoSwipe integration but not currently used
  void _galleryId;
  const [isLoaded, setIsLoaded] = useState(false);

  // Don't fetch until the card is near the viewport (#1166).
  //
  // Every card in a Story gallery mounts at page load — `whileInView` gates the
  // ANIMATION, not the render — and AuthenticatedImage fetches from an effect
  // on mount, so all of them requested at once. That was tolerable while they
  // pointed at `photo.url`, because nothing was generated; pointing them at
  // the preview tier means a gallery with cold previews would Sharp-decode
  // every original in one burst.
  //
  // `once` so a card that has loaded never unloads on scroll-away, and the
  // same 200px margin the entrance animation uses so the image is already in
  // flight by the time the card animates in.
  const cardRef = useRef<HTMLDivElement>(null);
  const isNearViewport = useInView(cardRef, { once: true, margin: '200px' });

  // Under neutral photo labels (issue 1733, E6) the caption, alt text and
  // checkbox name read "Photo 12 of 84" instead of a filename.
  const photoLabels = usePhotoLabels();
  const captionText = caption === 'none'
    ? null
    : photoLabels.of(photo, caption === 'original'
      ? (photo.original_filename || photo.filename)
      : photo.filename);

  return (
    <motion.div
      ref={cardRef}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-50px' }}
      transition={{ delay: Math.min(index * 0.05, 0.3) }}
      // The fit rides on the card, not the img: `.story-photo-card img` in the
      // stylesheet outranks a Tailwind utility on the image itself.
      className={`story-photo-card group ${featured ? 'story-gallery-grid-featured' : ''}${fit === 'contain' ? ' story-photo-card--contain' : ''}${isSelectionMode ? ' story-photo-card--selecting' : ''}${isSelected ? ' selected' : ''}`}
      data-selected={isSelected ? 'true' : undefined}
    >
      <a
        href={photo.url}
        // PhotoSwipe's full-size source (#1166). The preview tier, like every
        // other lightbox surface — the original is what Download hands out,
        // not what gets rendered on screen.
        data-pswp-src={lightboxImageUrl(photo)}
        data-pswp-width={photo.width || 1200}
        data-pswp-height={photo.height || 800}
        data-photo-id={photo.id}
        onClick={(e) => {
          // While selecting, the whole card toggles the selection instead of
          // opening the lightbox (issue 1716).
          if (isSelectionMode && onSelect) {
            e.preventDefault();
            onSelect(photo.id);
            return;
          }
          if (onClick) {
            e.preventDefault();
            onClick();
          }
        }}
        aria-pressed={isSelectionMode ? isSelected : undefined}
        // Dimmed when the client hid it from guests, as in Grid (issue 1992).
        className={`block w-full h-full${onToggleVisibility && isHiddenFromGuests(photo) ? ' opacity-40' : ''}`}
      >
        {/* The placeholder keeps the card's box while the image is still
            out of range, so nothing reflows when it arrives. */}
        {!isNearViewport ? (
          <div className="w-full h-full bg-elevated" aria-hidden="true" />
        ) : (
        <TileImage
          // Blurred placeholder (issue 1733) until the preview is in. Not for
          // a letterboxed card: the placeholder covers the box and the photo
          // would not. It fades over the image's own 0.7s entrance, and
          // eases in: the image eases out underneath, so the placeholder
          // holds while the image is still faint and the card background
          // never shows through by more than a tenth (a plain ease let a
          // quarter through mid-fade).
          thumbHash={fit === 'cover' ? photo.thumb_hash : null}
          placeholderFadeClassName="duration-700 ease-in"
          // A card tile, and it used to render the full ORIGINAL at
          // object-cover — the one place where the reporter's "hundreds of
          // megabytes for a gallery" was literally true (#1166).
          //
          // The preview tier rather than the thumbnail, deliberately.
          // thumbnail_fit is seeded to 'cover' on every install, so thumbnails
          // are square centre-crops; these cards are not square (400x500 in
          // the carousel, fixed-height in the desktop grid), so a thumbnail
          // would be cropped a second time by object-cover and reframe every
          // photo. Previews use fit:'inside' and are the whole frame, so the
          // card looks exactly as it did while no longer pulling an original.
          src={lightboxImageUrl(photo)}
          alt={photoLabels.of(photo, photo.filename)}
          onLoad={() => setIsLoaded(true)}
          className={`w-full h-full object-cover transition-all duration-700 ease-out will-change-transform ${
            !isLoaded ? 'opacity-0 scale-110' : 'opacity-100 scale-100'
          }`}
          isGallery={true}
          slug={slug}
        />
        )}
      </a>

      {/* Colour label (#1044) — same badge every layout uses. */}
      <ColorLabelBadge
        colorLabel={photo.my_color_label}
        otherColorLabels={photo.other_color_labels}
        decision={photo.my_decision}
      />

      {/* Overlay */}
      <div className="story-photo-card-overlay" />

      {/* First look (issue 1562). Bottom-left is free until hover, when the
          filename caption slides over it — so the pill steps aside then. */}
      <FirstLookBadge
        photo={photo}
        className={`bottom-3 left-3${captionText ? ' transition-opacity group-hover:opacity-0' : ''}`}
      />

      {/* Selection checkbox (issue 1716). Visible while selecting or when
          selected; outside selection mode it appears on hover and starts the
          selection, the same as the shared grid's checkbox. */}
      {onSelect && (
        <button
          type="button"
          role="checkbox"
          aria-checked={isSelected}
          aria-label={photoLabels.of(photo, photo.original_filename || photo.filename)}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onSelect(photo.id);
          }}
          className={`story-photo-card-check${isSelectionMode || isSelected ? ' visible' : ''}${isSelected ? ' selected' : ''}`}
        >
          {isSelected && <Check size={14} strokeWidth={3} />}
        </button>
      )}

      {/* The client's hide/show button (issue 1992). The checkbox owns this
          card's top-left corner, so the button sits just below it. */}
      {onToggleVisibility && (
        <ClientVisibilityToggle
          photo={photo}
          onToggle={onToggleVisibility}
          className="absolute top-12 left-3 z-10"
        />
      )}

      {/* Actions */}
      {likesAllowed && (
        <div className="story-photo-card-actions">
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleFavorite(photo.id);
            }}
            className={`story-photo-card-btn ${isFavorite ? 'favorite' : ''}`}
          >
            <Heart size={18} fill={isFavorite ? 'currentColor' : 'none'} />
          </button>
        </div>
      )}

      {/* Caption */}
      {captionText && (
        <div className="story-photo-card-caption">
          <p>{captionText}</p>
        </div>
      )}
    </motion.div>
  );
};
