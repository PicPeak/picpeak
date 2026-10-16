/**
 * Importing from a gallery's external folder: the last scan's status, a
 * running import's progress, and the Import now / Rescan action. Shared by
 * the Photos tab's source line (ExternalSourceBar) and Settings → Photo
 * source, so both show the same state and run the same request.
 */
import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import type { Event } from '../../../types';
import { usePermission } from '../../../hooks/usePermission';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { externalMediaService } from '../../../services/externalMedia.service';

/**
 * `enabled: false` skips the status request, for a caller that will not show
 * it. The request also needs photos.view, the permission its route checks;
 * without it the status would only be a 403 on every render.
 */
export function useExternalImport(event: Event, { enabled = true }: { enabled?: boolean } = {}) {
  const { t } = useTranslation();
  const { formatDistanceToNow } = useLocalizedDate();
  const queryClient = useQueryClient();
  const canImport = usePermission('photos.upload');
  const canViewStatus = usePermission('photos.view');

  const { data: status } = useQuery({
    queryKey: ['external-import-status', event.id],
    queryFn: () => externalMediaService.getImportStatus(event.id),
    enabled: enabled && canViewStatus,
    // While an import runs (a rescan, the watcher, or the first import right
    // after creating the gallery) keep the line and the grid moving.
    refetchInterval: (query) => (query.state.data?.is_running ? 3000 : false),
  });

  const refreshPhotos = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-event', String(event.id)] });
    queryClient.invalidateQueries({ queryKey: ['admin-event-photos', String(event.id)] });
    queryClient.invalidateQueries({ queryKey: ['admin-event-filter-summary', String(event.id)] });
    queryClient.invalidateQueries({ queryKey: ['admin-photo-credits', event.id] });
  };

  // When a running import finishes, show what it brought in.
  const wasRunning = React.useRef(false);
  React.useEffect(() => {
    if (status?.is_running) wasRunning.current = true;
    else if (wasRunning.current) {
      wasRunning.current = false;
      refreshPhotos();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.is_running]);

  const rescan = useMutation({
    mutationFn: () => externalMediaService.rescanEvent(event.id),
    onSuccess: (result) => {
      toast.success(t('events.externalSource.rescanDone', 'Rescan done: {{count}} new photos', { count: result?.imported ?? 0 }));
      refreshPhotos();
      queryClient.invalidateQueries({ queryKey: ['external-import-status', event.id] });
    },
    onError: (error: unknown) => {
      const e = error as { response?: { status?: number; data?: { error?: string } } };
      toast.error(e.response?.status === 409
        ? t('events.externalSource.alreadyRunning', 'An import of this folder is already running.')
        : e.response?.data?.error || t('events.externalSource.rescanFailed', 'Rescan failed'));
      queryClient.invalidateQueries({ queryKey: ['external-import-status', event.id] });
    },
  });

  const running = rescan.isPending || status?.is_running === true;
  // A failed run is recorded as its outcome; without this it would read as a
  // finished scan of an empty folder.
  const failed = !running && status?.last_result?.failed === true;
  // The server stores a code, never the fs message (that quotes host paths).
  const failureText = (() => {
    switch (status?.last_result?.error) {
      case 'folder_missing':
        return t('events.externalSource.failedMissing', 'The last import failed: the folder can no longer be found.');
      case 'permission_denied':
        return t('events.externalSource.failedPermission', 'The last import failed: PicPeak is not allowed to read the folder.');
      default:
        return t('events.externalSource.failedGeneric', 'The last import failed.');
    }
  })();
  const lastScan = status?.finished_at
    ? t('events.externalSource.lastScan', 'Last scan {{when}}', { when: formatDistanceToNow(new Date(status.finished_at), { addSuffix: true }) })
    : t('events.externalSource.neverScanned', 'Not scanned yet');
  const buttonLabel = failed
    ? t('events.externalSource.retry', 'Try again')
    : status?.finished_at ? t('events.externalSource.rescan', 'Rescan') : t('events.externalSource.importNow', 'Import now');
  const statusText = running ? t('events.externalSource.importing', 'Importing…') : lastScan;

  return {
    canImport,
    running,
    failed,
    failureText,
    statusText,
    buttonLabel,
    // Archived galleries are read-only.
    canRun: canImport && !running && !event.is_archived,
    // Photos whose file is gone from the folder (issue 2121).
    missingFiles: status?.missing_files ?? 0,
    run: () => rescan.mutate(),
  };
}
