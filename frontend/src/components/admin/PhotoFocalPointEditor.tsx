import React, { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Modal, Notice } from '../common';
import { photosService, type AdminPhoto } from '../../services/photos.service';
import { FocalPointPicker } from './FocalPointPicker';

interface PhotoFocalPointEditorProps {
  open: boolean;
  onClose: () => void;
  eventId: number;
  photo: AdminPhoto;
  /** Called once the thumbnail was cut around the saved point. */
  onChanged: () => void;
}

/** "X% Y%", the picker's value, for a stored point; the centre for none. */
export function focalPointValue(point: { x: number; y: number } | null | undefined): string {
  if (!point) return '50% 50%';
  return `${Math.round(point.x * 100)}% ${Math.round(point.y * 100)}%`;
}

/** The picker's "X% Y%" back to a stored point. */
export function parseFocalPointValue(value: string): { x: number; y: number } {
  const match = value.match(/^(\d{1,3})%\s+(\d{1,3})%$/);
  if (!match) return { x: 0.5, y: 0.5 };
  const fraction = (n: string) => Math.min(100, Math.max(0, parseInt(n, 10))) / 100;
  return { x: fraction(match[1]), y: fraction(match[2]) };
}

/**
 * The admin moves where a photo's crops keep its subject (issue 2377), or goes
 * back to the point detected when it was uploaded. Shown on the whole photo
 * (the preview tier, never the cover-cropped thumbnail), so a click lands on
 * the point under it.
 */
export const PhotoFocalPointEditor: React.FC<PhotoFocalPointEditorProps> = ({ open, onClose, eventId, photo, onChanged }) => {
  const { t } = useTranslation();
  const stored = focalPointValue(photo.focal_point);
  const [draft, setDraft] = useState(stored);
  // Opened again, or on another photo: start from what is stored.
  useEffect(() => { if (open) setDraft(stored); }, [open, photo.id, stored]);

  const save = useMutation({
    mutationFn: (point: { x: number; y: number } | null) => photosService.setFocalPoint(eventId, photo.id, point),
    onSuccess: () => {
      onChanged();
      onClose();
    },
  });

  // The picker shows the whole photo only once it knows the shape: from the
  // stored dimensions, or the loaded preview when they are missing (a RAW
  // Sharp could not read). Before that its box is the hero strip, a crop, so
  // a point picked there would not be the photo's.
  const [loadedRatio, setLoadedRatio] = useState<number>();
  useEffect(() => { setLoadedRatio(undefined); }, [photo.id]);
  const aspectRatio = photo.width && photo.height ? photo.width / photo.height : loadedRatio;
  const onImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = e.currentTarget;
    if (naturalWidth && naturalHeight) setLoadedRatio(naturalWidth / naturalHeight);
  };
  const isManual = photo.focal_source === 'manual';
  const status = isManual
    ? t('admin.photos.focalPoint.isManual')
    : photo.focal_point
      ? t('admin.photos.focalPoint.isAuto')
      : t('admin.photos.focalPoint.isCentre');

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('admin.photos.focalPoint.title')}
      description={t('admin.photos.focalPoint.description')}
      closeOnBackdrop={draft === stored}
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={save.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => save.mutate(null)}
            disabled={!isManual || save.isPending}
            isLoading={save.isPending && save.variables === null}
          >
            {t('admin.photos.focalPoint.useAuto')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => save.mutate(parseFocalPointValue(draft))}
            disabled={(isManual && draft === stored) || save.isPending || !aspectRatio}
            isLoading={save.isPending && save.variables !== null}
          >
            {t('common.save')}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <p className="text-sm text-body flex items-center gap-2">
          <Badge tone="accent">{t('admin.photos.focalPoint.current')}</Badge>
          {status}
        </p>
        <FocalPointPicker
          imageUrl={`/admin/photos/${eventId}/preview/${photo.id}`}
          currentValue={draft}
          onChange={setDraft}
          aspectRatio={aspectRatio}
          showPresets={false}
          alt={photo.filename}
          admin
          onImageLoad={onImageLoad}
        />
        <p className="text-xs text-muted">{t('admin.photos.focalPoint.hint')}</p>
      </div>

      {save.isError && (
        <Notice tone="danger" className="mt-4">
          {(save.error as { response?: { data?: { error?: string } } })?.response?.data?.error
            || t('admin.photos.focalPoint.saveError')}
        </Notice>
      )}
    </Modal>
  );
};
