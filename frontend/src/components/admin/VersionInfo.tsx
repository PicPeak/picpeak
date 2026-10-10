import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Info, ArrowUpCircle } from 'lucide-react';
import { api } from '../../config/api';
import { githubReleaseUrl as releaseUrl } from '../../utils/githubReleaseUrl';
import {
  setDismissedVersion,
  shouldShowUpdateChip,
} from '../../utils/updateDismissal';
import { UpdateAvailableModal } from './UpdateAvailableModal';
import { Badge } from '../common';
import packageJson from '../../../package.json';

// Frontend version from package.json
const FRONTEND_VERSION = packageJson.version;

interface SystemVersion {
  backend: string;
  frontend: string;
  node: string;
  environment: string;
  channel?: 'stable' | 'beta';
  // True on the all-in-one image; some features are unavailable there.
  single_container?: boolean;
}

interface UpdateInfo {
  enabled: boolean;
  updateAvailable: boolean;
  current?: string;
  latest?: {
    forChannel: string;
  };
}

async function fetchSystemVersion(): Promise<SystemVersion> {
  const response = await api.get<SystemVersion>('/admin/system/version');
  return response.data;
}

async function fetchUpdateInfo(): Promise<UpdateInfo> {
  const response = await api.get<UpdateInfo>('/admin/system/updates');
  return response.data;
}

export const VersionInfo: React.FC = () => {
  const { t } = useTranslation();
  const [modalOpen, setModalOpen] = useState(false);
  // Re-render trigger so dismissing in the modal immediately hides the
  // chip without waiting for the next route change. State value is
  // irrelevant; we just bump it.
  const [dismissBump, setDismissBump] = useState(0);

  const { data: versionInfo } = useQuery({
    queryKey: ['system-version'],
    queryFn: fetchSystemVersion,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  const { data: updateInfo } = useQuery({
    queryKey: ['update-check'],
    queryFn: fetchUpdateInfo,
    staleTime: 60 * 60 * 1000, // 1 hour
    retry: false
  });

  const channelBadge = versionInfo?.channel === 'beta' ? (
    <Badge tone="warning" caps className="ml-1">
      {t('admin.updates.beta', 'BETA')}
    </Badge>
  ) : null;

  const latestVersion = updateInfo?.latest?.forChannel;
  const currentVersion = updateInfo?.current || versionInfo?.backend || FRONTEND_VERSION;
  // `dismissBump` referenced here so React re-runs the dismissal check
  // immediately after the modal calls handleDismiss; the value itself
  // is unused. Voiding it keeps lint happy without an eslint-disable.
  void dismissBump;
  const showUpdateChip = updateInfo?.enabled
    && updateInfo?.updateAvailable
    && !!latestVersion
    && shouldShowUpdateChip(latestVersion);

  const handleDismiss = (version: string) => {
    setDismissedVersion(version);
    setDismissBump((n) => n + 1);
  };

  return (
    <>
      <div className="px-4 py-3 border-t border-line">
        <div className="flex items-center gap-2 text-xs text-soft">
          <Info className="w-3 h-3" />
          <span className="font-medium">{t('admin.version')}</span>
          {channelBadge}
        </div>
        <div className="mt-1 space-y-0.5 text-xs text-muted">
          <div>
            Frontend:{' '}
            <a
              href={releaseUrl(FRONTEND_VERSION)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted hover:text-body hover:underline"
              title={t('admin.viewReleaseNotes', 'View release notes on GitHub')}
            >
              v{FRONTEND_VERSION}
            </a>
          </div>
          {versionInfo && (
            <div>
              Backend:{' '}
              <a
                href={releaseUrl(versionInfo.backend)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted hover:text-body hover:underline"
                title={t('admin.viewReleaseNotes', 'View release notes on GitHub')}
              >
                v{versionInfo.backend}
              </a>
            </div>
          )}
        </div>
        {showUpdateChip && (
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="mt-2 flex items-center gap-1 text-xs text-accent hover:underline cursor-pointer"
            title={t('admin.updates.viewDetails', 'View release notes and upgrade instructions')}
          >
            <ArrowUpCircle className="w-3 h-3" />
            <span>
              {t('admin.updates.updateAvailableShort', 'v{{version}} available', {
                version: latestVersion
              })}
            </span>
          </button>
        )}
      </div>
      {modalOpen && latestVersion && (
        <UpdateAvailableModal
          currentVersion={currentVersion}
          latestVersion={latestVersion}
          onClose={() => setModalOpen(false)}
          onDismiss={handleDismiss}
        />
      )}
    </>
  );
};
