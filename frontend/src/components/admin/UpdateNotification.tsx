import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowUpCircle, X, ExternalLink, Wrench } from 'lucide-react';
import { api } from '../../config/api';
import { UpdateInstructionsDialog } from './UpdateInstructionsDialog';

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
    <div className="bg-blue-50 dark:bg-blue-900/30 border-l-4 border-blue-500 p-4 mb-4 rounded-r-lg">
      <div className="flex items-start justify-between">
        <div className="flex items-start">
          <ArrowUpCircle className="w-5 h-5 text-blue-500 mt-0.5 mr-3 flex-shrink-0" />
          <div>
            <h4 className="text-sm font-semibold text-blue-800 dark:text-blue-200">
              {t('admin.updates.available', 'Update Available')}
            </h4>
            <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
              {t('admin.updates.newVersion', 'Version {{version}} is available', {
                version: updateInfo.latest.forChannel
              })}
              <span className="text-blue-500 dark:text-blue-400 ml-2">
                ({t('admin.updates.currentVersion', 'Current: {{version}}', {
                  version: updateInfo.current
                })})
              </span>
            </p>
            <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">
              {t('admin.updates.channel', 'Channel: {{channel}}', {
                channel: channelLabel
              })}
            </p>
            {Array.isArray(updateInfo.latestHighlights) && updateInfo.latestHighlights.length > 0 && (
              <div className="mt-2">
                <p className="text-xs font-medium text-blue-700 dark:text-blue-300">
                  {t('admin.updates.newFeatures', 'New features include:')}
                </p>
                <ul className="text-xs text-blue-700 dark:text-blue-300 mt-0.5 list-disc list-inside">
                  {updateInfo.latestHighlights.slice(0, 4).map((h, i) => <li key={i}>{h}</li>)}
                </ul>
              </div>
            )}
            <div className="flex items-center gap-3 mt-2">
              <button
                onClick={() => setShowInstructions(true)}
                className="inline-flex items-center text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-md transition-colors"
              >
                <Wrench className="w-3 h-3 mr-1.5" />
                {t('admin.updates.updateNow', 'Update Now')}
              </button>
              <a
                href="https://github.com/PicPeak/picpeak/releases"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
              >
                {t('admin.updates.viewReleaseNotes', 'View Release Notes')}
                <ExternalLink className="w-3 h-3 ml-1" />
              </a>
            </div>
          </div>
        </div>
        <button
          onClick={handleDismiss}
          className="text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 p-1"
          aria-label={t('common.close', 'Close')}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Update Instructions Dialog */}
      <UpdateInstructionsDialog
        isOpen={showInstructions}
        onClose={() => setShowInstructions(false)}
        targetVersion={updateInfo?.latest?.forChannel}
      />
    </div>
  );
};
