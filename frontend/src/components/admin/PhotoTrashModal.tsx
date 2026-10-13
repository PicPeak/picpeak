import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Film, Image as ImageIcon, RotateCcw, Trash2 } from 'lucide-react';
import {
  Button, EmptyState, ErrorState, Loading, Modal, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, useConfirm,
} from '../common';
import { photosService, type TrashedPhoto, type TrashRestoreResult } from '../../services/photos.service';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { formatFileSize } from '../../utils/fileSize';

export const photoTrashQueryKey = (eventId: number) => ['admin-photo-trash', eventId];

/** Whole days until the photo is deleted for good; 0 on its last day. */
export function daysLeft(purgeAfter: string, now = Date.now()): number {
  const ms = Date.parse(purgeAfter) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 86400000) : 0;
}

/** What one restore or purge request may name (MAX_TRASH_IDS in backend/src/routes/adminPhotos.js). */
export const TRASH_BATCH_SIZE = 500;

/**
 * Runs `send` over `ids` in requests the server accepts and merges the
 * results. A request that fails after others went through does not hide what
 * those did: the ids that were not sent come back as failed (`unsent`), and
 * only a failure of the very first request is thrown.
 */
async function inBatches<T>(
  ids: number[],
  send: (batch: number[]) => Promise<T>,
  merge: (a: T, b: T) => T,
  unsent: (rest: number[], error: any) => T,
): Promise<T> {
  let merged: T | undefined;
  for (let start = 0; start < ids.length; start += TRASH_BATCH_SIZE) {
    try {
      const result = await send(ids.slice(start, start + TRASH_BATCH_SIZE));
      merged = merged === undefined ? result : merge(merged, result);
    } catch (error) {
      if (merged === undefined) throw error;
      return merge(merged, unsent(ids.slice(start), error));
    }
  }
  return merged as T;
}

const mergeRestores = (a: TrashRestoreResult, b: TrashRestoreResult): TrashRestoreResult => ({
  restored: a.restored + b.restored,
  photo_ids: [...a.photo_ids, ...b.photo_ids],
  reassigned: [...(a.reassigned ?? []), ...(b.reassigned ?? [])],
  failed: [...a.failed, ...b.failed],
});

interface PhotoTrashModalProps {
  eventId: number;
  open: boolean;
  onClose: () => void;
  /** Photos went back into the gallery: refresh its lists. */
  onRestored: () => void;
}

/**
 * The gallery's trash (issue 1733): photos an admin deleted, until their
 * retention runs out. The thumbnails went with the delete, so this is a list:
 * file name, when and by whom, and how long is left. Restore brings a photo
 * back with its likes, ratings and comments; deleting permanently cannot be
 * undone.
 */
