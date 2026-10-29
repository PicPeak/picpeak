import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Copy, Film, Image as ImageIcon, Trash2 } from 'lucide-react';
import { AdminAuthenticatedImage } from './AdminAuthenticatedImage';
import { Badge, Button, EmptyState, ErrorState, Loading, Modal, Notice } from '../common';
import { photosService, type DuplicateGroup, type DuplicateKeep, type DuplicatePhoto } from '../../services/photos.service';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { formatFileSize } from '../../utils/fileSize';

export const photoDuplicatesQueryKey = (eventId: number) => ['admin-photo-duplicates', eventId];

/** Groups per page; the server allows up to 100 (MAX_GROUP_LIMIT). */
export const DUPLICATE_GROUPS_PER_PAGE = 20;

const uploadedMs = (photo: DuplicatePhoto) => {
  const ms = photo.uploaded_at ? Date.parse(photo.uploaded_at) : NaN;
  return Number.isFinite(ms) ? ms : Infinity;
};

/** The photo a group keeps unless the admin picks another: the oldest upload. */
export function defaultKeepId(group: DuplicateGroup): number {
  return [...group.photos].sort((a, b) => (uploadedMs(a) - uploadedMs(b)) || (a.id - b.id))[0].id;
}

interface PhotoDuplicatesModalProps {
  eventId: number;
  open: boolean;
  onClose: () => void;
  /** photos.delete: may move copies to the trash. */
  canDelete: boolean;
  /** The trash's retention; 0 means deleting is final, and nothing is moved here. */
  trashRetentionDays?: number;
  /** Copies went to the trash: refresh the gallery's lists. */
  onTrashed: () => void;
}

/**
 * The duplicates view (issue 2194): photos of this gallery with the same
 * bytes, grouped. Per group the admin keeps one (the oldest by default) and
 * moves the rest to the trash, from where they restore like any deleted photo.
 */
