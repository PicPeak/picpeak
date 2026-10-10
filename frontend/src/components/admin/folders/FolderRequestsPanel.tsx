import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Check, ChevronRight, FolderClock, FolderInput, Info, X } from 'lucide-react';
import { Button } from '../../common';
import { foldersService, type FolderRequest, type GalleryFolder } from '../../../services/folders.service';
import { folderPathLabel } from '../../../utils/folderTree';
import { FolderPickerModal } from './FolderPickerModal';
import { folderErrorMessage, invalidateFolderViews } from './folderQueries';

interface FolderRequestsPanelProps {
  eventId: number;
  requests: FolderRequest[];
  folders: GalleryFolder[];
  canManage: boolean;
  /** Show the photos waiting for these requests in the grid. */
  onShowWaiting: () => void;
}

/**
 * Folder requests on the Photos tab (issue 1786). An upload-only role's
 * upload needed folders that did not exist; its photos wait in the closest
 * existing folder. An admin with folders.manage approves (creates the path
 * and moves the photos in), approves into an existing folder instead, or
 * rejects (the photos stay where they are). Everyone else only sees that
 * requests are waiting.
 */
export const FolderRequestsPanel: React.FC<FolderRequestsPanelProps> = ({
  eventId,
  requests,
  folders,
  canManage,
  onShowWaiting,
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [approveAs, setApproveAs] = useState<FolderRequest | null>(null);
  const [busyId, setBusyId] = useState<number | 'all' | null>(null);

  const waitingPhotos = requests.reduce((sum, r) => sum + r.photo_count, 0);
  const failed = (error: unknown) =>
    toast.error(folderErrorMessage(error) || t('photos.folderRequests.failed', 'The folder request could not be updated'));

  const approve = useMutation({
    mutationFn: ({ request, target }: { request: FolderRequest; target: number | null }) =>
      foldersService.approveRequest(eventId, request.id, target),
    onMutate: ({ request }) => setBusyId(request.id),
    onSuccess: (result) => {
      toast.success(t('photos.folderRequests.approved', 'Folder request approved, {{count}} photos moved', { count: result.moved }));
      setApproveAs(null);
    },
    onError: failed,
    onSettled: () => {
      setBusyId(null);
      invalidateFolderViews(queryClient, eventId);
    },
  });

  const reject = useMutation({
    mutationFn: (request: FolderRequest) => foldersService.rejectRequest(eventId, request.id),
    onMutate: (request) => setBusyId(request.id),
    onSuccess: () => toast.success(t('photos.folderRequests.rejected', 'Folder request rejected; its photos stay where they are')),
    onError: failed,
    onSettled: () => {
      setBusyId(null);
      invalidateFolderViews(queryClient, eventId);
    },
  });

  // One after another: each approval creates folders the next may share.
  const approveAll = useMutation({
    mutationFn: async () => {
      let moved = 0;
      for (const request of requests) {
        moved += (await foldersService.approveRequest(eventId, request.id)).moved;
      }
      return moved;
    },
    onMutate: () => setBusyId('all'),
    onSuccess: (moved) =>
      toast.success(t('photos.folderRequests.approvedAll', 'All folder requests approved, {{count}} photos moved', { count: moved })),
    onError: failed,
    onSettled: () => {
      setBusyId(null);
      invalidateFolderViews(queryClient, eventId);
    },
  });

  if (requests.length === 0) return null;

  if (!canManage) {
    return (
      <div className="mb-4 flex items-start gap-3 rounded-xl border border-line bg-panel px-4 py-3 text-sm text-body" role="status">
        <Info className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted" />
        <p className="flex-1">
          {t(
            'photos.folderRequests.waitingForAdmin',
            '{{count}} folder requests are waiting for an admin. Until then their {{photos}} photos sit in the closest existing folder.',
            { count: requests.length, photos: waitingPhotos }
          )}
        </p>
        <Button variant="ghost" size="sm" onClick={onShowWaiting}>
          {t('photos.folderRequests.showWaiting', 'Show waiting photos')}
        </Button>
      </div>
    );
  }

  const busy = busyId !== null;

  return (
    <div className="mb-4 rounded-xl border border-warning-line bg-warning px-4 py-3" data-testid="folder-requests">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <FolderClock className="w-5 h-5 text-warning-text" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-heading">
          {t('photos.folderRequests.title', '{{count}} folder requests', { count: requests.length })}
        </h3>
        <span className="text-xs text-soft">
          {t('photos.folderRequests.hint', 'Photos wait in the closest existing folder until you decide.')}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onShowWaiting}>
            {t('photos.folderRequests.showWaiting', 'Show waiting photos')}
          </Button>
          {requests.length > 1 && (
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Check className="w-4 h-4" />}
              onClick={() => approveAll.mutate()}
              disabled={busy}
              isLoading={busyId === 'all'}
            >
              {t('photos.folderRequests.approveAll', 'Approve all')}
            </Button>
          )}
        </div>
      </div>

      <ul className="divide-y divide-line">
        {requests.map((request) => (
          <li key={request.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <span className="flex items-center gap-0.5 text-sm font-medium text-heading min-w-0">
              {request.segments.map((segment, i) => (
                <React.Fragment key={`${segment}-${i}`}>
                  {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-faint" aria-hidden="true" />}
                  <span className="truncate">{segment}</span>
                </React.Fragment>
              ))}
            </span>
            <span className="text-xs text-soft">
              {t('photos.folderRequests.photoCount', '{{count}} photos', { count: request.photo_count })}
              {' · '}
              {t('photos.folderRequests.waitIn', 'waiting in {{folder}}', {
                folder: request.fallback_folder_id
                  ? folderPathLabel(folders, request.fallback_folder_id) || t('photos.folders.galleryRoot', 'Gallery root')
                  : t('photos.folders.galleryRoot', 'Gallery root'),
              })}
              {request.requested_by_name && (
                <>
                  {' · '}
                  {t('photos.folderRequests.requestedBy', 'requested by {{name}}', { name: request.requested_by_name })}
                </>
              )}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                leftIcon={<Check className="w-4 h-4" />}
                onClick={() => approve.mutate({ request, target: null })}
                disabled={busy}
                isLoading={busyId === request.id && approve.isPending}
              >
                {t('photos.folderRequests.approve', 'Approve')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<FolderInput className="w-4 h-4" />}
                onClick={() => setApproveAs(request)}
                disabled={busy || folders.length === 0}
              >
                {t('photos.folderRequests.approveAs', 'Approve as…')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<X className="w-4 h-4" />}
                onClick={() => reject.mutate(request)}
                disabled={busy}
                isLoading={busyId === request.id && reject.isPending}
              >
                {t('photos.folderRequests.reject', 'Reject')}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <FolderPickerModal
        isOpen={approveAs !== null}
        title={t('photos.folderRequests.approveAsTitle', 'Put "{{path}}" into an existing folder', {
          path: approveAs?.segments.join(' › ') ?? '',
        })}
        description={t('photos.folderRequests.approveAsHint', 'Instead of creating the requested folder, its photos move into the folder you pick (for example "Samstag" into "Saturday").')}
        confirmLabel={t('photos.folderRequests.approve', 'Approve')}
        folders={folders}
        isLoading={approve.isPending}
        onClose={() => setApproveAs(null)}
        onConfirm={(target) => {
          if (approveAs && target !== null) approve.mutate({ request: approveAs, target });
        }}
      />
    </div>
  );
};

FolderRequestsPanel.displayName = 'FolderRequestsPanel';
