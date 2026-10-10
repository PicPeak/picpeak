import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { clsx } from 'clsx';
import { ChevronRight, Download, DownloadCloud, Folder, FolderClock, FolderInput, FolderPlus, FolderTree, Pencil, Trash2 } from 'lucide-react';
import { Button, useConfirm } from '../../common';
import { foldersService, type GalleryFolder } from '../../../services/folders.service';
import type { PhotoFolderFilter } from '../../../services/photos.service';
import {
  childFolders,
  downloadsBlockedBy,
  folderAncestry,
  folderDepth,
  moveTargetsFor,
  recursivePhotoCount,
  subtreeHeight,
} from '../../../utils/folderTree';
import { FolderNameModal } from './FolderNameModal';
import { FolderPickerModal } from './FolderPickerModal';
import { folderErrorMessage, invalidateFolderViews } from './folderQueries';

interface FolderBrowserProps {
  eventId: number;
  folders: GalleryFolder[];
  canManage: boolean;
  maxDepth: number;
  /** The grid's folder filter: undefined = all photos, 'root', a folder id, or 'pending'. */
  value: PhotoFolderFilter | undefined;
  onChange: (value: PhotoFolderFilter | undefined) => void;
  /** Photos waiting for a folder request; offers the "waiting" view when > 0. */
  pendingPhotoCount: number;
}

/**
 * Folder bar of the event's Photos tab (issue 1786): a breadcrumb and the
 * subfolders of the current level, filtering the grid by folder the way the
 * guest gallery opens one folder at a time. "All photos" keeps the old flat
 * list. Editing (create, rename, move, delete, per-folder downloads) needs
 * folders.manage; the server checks it again.
 */