export const PhotoTrashModal: React.FC<PhotoTrashModalProps> = ({ eventId, open, onClose, onRestored }) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: photoTrashQueryKey(eventId),
    queryFn: () => photosService.getTrash(eventId),
    enabled: open,
  });
  const items = data?.items ?? [];
  // Rows that left the list (restored or purged elsewhere) drop out of the selection.
  const selectedIds = items.filter((item) => selected.has(item.id)).map((item) => item.id);

  const done = () => {
    setSelected(new Set());
    queryClient.invalidateQueries({ queryKey: photoTrashQueryKey(eventId) });
  };

  const restore = useMutation({
    mutationFn: (ids: number[]) => inBatches(
      ids,
      (batch) => photosService.restoreFromTrash(eventId, batch),
      mergeRestores,
      (rest, error) => ({
        restored: 0,
        photo_ids: [],
        failed: rest.map((id) => ({ id, filename: '', code: 'REQUEST_FAILED', error: error?.response?.data?.error || '' })),
      }),
    ),
    onSuccess: (result) => {
      if (result.restored > 0) {
        toast.success(t('admin.photos.trash.restored', { count: result.restored }));
        onRestored();
      }
      if (result.failed.length > 0) {
        // The first reason, in the server's words: an id in use, a full gallery, a missing file.
        toast.error(`${t('admin.photos.trash.restoreFailed', { count: result.failed.length })} ${result.failed[0].error}`);
      }
      done();
    },
    onError: (error: any) => {
      toast.error(error?.response?.data?.error || t('admin.photos.trash.restoreFailed', { count: 1 }));
    },
  });

  const purge = useMutation({
    mutationFn: (ids: number[]) => inBatches(
      ids,
      (batch) => photosService.purgeFromTrash(eventId, batch),
      (a, b) => ({ purged: a.purged + b.purged, failed: [...a.failed, ...b.failed] }),
      (rest) => ({ purged: 0, failed: rest }),
    ),
    onSuccess: (result) => {
      if (result.purged > 0) toast.success(t('admin.photos.trash.purged', { count: result.purged }));
      if (result.failed.length > 0) toast.error(t('admin.photos.trash.purgeFailed'));
      done();
    },
    onError: (error: any) => {
      toast.error(error?.response?.data?.error || t('admin.photos.trash.purgeFailed'));
    },
  });

  const busy = restore.isPending || purge.isPending;

  const purgeAfterConfirm = async (ids: number[]) => {
    if (!(await confirm({
      message: t('admin.photos.trash.purgeConfirm', { count: ids.length }),
      variant: 'danger',
      confirmLabel: t('admin.photos.trash.purgeAction'),
    }))) return;
    purge.mutate(ids);
  };

  const toggle = (id: number) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allSelected = items.length > 0 && selectedIds.length === items.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)));

  const remaining = (item: TrashedPhoto) => {
    const days = daysLeft(item.purge_after);
    return days > 0 ? t('admin.photos.trash.daysLeft', { count: days }) : t('admin.photos.trash.lastDay');
  };

  return (
    <Modal
      open={open}
      // Closing waits for a running request (UX.md § 8).
      onClose={() => { if (!busy) onClose(); }}
      title={t('admin.photos.trash.title')}
      description={data ? t('admin.photos.trash.intro', { count: data.retention_days }) : undefined}
      size="2xl"
      footer={selectedIds.length > 0 ? (
        <>
          <Button
            variant="danger"
            size="sm"
            leftIcon={<Trash2 className="w-4 h-4" />}
            disabled={busy}
            onClick={() => purgeAfterConfirm(selectedIds)}
          >
            {t('admin.photos.trash.purgeSelected', { count: selectedIds.length })}
          </Button>
          <Button
            variant="primary"
            size="sm"
            leftIcon={<RotateCcw className="w-4 h-4" />}
            disabled={busy}
            isLoading={restore.isPending}
            onClick={() => restore.mutate(selectedIds)}
          >
            {t('admin.photos.trash.restoreSelected', { count: selectedIds.length })}
          </Button>
        </>
      ) : undefined}
    >
      {isLoading ? (
        <div className="flex justify-center py-12"><Loading size="lg" /></div>
      ) : isError && !data ? (
        <ErrorState size="inline" title={t('admin.photos.trash.loadFailed')} onRetry={() => refetch()} retrying={isFetching} />
      ) : items.length === 0 ? (
        <EmptyState
          size="inline"
          icon={<Trash2 />}
          title={t('admin.photos.trash.empty')}
          description={t('admin.photos.trash.emptyHelp')}
        />
      ) : (
        <Table data-testid="photo-trash-table">
          <TableHead>
            <tr>
              <TableHeaderCell className="w-10">
                <input
                  type="checkbox"
                  className="w-4 h-4 text-accent rounded focus:ring-accent"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label={t('gallery.selectAll', 'Select All')}
                />
              </TableHeaderCell>
              <TableHeaderCell>{t('admin.photos.trash.columnFile')}</TableHeaderCell>
              <TableHeaderCell>{t('admin.photos.trash.columnDeleted')}</TableHeaderCell>
              <TableHeaderCell>{t('admin.photos.trash.columnDeletedBy')}</TableHeaderCell>
              <TableHeaderCell>{t('admin.photos.trash.columnRemaining')}</TableHeaderCell>
              <TableHeaderCell align="right">{t('admin.photos.trash.columnSize')}</TableHeaderCell>
              <TableHeaderCell align="right"><span className="sr-only">{t('common.actions', 'Actions')}</span></TableHeaderCell>
            </tr>
          </TableHead>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id} data-testid={`photo-trash-row-${item.id}`}>
                <TableCell>
                  <input
                    type="checkbox"
                    className="w-4 h-4 text-accent rounded focus:ring-accent"
                    checked={selected.has(item.id)}
                    onChange={() => toggle(item.id)}
                    aria-label={item.filename}
                  />
                </TableCell>
                <TableCell className="text-heading">
                  <span className="flex items-center gap-2 min-w-0">
                    {item.media_type === 'video'
                      ? <Film className="w-4 h-4 flex-shrink-0 text-faint" aria-hidden="true" />
                      : <ImageIcon className="w-4 h-4 flex-shrink-0 text-faint" aria-hidden="true" />}
                    <span className="truncate max-w-xs" title={item.filename}>{item.filename}</span>
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap">{format(item.deleted_at)}</TableCell>
                <TableCell>{item.deleted_by_name || t('admin.photos.trash.unknownUser')}</TableCell>
                <TableCell className="whitespace-nowrap">{remaining(item)}</TableCell>
                <TableCell align="right" className="whitespace-nowrap">{formatFileSize(item.size_bytes)}</TableCell>
                <TableCell align="right">
                  <span className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => restore.mutate([item.id])}>
                      {t('admin.photos.trash.restore')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => purgeAfterConfirm([item.id])}
                      aria-label={t('admin.photos.trash.purgeOneLabel', { name: item.filename })}
                      title={t('admin.photos.trash.purgeAction')}
                    >
                      <Trash2 className="w-4 h-4 text-danger-text" />
                    </Button>
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Modal>
  );
};
