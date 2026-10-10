/**
 * The Photos tab's line for a gallery on an external folder: which folder,
 * whether it is watched, when it was last scanned, and a one-click Rescan.
 * The folder itself is chosen in Settings → Photo source, never here.
 */
import React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { FolderOpen, FolderTree, RefreshCw } from 'lucide-react';
import type { Event } from '../../../types';
import { Button, useConfirm, Badge } from '../../../components/common';
import { invalidateFolderViews } from '../../../components/admin/folders/folderQueries';
import { foldersService } from '../../../services/folders.service';
import { usePermission } from '../../../hooks/usePermission';
import { useExternalImport } from './useExternalImport';
import { toBoolean } from '../../../utils/parsers';

export const ExternalSourceBar: React.FC<{ event: Event; onChangeFolder: () => void }> = ({ event, onChangeFolder }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const canChangeFolder = usePermission('events.edit') && !event.is_archived;
  const watched = toBoolean(event.external_watch, false);
  const confirm = useConfirm();
  // Folder structure switched on after the first import (issue 1786): the
  // photos already imported are still flat until this mirrors the folder.
  const imp = useExternalImport(event);
  const canManageFolders = usePermission('folders.manage');
  const canApplyStructure = canManageFolders && imp.canImport
    && toBoolean(event.folder_structure, false) && !event.is_archived;

  const applyStructure = useMutation({
    mutationFn: () => foldersService.applyExternalStructure(event.id),
    onSuccess: (result) => {
      toast.success(result.moved > 0
        ? t('events.externalSource.structureApplied', '{{count}} photos moved into folders', { count: result.moved })
        : t('events.externalSource.structureNothing', 'Every photo from a subfolder is in a folder already'));
      invalidateFolderViews(queryClient, event.id);
    },
    onError: (error: unknown) => {
      const e = error as { response?: { data?: { error?: string } } };
      toast.error(e.response?.data?.error || t('events.externalSource.structureFailed', 'The folder structure could not be applied'));
    },
  });

  const handleApplyStructure = async () => {
    const ok = await confirm({
      title: t('events.externalSource.applyStructureTitle', 'Apply the folder structure?'),
      message: t(
        'events.externalSource.applyStructureMessage',
        "Photos that are not in a gallery folder yet move into folders that mirror the external folder's subfolders. Photos already in a folder stay where they are."
      ),
      confirmLabel: t('events.externalSource.applyStructure', 'Apply folder structure'),
    });
    if (ok) applyStructure.mutate();
  };

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3">
      <FolderOpen className="w-5 h-5 text-accent shrink-0" />
      <span className="text-sm text-heading min-w-0">
        {t('events.externalSource.source', 'Source')}{' '}
        <code className="px-1.5 py-0.5 rounded bg-inset text-xs break-all">/external-media/{event.external_path}</code>
      </span>
      {watched && (
        <Badge tone="success">
          {t('events.externalSource.watching', 'Watching for new files')}
        </Badge>
      )}
      {imp.failed ? (
        <span className="text-xs text-danger-text" role="alert">
          {imp.failureText}
        </span>
      ) : (
        <span className="text-xs text-soft" role="status">
          {imp.statusText}
        </span>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {imp.canImport && (
          <Button
            variant="outline"
            size="sm"
            leftIcon={<RefreshCw className={`w-4 h-4 ${imp.running ? 'animate-spin' : ''}`} />}
            onClick={imp.run}
            disabled={!imp.canRun}
          >
            {imp.buttonLabel}
          </Button>
        )}
        {canApplyStructure && (
          <Button
            variant="outline"
            size="sm"
            leftIcon={<FolderTree className="w-4 h-4" />}
            onClick={handleApplyStructure}
            disabled={imp.running || applyStructure.isPending}
            isLoading={applyStructure.isPending}
            title={t('events.externalSource.applyStructureHint', 'Mirror the subfolders onto photos imported before folder structure was on')}
          >
            {t('events.externalSource.applyStructure', 'Apply folder structure')}
          </Button>
        )}
        {canChangeFolder && (
          <Button variant="ghost" size="sm" onClick={onChangeFolder}>
            {t('events.externalSource.changeFolder', 'Change folder')}
          </Button>
        )}
      </div>
    </div>
  );
};
