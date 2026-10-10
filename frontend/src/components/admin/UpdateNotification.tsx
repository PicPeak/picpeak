import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowUpCircle, X, ExternalLink, Wrench } from 'lucide-react';
import { api } from '../../config/api';
import { UpdateInstructionsDialog } from './UpdateInstructionsDialog';
import { Notice } from '../common';

interface UpdateInfo {
  enabled: boolean;
  current: string;
  channel: 'stable' | 'beta';
  latest: {
    stable: string;
    beta: string;
    forChannel: string;
  };
  updateAvailable: boolean;
  newerBetaAvailable?: boolean;
  /** Running a pre-rename stable build, i.e. still pulling the retired
   *  ghcr.io/the-luap/picpeak/* path (#985). Such installs predate
   *  MigrationBanner and can never render it, so the notice rides here. */
  registryMigrationRequired?: boolean;
  lastChecked: string;
  error?: string;
  message?: string;
  /** Top highlights of the target version (pre-update teaser). */
  latestHighlights?: string[];
}

async function fetchUpdateInfo(): Promise<UpdateInfo> {
  const response = await api.get<UpdateInfo>('/admin/system/updates');
  return response.data;
}

interface UpdateNotificationProps {
  onDismiss?: () => void;
}

export const UpdateNotification: React.FC<UpdateNotificationProps> = ({ onDismiss }) => {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);

  const { data: updateInfo } = useQuery({
    queryKey: ['update-check'],
    queryFn: fetchUpdateInfo,
    staleTime: 60 * 60 * 1000, // 1 hour
    retry: false,
    refetchOnWindowFocus: false
  });

  // Don't render if no update available, not enabled, or dismissed
  if (!updateInfo?.enabled || !updateInfo?.updateAvailable || dismissed) {
    return null;
  }

  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };

  const channelLabel = updateInfo.channel === 'beta'
    ? t('admin.updates.channelBeta', 'Beta')
    : t('admin.updates.channelStable', 'Stable');

  return (
    <>
      <Notice
        tone="info"
        className="mb-4 relative pr-10"
        icon={<ArrowUpCircle className="w-5 h-5" />}
        title={<span className="font-semibold">{t('admin.updates.available', 'Update Available')}</span>}
      >
        <p>
          {t('admin.updates.newVersion', 'Version {{version}} is available', {
            version: updateInfo.latest.forChannel
          })}
          <span className="text-muted ml-2">
            ({t('admin.updates.currentVersion', 'Current: {{version}}', {
              version: updateInfo.current
            })})
          </span>
        </p>
        <p className="text-xs text-soft mt-1">
          {t('admin.updates.channel', 'Channel: {{channel}}', {
            channel: channelLabel
          })}
        </p>
        {/* Pre-rename install (#985): pulling the retired registry path means
            `docker compose pull` succeeds against a frozen tag and the update
            never actually arrives. These builds predate MigrationBanner, so
            this is the only place the instruction can reach them. */}
        {updateInfo.registryMigrationRequired && (
          <Notice
            tone="warning"
            size="sm"
            className="mt-2"
            title={t('admin.updates.registryMoved.title', 'Pulling from the retired image registry')}
          >
            {t('admin.updates.registryMoved.body', {
              defaultValue: 'This update will not arrive until you change the image path in docker-compose.yml to {{newPath}}. The old path still responds, so `docker compose pull` appears to succeed while serving the same frozen build.',
              newPath: 'ghcr.io/picpeak/picpeak/{backend,frontend}',
            })}{' '}
            <a
              href="https://github.com/PicPeak/picpeak/blob/main/docs/migration-to-org.md"
              target="_blank"
              rel="noreferrer"
              className="underline hover:no-underline"
            >
              {t('admin.updates.registryMoved.link', 'See migration notes')}
            </a>
          </Notice>
        )}
        {Array.isArray(updateInfo.latestHighlights) && updateInfo.latestHighlights.length > 0 && (
          <div className="mt-2">
            <p className="text-xs font-medium text-heading">
              {t('admin.updates.newFeatures', 'New features include:')}
            </p>
            <ul className="text-xs mt-0.5 list-disc list-inside">
              {updateInfo.latestHighlights.slice(0, 4).map((h, i) => <li key={i}>{h}</li>)}
            </ul>
          </div>
        )}
        <div className="flex items-center gap-3 mt-2">
          <button
            onClick={() => setShowInstructions(true)}
            className="inline-flex items-center text-xs font-medium text-white bg-info hover:opacity-90 px-3 py-1.5 rounded-md transition-colors"
          >
            <Wrench className="w-3 h-3 mr-1.5" />
            {t('admin.updates.updateNow', 'Update Now')}
          </button>
          <a
            href="https://github.com/PicPeak/picpeak/releases"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center text-xs text-accent"
          >
            {t('admin.updates.viewReleaseNotes', 'View Release Notes')}
            <ExternalLink className="w-3 h-3 ml-1" />
          </a>
        </div>
        <button
          onClick={handleDismiss}
          className="absolute top-2 right-2 text-muted hover:text-heading p-1"
          aria-label={t('common.close', 'Close')}
        >
          <X className="w-4 h-4" />
        </button>
      </Notice>

      {/* Update Instructions Dialog */}
      <UpdateInstructionsDialog
        isOpen={showInstructions}
        onClose={() => setShowInstructions(false)}
        targetVersion={updateInfo?.latest?.forChannel}
      />
    </>
  );
};
