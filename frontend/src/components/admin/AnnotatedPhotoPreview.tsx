import React from 'react';
import { useTranslation } from 'react-i18next';
import { AdminAuthenticatedImage } from './AdminAuthenticatedImage';
import { ImageAnnotationOverlay } from '../gallery/annotation/ImageAnnotationOverlay';
import { parseAnnotation } from '../../utils/photoAnnotation';
import { adminPreviewEditQuery } from '../gallery/imageTiers';

interface AnnotatedPhotoPreviewProps {
  eventId: string | number;
  photoId: string | number;
  /** As the API returned it. Nothing renders unless it validates. */
  annotation: unknown;
  alt: string;
  className?: string;
  /** The photo's applied edit revision, as the feedback list gives it (issue 2619). */
  editAppliedRev?: number | null;
  /** Part of the drawing is outside the current crop and left out (issue 2619). */
  clipped?: boolean;
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
  editAppliedRev,
  clipped = false,
}) => {
  const { t } = useTranslation();
  const note = clipped
    ? <p className="mt-1 text-xs text-muted">{t('feedback.annotation.outsideCrop', 'Part of the drawing is outside the current crop.')}</p>
    : null;
  if (!parseAnnotation(annotation)) return note;
  return (
    <>
    <div
      className={`relative flex items-center justify-center w-48 h-48 max-w-full bg-inset rounded overflow-hidden ${className}`}
      data-testid="annotated-photo-preview"
    >
      <AdminAuthenticatedImage
        src={`/admin/photos/${eventId}/preview/${photoId}${adminPreviewEditQuery(editAppliedRev) ? `?${adminPreviewEditQuery(editAppliedRev)}` : ''}`}
        alt={alt}
        className="max-w-full max-h-full object-contain"
      />
      <ImageAnnotationOverlay
        annotation={annotation}
        lineWidth={2}
        label={t('feedback.annotation.overlayLabel', 'Drawing on the photo')}
      />
    </div>
    {note}
    </>
  );
};
