/**
 * TransferPhotoPicker — cross-event image picker for PicTransfer (#997).
 *
 * A modal that lets the admin browse ANY event's photos and pick images to add
 * to a transfer. Thumbnails are previewed (recipient page has none); a lightbox
 * toggle switches image clicks between "select" and "preview". Selection
 * persists as the admin hops between events.
 */
import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X, Check, Image as ImageIcon, Maximize2, Search } from 'lucide-react';

import { Button, Input, Loading } from '../common';
import { AdminAuthenticatedImage } from './AdminAuthenticatedImage';
import { eventsService } from '../../services/events.service';
import { photosService, type AdminPhoto } from '../../services/photos.service';
import { useAdminAuth } from '../../contexts/AdminAuthContext';

export interface PickedPhoto {
  id: number;
  filename: string;
  event_id: number;
  event_name: string;
  thumbnail_url: string;
}

interface TransferPhotoPickerProps {
  onClose: () => void;
  onConfirm: (photos: PickedPhoto[]) => void;
  excludePhotoIds?: number[];
  isSaving?: boolean;
}

export const TransferPhotoPicker: React.FC<TransferPhotoPickerProps> = ({
  onClose,
  onConfirm,
  excludePhotoIds = [],
  isSaving = false,
}) => {
  const { t } = useTranslation();
  const { user } = useAdminAuth();
  const [eventSearch, setEventSearch] = useState('');
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);
  const [selectedEventName, setSelectedEventName] = useState<string>('');
  const [lightboxEnabled, setLightboxEnabled] = useState(false);
  const [previewPhoto, setPreviewPhoto] = useState<AdminPhoto | null>(null);
  // Persist selection (with metadata) across events.
  const [selected, setSelected] = useState<Map<number, PickedPhoto>>(new Map());

  const excluded = useMemo(() => new Set(excludePhotoIds), [excludePhotoIds]);

  const { data: eventsData, isLoading: eventsLoading } = useQuery({
    queryKey: ['transfer-picker-events', eventSearch],
    queryFn: () => eventsService.getEvents(1, 100, undefined, eventSearch || undefined),
  });
  // Only offer events the caller may bundle — mirrors the backend's
  // filterOwnedEventIds gate (super_admin unrestricted; others get their own
  // events plus ownerless legacy ones). Without this the picker would show
  // events whose photos the API silently drops on create — a dead control.
  // The backend is still the enforcer; this just keeps the UI honest.
  const roleName = user?.roleName || user?.role?.name;
  const isSuperAdmin = roleName === 'super_admin';
  const events = (eventsData?.events || []).filter((ev) => {
    if (isSuperAdmin) return true;
    const owner = (ev as { created_by?: number | null }).created_by;
    return owner == null || owner === user?.id;
  });

  const { data: photos, isLoading: photosLoading } = useQuery({
    queryKey: ['transfer-picker-photos', selectedEventId],
    queryFn: () => photosService.getEventPhotos(selectedEventId as number),
    enabled: !!selectedEventId,
  });

  const togglePhoto = (photo: AdminPhoto) => {
    if (excluded.has(photo.id)) return;
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(photo.id)) {
        next.delete(photo.id);
      } else {
        next.set(photo.id, {
          id: photo.id,
          filename: photo.original_filename || photo.filename,
          event_id: selectedEventId as number,
          event_name: selectedEventName,
          thumbnail_url: photo.thumbnail_url || '',
        });
      }
      return next;
    });
  };

  const handlePhotoClick = (photo: AdminPhoto) => {
    if (lightboxEnabled) setPreviewPhoto(photo);
    else togglePhoto(photo);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg bg-shell shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-lg font-semibold text-heading">
            {t('transfers.picker.title', 'Select images from other events')}
          </h2>
          <div className="flex items-center gap-2">
            <Button
              variant={lightboxEnabled ? 'primary' : 'outline'}
              size="sm"
              leftIcon={<Maximize2 className="h-4 w-4" />}
              onClick={() => setLightboxEnabled((v) => !v)}
            >
              {t('transfers.picker.lightbox', 'Lightbox')}
            </Button>
            <button onClick={onClose} className="rounded p-1 text-neutral-500 hover:bg-hover-soft">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Event list */}
          <div className="flex w-64 flex-col border-r border-line">
            <div className="p-3">
              <Input
                leftIcon={<Search className="h-4 w-4" />}
                placeholder={t('transfers.picker.searchEvents', 'Search events…')}
                value={eventSearch}
                onChange={(e) => setEventSearch(e.target.value)}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {eventsLoading ? (
                <div className="p-4"><Loading /></div>
              ) : (
                events.map((ev) => (
                  <button
                    key={ev.id}
                    onClick={() => { setSelectedEventId(ev.id); setSelectedEventName(ev.event_name); }}
                    className={`block w-full truncate px-4 py-2 text-left text-sm hover:bg-hover-soft ${
                      selectedEventId === ev.id ? 'bg-primary-50 font-medium text-primary-700 dark:bg-neutral-800' : 'text-body'
                    }`}
                  >
                    {ev.event_name}
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Photo grid */}
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {!selectedEventId ? (
              <div className="flex h-full items-center justify-center text-neutral-400">
                <div className="text-center">
                  <ImageIcon className="mx-auto mb-2 h-10 w-10" />
                  <p>{t('transfers.picker.pickEvent', 'Pick an event to browse its photos')}</p>
                </div>
              </div>
            ) : photosLoading ? (
              <Loading />
            ) : !photos || photos.length === 0 ? (
              <div className="flex h-full items-center justify-center text-neutral-400">
                {t('transfers.picker.noPhotos', 'No photos in this event')}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {photos.map((photo) => {
                  const isSelected = selected.has(photo.id);
                  const isExcluded = excluded.has(photo.id);
                  return (
                    <div
                      key={photo.id}
                      className={`group relative aspect-square cursor-pointer overflow-hidden rounded-md border-2 ${
                        isSelected ? 'border-primary-500' : 'border-transparent'
                      } ${isExcluded ? 'opacity-40' : ''}`}
                      onClick={() => handlePhotoClick(photo)}
                    >
                      {photo.thumbnail_url ? (
                        <AdminAuthenticatedImage src={photo.thumbnail_url} alt={photo.filename} className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center bg-subtle">
                          <ImageIcon className="h-6 w-6 text-neutral-400" />
                        </div>
                      )}
                      {isExcluded && (
                        <span className="absolute inset-x-0 bottom-0 bg-black/60 py-0.5 text-center text-[10px] text-white">
                          {t('transfers.picker.alreadyAdded', 'Added')}
                        </span>
                      )}
                      {isSelected && (
                        <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary-500 text-white">
                          <Check className="h-3 w-3" />
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-line px-5 py-3">
          <span className="text-sm text-soft">
            {t('transfers.picker.selectedCount', '{{count}} selected', { count: selected.size })}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
            <Button
              onClick={() => onConfirm(Array.from(selected.values()))}
              disabled={selected.size === 0}
              isLoading={isSaving}
            >
              {t('transfers.picker.addSelected', 'Add selected')}
            </Button>
          </div>
        </div>
      </div>

      {/* Simple lightbox preview */}
      {previewPhoto && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-6"
          onClick={() => setPreviewPhoto(null)}
        >
          <button className="absolute right-4 top-4 rounded p-2 text-white hover:bg-white/10">
            <X className="h-6 w-6" />
          </button>
          <div className="max-h-full max-w-full" onClick={(e) => e.stopPropagation()}>
            <AdminAuthenticatedImage
              src={`/admin/photos/${selectedEventId}/photo/${previewPhoto.id}`}
              alt={previewPhoto.filename}
              className="max-h-[80vh] max-w-full rounded object-contain"
            />
            <div className="mt-3 flex items-center justify-center gap-3">
              <span className="text-sm text-white/80">{previewPhoto.original_filename || previewPhoto.filename}</span>
              <Button
                size="sm"
                variant={selected.has(previewPhoto.id) ? 'outline' : 'primary'}
                onClick={() => togglePhoto(previewPhoto)}
              >
                {selected.has(previewPhoto.id) ? t('transfers.picker.deselect', 'Deselect') : t('transfers.picker.select', 'Select')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
