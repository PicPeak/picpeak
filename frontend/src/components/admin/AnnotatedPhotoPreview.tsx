import React from 'react';
import { useTranslation } from 'react-i18next';
import { AdminAuthenticatedImage } from './AdminAuthenticatedImage';
import { ImageAnnotationOverlay } from '../gallery/annotation/ImageAnnotationOverlay';
import { parseAnnotation } from '../../utils/photoAnnotation';

interface AnnotatedPhotoPreviewProps {
  eventId: string | number;
  photoId: string | number;
  /** As the API returned it. Nothing renders unless it validates. */
  annotation: unknown;
  alt: string;
  className?: string;
}

/**
 * A small uncropped preview of a photo with a guest's drawing on it
 * (issue 1733), for the feedback lists. The preview rendition rather than
 * the thumbnail: a thumbnail can be cropped, and the drawing's coordinates
 * are relative to the whole picture.
 */
export const AnnotatedPhotoPreview: React.FC<AnnotatedPhotoPreviewProps> = ({
  eventId,
  photoId,
  annotation,
  alt,
  className = '',
}) => {
  const { t } = useTranslation();
  if (!parseAnnotation(annotation)) return null;
  return (
    <div
      className={`relative flex items-center justify-center w-48 h-48 max-w-full bg-inset rounded overflow-hidden ${className}`}
      data-testid="annotated-photo-preview"
    >
      <AdminAuthenticatedImage
        src={`/admin/photos/${eventId}/preview/${photoId}`}
        alt={alt}
        className="max-w-full max-h-full object-contain"
      />
      <ImageAnnotationOverlay
        annotation={annotation}
        lineWidth={2}
        label={t('feedback.annotation.overlayLabel', 'Drawing on the photo')}
      />
    </div>
  );
};
