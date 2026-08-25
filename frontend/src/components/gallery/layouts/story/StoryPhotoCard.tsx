import React, { useState } from 'react';
import { motion } from 'framer-motion';
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

  return (
    <motion.div
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
      </a>

      {/* Colour label (#1044) — same badge every layout uses. */}
      <ColorLabelBadge colorLabel={photo.my_color_label} />

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
