import React from 'react';
import { ArrowRight, EyeOff, Folder, Image as ImageIcon, Info, Layers, Loader2, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Badge, Notice, Switch, type BadgeTone } from '../common';
import type { FolderNodeStatus } from '../../services/folders.service';
import type { PreviewFolderNode, UploadPreview } from '../../utils/uploadStructure';

interface UploadStructurePreviewProps {
  /** null while the first dry run is in flight. */
  preview: UploadPreview | null;
  isLoading: boolean;
  isError: boolean;
  keepStructure: boolean;
  onKeepStructureChange: (keep: boolean) => void;
  /** The one folder everything was inside, from the dry run. */
  singleRoot: string | null;
  skipOuter: boolean;
  onSkipOuterChange: (skip: boolean) => void;
  canManage: boolean;
  maxDepth: number;
  /** Where loose files go, as shown to the user ("Gallery root", "Friday"). */
  looseTargetLabel: string;
}

const pillTone: Record<FolderNodeStatus, BadgeTone> = {
  exists: 'neutral',
  created: 'neutral',
  new: 'success',
  needs_admin: 'warning',
  requested: 'warning',
};

/**
 * The structure preview of a folder upload (issues 1786 + 1562): the folder
 * tree the upload will create or reuse, the first-look marker, and what an
 * upload-only role's missing folders turn into. Presentational; the dry run
 * and the toggles live in PhotoUpload.
 */
