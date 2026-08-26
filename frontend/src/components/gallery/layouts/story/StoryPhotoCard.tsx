import React, { useRef, useState } from 'react';
import { motion, useInView } from 'framer-motion';
import { Heart } from 'lucide-react';
import { AuthenticatedImage } from '../../../common';
import { ColorLabelBadge } from '../../ColorLabelBadge';
import type { Photo } from '../../../../types';
import { lightboxImageUrl } from '../../imageTiers';

interface StoryPhotoCardProps {
  photo: Photo;
  index: number;
  isFavorite: boolean;
  onToggleFavorite: (id: number) => void;
  onClick?: () => void;
  slug: string;
  allowDownloads?: boolean;
  protectionLevel?: 'basic' | 'standard' | 'enhanced' | 'maximum';
  useEnhancedProtection?: boolean;
  useCanvasRendering?: boolean;
  featured?: boolean;
  galleryId: string;
}

export const StoryPhotoCard: React.FC<StoryPhotoCardProps> = ({
  photo,
  index,
  isFavorite,
  onToggleFavorite,
  onClick,
  slug,
  allowDownloads = true,
  protectionLevel = 'standard',
  useEnhancedProtection = false,
  useCanvasRendering = false,
  featured = false,
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

  return (
    <motion.div
      ref={cardRef}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-50px' }}
      transition={{ delay: Math.min(index * 0.05, 0.3) }}
      className={`story-photo-card group ${featured ? 'story-gallery-grid-featured' : ''}`}
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
          if (onClick) {
            e.preventDefault();
            onClick();
          }
        }}
        className="block w-full h-full"
      >
        {/* The placeholder keeps the card's box while the image is still
            out of range, so nothing reflows when it arrives. */}
        {!isNearViewport ? (
          <div className="w-full h-full bg-neutral-200 dark:bg-neutral-800" aria-hidden="true" />
        ) : (
        <AuthenticatedImage
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
          alt={photo.filename}
          onLoad={() => setIsLoaded(true)}
          className={`w-full h-full object-cover transition-all duration-700 ease-out will-change-transform ${
            !isLoaded ? 'opacity-0 scale-110' : 'opacity-100 scale-100'
          }`}
          isGallery={true}
          slug={slug}
          photoId={photo.id}
          requiresToken={photo.requires_token}
          secureUrlTemplate={photo.secure_url_template}
          protectFromDownload={!allowDownloads || useEnhancedProtection}
          protectionLevel={protectionLevel}
          useEnhancedProtection={useEnhancedProtection}
          useCanvasRendering={useCanvasRendering || protectionLevel === 'maximum'}
        />
        )}
      </a>

      {/* Colour label (#1044) — same badge every layout uses. */}
      <ColorLabelBadge
        colorLabel={photo.my_color_label}
        otherColorLabels={photo.other_color_labels}
      />

      {/* Overlay */}
      <div className="story-photo-card-overlay" />

      {/* Actions */}
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

      {/* Caption */}
      <div className="story-photo-card-caption">
        <p>{photo.filename}</p>
      </div>
    </motion.div>
  );
};