export const PhotoDuplicatesModal: React.FC<PhotoDuplicatesModalProps> = ({
  eventId, open, onClose, canDelete, trashRetentionDays, onTrashed,
}) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const queryClient = useQueryClient();
  const [offset, setOffset] = useState(0);
  // The admin's pick per group, by hash; a group without one keeps the oldest.
  const [picks, setPicks] = useState<Record<string, number>>({});

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: [...photoDuplicatesQueryKey(eventId), offset],
    queryFn: () => photosService.getDuplicates(eventId, { limit: DUPLICATE_GROUPS_PER_PAGE, offset }),
    enabled: open,
    placeholderData: keepPreviousData,
  });
  const groups = data?.groups ?? [];
  const total = data?.total_groups ?? 0;
  // A pick that names a photo no longer in its group falls back to the oldest.
  const keepOf = (group: DuplicateGroup) => {
    const pick = picks[group.content_sha256];
    return group.photos.some((photo) => photo.id === pick) ? pick : defaultKeepId(group);
  };

  const trashOff = trashRetentionDays === 0;
  const mayTrash = canDelete && !trashOff;

  const resolve = useMutation({
    mutationFn: (keep: DuplicateKeep[]) => photosService.resolveDuplicates(eventId, keep),
    onSuccess: (result) => {
      if (result.trashed > 0) {
        toast.success(t('admin.photos.duplicates.trashed', { count: result.trashed }));
        onTrashed();
      }
      if (result.failed.length > 0) toast.error(t('admin.photos.duplicates.failed'));
      queryClient.invalidateQueries({ queryKey: photoDuplicatesQueryKey(eventId) });
    },
    onError: (error: any) => {
      toast.error(error?.response?.data?.error || t('admin.photos.duplicates.failed'));
    },
  });
  const busy = resolve.isPending;

  // The last group of a later page resolved: show the page before it.
  if (data && groups.length === 0 && offset > 0 && !isFetching) {
    setOffset(Math.max(0, offset - DUPLICATE_GROUPS_PER_PAGE));
  }

  const sourceLabel = (photo: DuplicatePhoto) => ({
    admin: t('admin.photos.duplicates.sourceAdmin'),
    guest: t('admin.photos.duplicates.sourceGuest'),
    external: t('admin.photos.duplicates.sourceExternal'),
  }[photo.source] ?? t('admin.photos.duplicates.sourceAdmin'));

  return (
    <Modal
      open={open}
      // Closing waits for a running request (UX.md § 8).
      onClose={() => { if (!busy) onClose(); }}
      title={t('admin.photos.duplicates.title')}
      description={t('admin.photos.duplicates.intro')}
      size="2xl"
      footer={mayTrash && groups.length > 1 ? (
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Trash2 className="w-4 h-4" />}
          disabled={busy}
          isLoading={busy}
          onClick={() => resolve.mutate(groups.map((group) => ({ id: keepOf(group), content_sha256: group.content_sha256 })))}
          data-testid="duplicates-keep-all"
        >
          {t('admin.photos.duplicates.keepAll', { count: groups.length })}
        </Button>
      ) : undefined}
    >
      {isLoading ? (
        <div className="flex justify-center py-12"><Loading size="lg" /></div>
      ) : isError && !data ? (
        <ErrorState size="inline" title={t('admin.photos.duplicates.loadFailed')} onRetry={() => refetch()} retrying={isFetching} />
      ) : groups.length === 0 ? (
        <EmptyState
          size="inline"
          icon={<Copy />}
          title={t('admin.photos.duplicates.empty')}
          description={t('admin.photos.duplicates.emptyHelp')}
        />
      ) : (
        <div className="space-y-4" data-testid="duplicates-groups">
          {canDelete && trashOff && (
            <Notice tone="info" size="sm">{t('admin.photos.duplicates.trashOff')}</Notice>
          )}
          {groups.map((group) => {
            const keepId = keepOf(group);
            return (
              <fieldset
                key={group.content_sha256}
                className="min-w-0 rounded-lg border border-line p-3"
                data-testid={`duplicates-group-${group.content_sha256}`}
              >
                <legend className="px-1 text-sm font-medium text-heading">
                  {t('admin.photos.duplicates.copies', { count: group.photos.length })}
                </legend>
                <ul className="space-y-2">
                  {group.photos.map((photo) => (
                    <li key={photo.id}>
                      <label className="flex items-center gap-3 min-w-0 cursor-pointer">
                        {mayTrash && (
                          <input
                            type="radio"
                            className="w-4 h-4 flex-shrink-0 text-accent focus:ring-accent"
                            name={`keep-${group.content_sha256}`}
                            checked={photo.id === keepId}
                            onChange={() => setPicks((prev) => ({ ...prev, [group.content_sha256]: photo.id }))}
                            disabled={busy}
                            aria-label={t('admin.photos.duplicates.keepThis', { name: photo.filename })}
                          />
                        )}
                        <span className="flex-shrink-0 w-12 h-12 rounded overflow-hidden bg-inset flex items-center justify-center text-faint">
                          <AdminAuthenticatedImage
                            src={photo.thumbnail_url}
                            alt=""
                            className="w-full h-full object-cover"
                            fallback={photo.media_type === 'video'
                              ? <Film className="w-4 h-4" aria-hidden="true" />
                              : <ImageIcon className="w-4 h-4" aria-hidden="true" />}
                          />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="truncate min-w-0 text-sm text-heading" title={photo.filename}>{photo.filename}</span>
                            {photo.id === keepId && mayTrash && (
                              <Badge tone="success">{t('admin.photos.duplicates.keep')}</Badge>
                            )}
                          </span>
                          <span className="block text-xs text-muted break-words">
                            {[
                              photo.uploaded_at ? format(photo.uploaded_at) : null,
                              photo.size != null ? formatFileSize(photo.size) : null,
                              sourceLabel(photo),
                            ].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                {mayTrash && (
                  <div className="mt-3 flex justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => resolve.mutate([{ id: keepId, content_sha256: group.content_sha256 }])}
                      data-testid={`duplicates-keep-${group.content_sha256}`}
                    >
                      {t('admin.photos.duplicates.keepOne', { count: group.photos.length - 1 })}
                    </Button>
                  </div>
                )}
              </fieldset>
            );
          })}
          {total > DUPLICATE_GROUPS_PER_PAGE && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
              <span>
                {t('admin.photos.duplicates.range', {
                  from: offset + 1,
                  to: Math.min(offset + DUPLICATE_GROUPS_PER_PAGE, total),
                  count: total,
                })}
              </span>
              <span className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - DUPLICATE_GROUPS_PER_PAGE))}
                >
                  {t('common.previous')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || offset + DUPLICATE_GROUPS_PER_PAGE >= total}
                  onClick={() => setOffset(offset + DUPLICATE_GROUPS_PER_PAGE)}
                >
                  {t('common.next')}
                </Button>
              </span>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};
