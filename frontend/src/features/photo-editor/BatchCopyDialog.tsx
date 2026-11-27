import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { toast } from 'react-toastify';
import { Button, Modal, Notice } from '../../components/common';
import { AdminAuthenticatedImage } from '../../components/admin/AdminAuthenticatedImage';
import type { AdminPhoto } from '../../services/photos.service';
import { photoEditorService, type EditPart } from '../../services/photoEditor.service';
import type { EditParams } from './editMath';

interface BatchCopyDialogProps {
  open: boolean;
  onClose: () => void;
  eventId: number;
  /** The gallery's photos; videos are left out. */
  photos: AdminPhoto[];
  /** The photo the settings come from, not offered as a target. */
  sourceId: number;
  params: EditParams;
  /** Called once the copy is queued; the editor shows the progress. */
  onQueued: (photoIds: number[]) => void;
}

const isVideo = (photo: AdminPhoto) => photo.media_type === 'video' || String(photo.mime_type || '').startsWith('video/');

/** Copy the open photo's settings to other photos of the gallery (issue 2619), like Lightroom's sync. */
export const BatchCopyDialog: React.FC<BatchCopyDialogProps> = ({ open, onClose, eventId, photos, sourceId, params, onQueued }) => {
  const { t } = useTranslation();
  const targets = useMemo(() => photos.filter((p) => !isVideo(p) && p.id !== sourceId), [photos, sourceId]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [parts, setParts] = useState<Record<EditPart, boolean>>({ tone: true, geometry: false });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setSelected(new Set()); }, [open]);

  const toggle = (id: number) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const chosenParts = (Object.keys(parts) as EditPart[]).filter((part) => parts[part]);

  const submit = async () => {
    setBusy(true);
    try {
      const ids = [...selected];
      const result = await photoEditorService.copyTo(eventId, ids, params, chosenParts);
      toast.success(t('photoEditor.batch.queued', { count: result.queued, defaultValue: 'Settings copied to {{count}} photos' }));
      onQueued(ids.filter((id) => !result.skipped.includes(id)));
      onClose();
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      className="ui-dark"
      title={t('photoEditor.batch.title', 'Copy settings to photos')}
      description={t('photoEditor.batch.description', 'The chosen settings replace those parts of each photo’s edit. Previews update in the background.')}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button variant="primary" isLoading={busy} disabled={!selected.size || !chosenParts.length} onClick={submit}>
            {t('photoEditor.batch.submit', { count: selected.size, defaultValue: 'Copy to {{count}} photos' })}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <fieldset className="flex flex-wrap gap-4">
          <legend className="sr-only">{t('photoEditor.batch.parts', 'Settings to copy')}</legend>
          {(['tone', 'geometry'] as EditPart[]).map((part) => (
            <label key={part} className="flex items-center gap-2 text-sm text-body">
              <input
                type="checkbox"
                checked={parts[part]}
                onChange={(e) => setParts((prev) => ({ ...prev, [part]: e.target.checked }))}
                className="w-4 h-4 accent-[var(--ui-accent-strong)]"
              />
              {part === 'tone'
                ? t('photoEditor.batch.tone', 'Light, colour and detail')
                : t('photoEditor.batch.geometry', 'Crop and rotation')}
            </label>
          ))}
        </fieldset>
        {parts.geometry && (
          <Notice tone="info" size="sm">
            {t('photoEditor.batch.geometryNote', 'The crop is copied as a share of each photo, so photos of another shape are cropped differently.')}
          </Notice>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(targets.map((p) => p.id)))}>
            {t('photoEditor.batch.selectAll', 'Select all')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            {t('photoEditor.batch.selectNone', 'Select none')}
          </Button>
          <span className="text-sm text-muted">
            {t('photoEditor.batch.selected', { count: selected.size, defaultValue: '{{count}} selected' })}
          </span>
        </div>
        <ul className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-6 gap-2" aria-label={t('photoEditor.batch.photos', 'Photos')}>
          {targets.map((photo) => {
            const on = selected.has(photo.id);
            return (
              <li key={photo.id}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(photo.id)}
                  className={`relative block w-full aspect-square overflow-hidden rounded-lg border-2 ${on ? 'border-accent' : 'border-line'}`}
                  title={photo.filename}
                >
                  {photo.thumbnail_url && (
                    <AdminAuthenticatedImage src={photo.thumbnail_url} alt={photo.filename} className="w-full h-full object-cover" />
                  )}
                  {on && (
                    <span className="absolute top-1 right-1 rounded-full bg-accent-strong text-accent-fg p-0.5">
                      <Check className="w-3.5 h-3.5" />
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
};