export const FolderBrowser: React.FC<FolderBrowserProps> = ({
  eventId,
  folders,
  canManage,
  maxDepth,
  value,
  onChange,
  pendingPhotoCount,
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [dialog, setDialog] = useState<'create' | 'rename' | 'move' | null>(null);

  const current = typeof value === 'number' ? folders.find((f) => f.id === value) ?? null : null;
  const parentId = current?.id ?? null;
  const trail = current ? folderAncestry(folders, current.id) : [];
  const levelFolders = value === 'pending' ? [] : childFolders(folders, parentId);
  const canCreateHere = !current || folderDepth(folders, current.id) < maxDepth;
  const blockedBy = current ? downloadsBlockedBy(folders, current.id) : null;

  const onError = (fallback: string) => (error: unknown) => toast.error(folderErrorMessage(error) || fallback);
  const done = () => invalidateFolderViews(queryClient, eventId);

  const createMutation = useMutation({
    mutationFn: (name: string) => foldersService.create(eventId, name, parentId),
    onSuccess: () => {
      toast.success(t('photos.folders.created', 'Folder created'));
      setDialog(null);
      done();
    },
    onError: onError(t('photos.folders.createFailed', 'The folder could not be created')),
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => foldersService.update(eventId, id, { name }),
    onSuccess: () => {
      toast.success(t('photos.folders.renamed', 'Folder renamed'));
      setDialog(null);
      done();
    },
    onError: onError(t('photos.folders.updateFailed', 'The folder could not be changed')),
  });

  const moveMutation = useMutation({
    mutationFn: ({ id, parent }: { id: number; parent: number | null }) =>
      foldersService.update(eventId, id, { parent_id: parent }),
    onSuccess: () => {
      toast.success(t('photos.folders.moved', 'Folder moved'));
      setDialog(null);
      done();
    },
    onError: onError(t('photos.folders.updateFailed', 'The folder could not be changed')),
  });

  const downloadsMutation = useMutation({
    mutationFn: ({ id, allow }: { id: number; allow: boolean }) =>
      foldersService.update(eventId, id, { allow_downloads: allow }),
    onSuccess: (_data, { allow }) => {
      toast.success(allow
        ? t('photos.folders.downloadsOn', 'Downloads allowed in this folder')
        : t('photos.folders.downloadsOff', 'Downloads blocked in this folder and its subfolders'));
      done();
    },
    onError: onError(t('photos.folders.updateFailed', 'The folder could not be changed')),
  });

  const deleteMutation = useMutation({
    mutationFn: (folder: GalleryFolder) => foldersService.remove(eventId, folder.id),
    onSuccess: (_data, folder) => {
      toast.success(t('photos.folders.deleted', 'Folder deleted'));
      // The open folder is gone: show where its photos went.
      if (value === folder.id) onChange(folder.parent_id ?? 'root');
      done();
    },
    onError: onError(t('photos.folders.deleteFailed', 'The folder could not be deleted')),
  });

  const handleDelete = async (folder: GalleryFolder) => {
    const parent = folder.parent_id == null ? null : folders.find((f) => f.id === folder.parent_id);
    const ok = await confirm({
      title: t('photos.folders.deleteTitle', 'Delete folder "{{name}}"?', { name: folder.name }),
      message: t(
        'photos.folders.deleteMessage',
        'Its photos ({{photos}}) and subfolders ({{folders}}) move to {{parent}}. No photo is deleted.',
        {
          photos: folder.photo_count,
          folders: childFolders(folders, folder.id).length,
          parent: parent ? `"${parent.name}"` : t('photos.folders.galleryRoot', 'Gallery root'),
        }
      ),
      variant: 'danger',
      confirmLabel: t('photos.folders.delete', 'Delete folder'),
    });
    if (ok) deleteMutation.mutate(folder);
  };

  const moveTargets = current ? moveTargetsFor(folders, current.id, maxDepth) : new Set<number>();

  const crumbClass = (active: boolean) =>
    clsx(
      'px-2 py-1 rounded-md text-sm transition-colors',
      active ? 'bg-accent-dark/10 text-heading font-medium' : 'text-body hover:bg-hover'
    );

  return (
    <div className="mb-4 rounded-xl border border-line bg-panel px-4 py-3 space-y-3" data-testid="folder-browser">
      <div className="flex flex-wrap items-center gap-2">
        <FolderTree className="w-5 h-5 text-muted shrink-0" aria-hidden="true" />
        <button type="button" className={crumbClass(value === undefined)} onClick={() => onChange(undefined)}>
          {t('photos.folders.allPhotos', 'All photos')}
        </button>
        <span className="h-4 w-px bg-line-strong" aria-hidden="true" />
        <nav aria-label={t('photos.folders.breadcrumb', 'Folder path')} className="flex flex-wrap items-center gap-0.5 min-w-0">
          <button
            type="button"
            className={crumbClass(value === 'root')}
            onClick={() => onChange('root')}
            aria-current={value === 'root' ? 'location' : undefined}
          >
            {t('photos.folders.galleryRoot', 'Gallery root')}
          </button>
          {trail.map((folder) => (
            <React.Fragment key={folder.id}>
              <ChevronRight className="w-4 h-4 text-faint" aria-hidden="true" />
              <button
                type="button"
                className={crumbClass(value === folder.id)}
                onClick={() => onChange(folder.id)}
                aria-current={value === folder.id ? 'location' : undefined}
              >
                {folder.name}
              </button>
            </React.Fragment>
          ))}
          {value === 'pending' && (
            <>
              <ChevronRight className="w-4 h-4 text-faint" aria-hidden="true" />
              <span className={crumbClass(true)}>{t('photos.folders.waitingView', 'Waiting for folder requests')}</span>
            </>
          )}
        </nav>

        {canManage && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {value !== 'pending' && (
              <Button
                variant="outline"
                size="sm"
                leftIcon={<FolderPlus className="w-4 h-4" />}
                onClick={() => setDialog('create')}
                disabled={!canCreateHere}
                title={canCreateHere ? undefined : t('photos.folders.maxDepthReached', 'Folders nest at most {{depth}} levels deep', { depth: maxDepth })}
              >
                {current ? t('photos.folders.newSubfolder', 'New subfolder') : t('photos.folders.newFolder', 'New folder')}
              </Button>
            )}
            {current && (
              <>
                <Button variant="ghost" size="sm" leftIcon={<Pencil className="w-4 h-4" />} onClick={() => setDialog('rename')}>
                  {t('photos.folders.rename', 'Rename')}
                </Button>
                <Button variant="ghost" size="sm" leftIcon={<FolderInput className="w-4 h-4" />} onClick={() => setDialog('move')}>
                  {t('photos.folders.move', 'Move')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<Trash2 className="w-4 h-4" />}
                  onClick={() => handleDelete(current)}
                  disabled={deleteMutation.isPending}
                  className="text-danger-text"
                >
                  {t('photos.folders.delete', 'Delete folder')}
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {current && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {canManage ? (
            <label className="inline-flex items-center gap-2 cursor-pointer text-body">
              <input
                type="checkbox"
                checked={current.allow_downloads}
                disabled={downloadsMutation.isPending}
                onChange={(e) => downloadsMutation.mutate({ id: current.id, allow: e.target.checked })}
                className="rounded border-line-strong text-accent focus:ring-accent"
              />
              {current.allow_downloads ? (
                <DownloadCloud className="w-4 h-4 text-success-text" aria-hidden="true" />
              ) : (
                <Download className="w-4 h-4 text-faint" aria-hidden="true" />
              )}
              {t('photos.folders.allowDownloads', 'Allow downloads in this folder')}
            </label>
          ) : (
            <span className="text-soft">
              {current.allow_downloads
                ? t('photos.folders.downloadsAllowed', 'Downloads allowed')
                : t('photos.folders.downloadsBlocked', 'Downloads blocked')}
            </span>
          )}
          <span className="text-muted">
            {blockedBy
              ? t('photos.folders.downloadsBlockedBy', 'Blocked anyway by the parent folder "{{name}}".', { name: blockedBy.name })
              : t('photos.folders.downloadsInherit', 'Subfolders inherit this: a folder that blocks downloads blocks them in every folder below it.')}
          </span>
        </div>
      )}

      {(levelFolders.length > 0 || (pendingPhotoCount > 0 && value !== 'pending')) && (
        <div className="flex flex-wrap gap-2">
          {levelFolders.map((folder) => (
            <button
              key={folder.id}
              type="button"
              onClick={() => onChange(folder.id)}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-line bg-subtle hover:bg-hover text-sm text-heading transition-colors"
            >
              <Folder className="w-4 h-4 text-muted" aria-hidden="true" />
              <span className="truncate max-w-[14rem]">{folder.name}</span>
              <span className="text-xs tabular-nums text-soft">{recursivePhotoCount(folders, folder.id)}</span>
            </button>
          ))}
          {pendingPhotoCount > 0 && value !== 'pending' && (
            <button
              type="button"
              onClick={() => onChange('pending')}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-warning-line bg-warning-soft text-sm text-warning-text"
            >
              <FolderClock className="w-4 h-4" aria-hidden="true" />
              {t('photos.folders.waitingChip', 'Waiting for a folder')}
              <span className="text-xs tabular-nums">{pendingPhotoCount}</span>
            </button>
          )}
        </div>
      )}

      <FolderNameModal
        isOpen={dialog === 'create'}
        title={current
          ? t('photos.folders.newSubfolderIn', 'New subfolder in "{{name}}"', { name: current.name })
          : t('photos.folders.newFolder', 'New folder')}
        confirmLabel={t('photos.folders.create', 'Create')}
        isLoading={createMutation.isPending}
        onClose={() => setDialog(null)}
        onConfirm={(name) => createMutation.mutate(name)}
      />
      {current && (
        <>
          <FolderNameModal
            isOpen={dialog === 'rename'}
            title={t('photos.folders.renameTitle', 'Rename folder')}
            confirmLabel={t('common.save', 'Save')}
            initialName={current.name}
            isLoading={renameMutation.isPending}
            onClose={() => setDialog(null)}
            onConfirm={(name) => renameMutation.mutate({ id: current.id, name })}
          />
          <FolderPickerModal
            isOpen={dialog === 'move'}
            title={t('photos.folders.moveTitle', 'Move "{{name}}" to…', { name: current.name })}
            description={subtreeHeight(folders, current.id) > 0
              ? t('photos.folders.moveHint', 'Its subfolders and photos move with it. Folders nest at most {{depth}} levels deep.', { depth: maxDepth })
              : undefined}
            confirmLabel={t('photos.folders.move', 'Move')}
            folders={folders}
            allowRoot
            isDisabled={(id) => !moveTargets.has(id)}
            initialValue={current.parent_id}
            isLoading={moveMutation.isPending}
            onClose={() => setDialog(null)}
            onConfirm={(parent) => moveMutation.mutate({ id: current.id, parent })}
          />
        </>
      )}
    </div>
  );
};

FolderBrowser.displayName = 'FolderBrowser';
