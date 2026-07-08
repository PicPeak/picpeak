import React from 'react';
import { Heart } from 'lucide-react';
import { useTheme } from '../../../contexts/ThemeContext';
import { PhotoCard } from '../PhotoCard';
import { FeedbackIdentityModal } from '../../gallery/FeedbackIdentityModal';
import { feedbackService } from '../../../services/feedback.service';
import type { BaseGalleryLayoutProps } from './BaseGalleryLayout';
import type { Photo } from '../../../types';

/**
 * Mosaic Gallery Layout
 *
 * Uses CSS Columns for a gap-free masonry/mosaic effect.
 * Images flow vertically within columns, maintaining their natural aspect ratios.
 * This approach eliminates gaps that occur with CSS Grid span rules.
 *
 * Based on:
 * - https://css-tricks.com/seamless-responsive-photo-grid/
 * - https://www.30secondsofcode.org/css/s/image-mosaic/
 */

interface MosaicPhotoProps {
  photo: Photo;
  isSelected: boolean;
  isSelectionMode: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDownload: (e: React.MouseEvent) => void;
  onToggleSelect: () => void;
  allowDownloads?: boolean;
  slug?: string;
  feedbackEnabled?: boolean;
  feedbackOptions?: {
    allowLikes?: boolean;
    allowComments?: boolean;
    requireNameEmail?: boolean;
  };
  onQuickComment?: () => void;
}

const MosaicPhoto: React.FC<MosaicPhotoProps> = ({
  photo,
  isSelected,
  isSelectionMode,
  onClick,
  onDownload,
  onToggleSelect,
  allowDownloads = true,
  slug,
  feedbackEnabled = false,
  feedbackOptions,
  onQuickComment
}) => {
  const [showIdentityModal, setShowIdentityModal] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<null | { type: 'like'; photoId: number }>(null);
  const [savedIdentity, setSavedIdentity] = React.useState<{ name: string; email: string } | null>(null);
  // Seed from server is_liked (#590 follow-up). useState's initializer
  // fires once on mount, so subsequent prop updates don't reseed.
  const [likedLocal, setLikedLocal] = React.useState(photo.is_liked ?? false);

  // Calculate aspect ratio from photo dimensions (fallback to 1 if unknown)
  const aspectRatio = (photo.width && photo.height) ? photo.width / photo.height : 1;

  return (
    <>
      <PhotoCard
        photo={photo}
        isSelected={isSelected}
        isSelectionMode={isSelectionMode}
        onClick={(e) => {
          e.stopPropagation();
          onClick(e);
        }}
        onDownload={onDownload}
        onToggleSelect={onToggleSelect}
        className="photo-card relative group cursor-pointer overflow-hidden rounded-lg bg-neutral-100 mb-2"
        style={{
          breakInside: 'avoid',
          aspectRatio: aspectRatio.toString()
        }}
        imageProps={{
          src: photo.thumbnail_url || photo.url,
          alt: photo.filename,
          className: 'w-full h-full object-cover transition-transform duration-300 group-hover:scale-105',
          loading: 'lazy',
          isGallery: true,
          protectFromDownload: !allowDownloads,
        }}
        overlayBaseClassName="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center gap-2"
        allowDownloads={allowDownloads}
        feedbackEnabled={feedbackEnabled}
        feedbackOptions={feedbackOptions}
        slug={slug}
        onQuickComment={onQuickComment}
        liked={likedLocal}
        onLikeSuccess={() => {
          // Toggle — server /feedback like is a toggle (#590).
          setLikedLocal(prev => !prev);
        }}
        savedIdentity={savedIdentity}
        onRequireIdentity={(action, photoId) => {
          setPendingAction({ type: action, photoId });
          setShowIdentityModal(true);
        }}
        likeBeforeComment
        checkboxTestId
        afterOverlay={((photo.like_count ?? 0) > 0 || likedLocal) ? (
          <div className={`absolute ${photo.type === 'collage' ? 'bottom-8' : 'bottom-2'} left-2 z-10`}>
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-white/90 backdrop-blur-sm" title="Liked">
              <Heart className="w-3.5 h-3.5 text-red-500" fill="currentColor" />
            </span>
          </div>
        ) : undefined}
      >
        {photo.type === 'collage' && (
          <div className="absolute bottom-2 left-2">
            <span className="px-2 py-1 bg-black/60 text-white text-xs rounded">
              Collage
            </span>
          </div>
        )}
      </PhotoCard>
      <FeedbackIdentityModal
        isOpen={showIdentityModal}
        onClose={() => { setShowIdentityModal(false); setPendingAction(null); }}
        onSubmit={async (name, email) => {
          setSavedIdentity({ name, email });
          setShowIdentityModal(false);
          if (pendingAction) {
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
    </>
  );
};

export const MosaicGalleryLayout: React.FC<BaseGalleryLayoutProps> = ({
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
  const scale = theme.gallerySettings?.thumbnailScale || 'md';
  const scaleOffsets: Record<string, number> = { xs: 3, sm: 1, md: 0, lg: -1, xl: -2 };
  const applyScale = (cols: number, min = 1) => Math.max(min, cols + (scaleOffsets[scale] ?? 0));

  const desktop = applyScale(4);
  const xlDown = applyScale(3);
  const lgDown = applyScale(2);
  const mobile = Math.min(applyScale(1), 2); // Cap mobile at 2

  return (
    <div
      className="photo-grid w-full"
      style={{
        columnCount: desktop,
        columnGap: '8px',
      }}
    >
      <style>{`
        @media (max-width: 1280px) {
          .photo-grid { column-count: ${xlDown} !important; }
        }
        @media (max-width: 1024px) {
          .photo-grid { column-count: ${lgDown} !important; }
        }
        @media (max-width: 640px) {
          .photo-grid { column-count: ${mobile} !important; }
        }
      `}</style>
      {photos.map((photo, index) => (
        <MosaicPhoto
          key={photo.id}
          photo={photo}
          isSelected={selectedPhotos.has(photo.id)}
          isSelectionMode={isSelectionMode}
          onClick={() => {
            if (isSelectionMode && onPhotoSelect) {
              onPhotoSelect(photo.id);
            } else {
              onPhotoClick(index);
            }
          }}
          onDownload={(e) => onDownload(photo, e)}
          onToggleSelect={() => onPhotoSelect && onPhotoSelect(photo.id)}
          allowDownloads={allowDownloads}
          slug={slug}
          feedbackEnabled={feedbackEnabled}
          feedbackOptions={feedbackOptions}
          onQuickComment={() => {
            if (typeof onOpenPhotoWithFeedback !== 'undefined' && onOpenPhotoWithFeedback) {
              onOpenPhotoWithFeedback(index);
            }
          }}
        />
      ))}
    </div>
  );
};