export const UploadStructurePreview: React.FC<UploadStructurePreviewProps> = ({
  preview,
  isLoading,
  isError,
  keepStructure,
  onKeepStructureChange,
  singleRoot,
  skipOuter,
  onSkipOuterChange,
  canManage,
  maxDepth,
  looseTargetLabel,
}) => {
  const { t } = useTranslation();

  const pillLabel = (status: FolderNodeStatus) => {
    switch (status) {
      case 'new':
        return t('upload.structure.statusNew', 'New');
      case 'needs_admin':
      case 'requested':
        return t('upload.structure.statusNeedsAdmin', 'Needs admin');
      default:
        return t('upload.structure.statusExists', 'Exists');
    }
  };

  const renderNode = (node: PreviewFolderNode, depth: number): React.ReactNode => (
    <React.Fragment key={node.path}>
      <li className="flex items-center gap-2 py-1 text-sm" style={{ paddingLeft: depth * 20 + 8 }}>
        <Folder className="w-4 h-4 flex-shrink-0 text-muted" />
        <span className="text-heading truncate">{node.name}</span>
        {node.status && (
          <Badge caps tone={pillTone[node.status]} className="flex-shrink-0">
            {pillLabel(node.status)}
          </Badge>
        )}
        {node.waitsIn !== undefined && (
          <span className="flex items-center gap-1 text-xs text-muted truncate">
            <ArrowRight className="w-3 h-3 flex-shrink-0" />
            {node.waitsIn ?? t('upload.structure.galleryRoot', 'gallery root')}
          </span>
        )}
        <span className="ml-auto pr-1 text-xs tabular-nums text-soft">{node.count}</span>
      </li>
      {node.children.map((child) => renderNode(child, depth + 1))}
    </React.Fragment>
  );

  return (
    <div className="space-y-3" data-testid="upload-structure-preview">
      <Switch
        checked={keepStructure}
        onChange={onKeepStructureChange}
        label={t('upload.structure.keepStructure', 'Keep folder structure')}
        description={t('upload.structure.keepStructureHelp', "Subfolders become gallery folders. The default comes from the event's Folders setting.")}
      />

      {keepStructure && singleRoot && (
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={skipOuter}
            onChange={(e) => onSkipOuterChange(e.target.checked)}
            className="mt-0.5 rounded border-line-strong text-accent focus:ring-accent"
          />
          <span>
            <span className="block text-sm font-medium text-heading">
              {t('upload.structure.skipOuter', 'Skip the outer folder "{{name}}"', { name: singleRoot })}
            </span>
            <span className="block text-xs text-soft">
              {t('upload.structure.skipOuterHelp', "Everything was inside one folder, so it's left out. Otherwise guests would open one extra folder first.")}
            </span>
          </span>
        </label>
      )}

      <div className="rounded-lg border border-line bg-subtle p-2">
        {isError ? (
          <p className="px-2 py-1 text-sm text-danger-text" role="alert">
            {t('upload.structure.previewFailed', 'The folder preview could not be loaded. The upload resolves the folders again when it starts.')}
          </p>
        ) : !preview ? (
          <p className="flex items-center gap-2 px-2 py-1 text-sm text-muted" role="status">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('upload.structure.loading', 'Checking the folders…')}
          </p>
        ) : (
          <ul className={clsx('transition-opacity', isLoading && 'opacity-60')} aria-busy={isLoading}>
            {preview.skippedOuter && (
              <li className="flex items-center gap-2 py-1 px-2 text-sm text-muted line-through">
                <Folder className="w-4 h-4 flex-shrink-0" />
                <span className="truncate">{preview.skippedOuter}</span>
              </li>
            )}
            {preview.firstLook && (
              <li className="flex items-center gap-2 py-1 px-2 rounded bg-warning-soft text-sm">
                <Zap className="w-4 h-4 flex-shrink-0 text-warning-text" />
                <span className="font-medium text-warning-text truncate">{preview.firstLook.name}</span>
                <span className="text-xs text-warning-text truncate">
                  {t('upload.structure.firstLookRow', '→ gallery root, badged "First look"')}
                </span>
                <span className="ml-auto pr-1 text-xs tabular-nums text-warning-text">{preview.firstLook.count}</span>
              </li>
            )}
            {preview.tree.map((node) => renderNode(node, 0))}
            {preview.looseCount > 0 && (
              <li className="flex items-center gap-2 py-1 px-2 text-sm text-soft">
                <ImageIcon className="w-4 h-4 flex-shrink-0" />
                <span className="truncate">
                  {t('upload.structure.looseFiles', '{{count}} loose files → {{target}}', {
                    count: preview.looseCount,
                    target: looseTargetLabel,
                  })}
                </span>
              </li>
            )}
            {preview.hiddenCount > 0 && (
              <li className="flex items-center gap-2 py-1 px-2 text-xs text-muted">
                <EyeOff className="w-4 h-4 flex-shrink-0" />
                {t('upload.structure.hiddenSkipped', '{{count}} files in hidden folders are skipped', { count: preview.hiddenCount })}
              </li>
            )}
          </ul>
        )}
      </div>

      {preview?.folded && keepStructure && (
        <p className="flex items-start gap-2 text-xs text-soft">
          <Layers className="w-4 h-4 flex-shrink-0 mt-0.5" />
          {t('upload.structure.folded', 'Folders deeper than {{depth}} levels are folded into their level-{{depth}} folder.', { depth: maxDepth })}
        </p>
      )}

      {preview && !canManage && preview.requestedFolders > 0 && (
        <Notice tone="neutral" icon={<Info className="w-4 h-4" />}>
          <p>
            {t(
              'upload.structure.needsAdminNotice',
              "{{count}} folders don't exist yet. Your role can upload but not create folders, so they're sent to an admin as folder requests. Until an admin confirms, their {{files}} photos wait in the closest existing folder (shown with →) and move into the new folders automatically once confirmed.",
              { count: preview.requestedFolders, files: preview.waitingFiles }
            )}
          </p>
        </Notice>
      )}

      {preview?.firstLook && (
        <Notice tone="warning" icon={<Zap className="w-4 h-4" />}>
            <p>
              {t(
                'upload.structure.firstLookCallout',
                'First-look folder found: "{{name}}". Its {{count}} photos are badged "First look", and this gallery switches to two-stage delivery: guests see that more photos are on their way until you mark the full gallery as ready.',
                { name: preview.firstLook.name, count: preview.firstLook.count }
              )}
            </p>
            <p className="mt-1 text-xs text-muted">
              {t('upload.structure.firstLookSettings', 'Due date and badge: this gallery’s Settings → Folders & delivery. Keywords: Settings → Events.')}
            </p>
        </Notice>
      )}
    </div>
  );
};

UploadStructurePreview.displayName = 'UploadStructurePreview';
