import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  HardDrive,
  Database,
  FileArchive,
  Image,
  Clock,
  CheckCircle,
  AlertCircle,
  Shield,
  Server,
  Cloud,
  Play,
  Loader2,
  AlertTriangle,
  Info
} from 'lucide-react';
// Per [[feedback_respect_general_format_settings]] — route every
// displayed date/time through useLocalizedDate so general_date_format
// and general_time_format settings apply uniformly.
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { Card, Button } from '../common';

export type HealthStatus = 'excellent' | 'good' | 'warning' | 'critical';
export type BackupDestinationType = 's3' | 'rsync' | 'local';

interface BackupStatistics {
  total_size?: number;
  files_processed?: number;
  database_backed_up?: boolean;
  photos_backed_up?: number;
  total_photos?: number;
  archives_backed_up?: number;
  photo_count?: number;
}

interface BackupRecord {
  id: number;
  status: 'completed' | 'failed' | 'running';
  backup_type: string;
  created_at: string;
  duration_seconds: number;
  started_at?: string;
  error_message?: string;
  statistics?: BackupStatistics;
}

interface BackupStatus {
  lastBackup?: BackupRecord;             // most recent attempt, any status
  lastSuccessfulBackup?: BackupRecord;   // most recent completed run
  zombieRuns?: BackupRecord[];           // running > 30min, likely crashed
  totalBackups?: number;
  recentBackups?: BackupRecord[];
}

interface BackupConfig {
  backup_destination_type?: BackupDestinationType;
  backup_enabled?: boolean;
  backup_s3_bucket?: string;
  backup_destination_path?: string;
  backup_rsync_host?: string;
  backup_retention_days?: number;
}

interface StatCardProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  color?: string;
  subtext?: string;
}

interface BackupDashboardProps {
  status?: BackupStatus;
  config?: BackupConfig;
  onRunBackup: () => void;
  isBackupRunning: boolean;
}

const StatCard: React.FC<StatCardProps> = ({ icon: Icon, label, value, color = 'blue', subtext }) => (
  <Card className="p-6">
    <div className="flex items-center justify-between">
      <div className="flex-1">
        <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">{label}</p>
        <p className="mt-2 text-3xl font-semibold text-neutral-900 dark:text-neutral-100">{value}</p>
        {subtext && (
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{subtext}</p>
        )}
      </div>
      <div className={`p-3 bg-${color}-100 dark:bg-${color}-900/40 rounded-lg`}>
        <Icon className={`h-6 w-6 text-${color}-600 dark:text-${color}-400`} />
      </div>
    </div>
  </Card>
);

const formatBytes = (bytes: number): string => {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
};

const healthColors: Record<HealthStatus, string> = {
  excellent: 'green',
  good: 'blue',
  warning: 'amber',
  critical: 'red',
};

export const BackupDashboard: React.FC<BackupDashboardProps> = ({ status, config, onRunBackup, isBackupRunning }) => {
  const { t } = useTranslation();
  const { format, formatTime, formatDateTime, formatDistanceToNow } = useLocalizedDate();
  const lastBackup = status?.lastBackup;                       // any status
  const lastSuccessfulBackup = status?.lastSuccessfulBackup;   // status='completed' only
  const zombieRuns = status?.zombieRuns ?? [];
  const statistics = lastSuccessfulBackup?.statistics ?? lastBackup?.statistics ?? {};
  const isConfigured = config && config.backup_destination_type;
  const isEnabled = config?.backup_enabled;

  // Use the most recent SUCCESSFUL backup as the "age" reference for
  // health, so a transient failure doesn't immediately drop the score
  // — but call out failed/running/zombie attempts explicitly so the
  // admin sees them at a glance.
  const getHealthScore = (): { score: number; status: HealthStatus; message: string } => {
    if (!lastSuccessfulBackup) {
      // No successful backup ever recorded.
      if (lastBackup?.status === 'failed') {
        return { score: 0, status: 'critical', message: t('backup.dashboard.healthMessages.lastBackupFailed') };
      }
      return { score: 0, status: 'critical', message: t('backup.dashboard.healthMessages.noBackups') };
    }

    const hoursSinceBackup = (Date.now() - new Date(lastSuccessfulBackup.created_at).getTime()) / (1000 * 60 * 60);

    // A successful backup exists. Bias the score on its age, but if
    // the MOST RECENT attempt failed, downgrade the message so the
    // admin sees the regression even though older backups are fine.
    const latestAttemptFailed = lastBackup && lastBackup.id !== lastSuccessfulBackup.id
      && lastBackup.status === 'failed';

    if (latestAttemptFailed) {
      return {
        score: 50,
        status: 'warning',
        message: t('backup.dashboard.healthMessages.lastBackupFailed'),
      };
    }

    if (hoursSinceBackup < 24) {
      return { score: 100, status: 'excellent', message: t('backup.dashboard.healthMessages.upToDate') };
    } else if (hoursSinceBackup < 48) {
      return { score: 75, status: 'good', message: t('backup.dashboard.healthMessages.recent') };
    } else if (hoursSinceBackup < 168) {
      return { score: 50, status: 'warning', message: t('backup.dashboard.healthMessages.gettingOld') };
    } else {
      return { score: 25, status: 'critical', message: t('backup.dashboard.healthMessages.outdated') };
    }
  };

  const health = getHealthScore();

  return (
    <div className="space-y-6">
      {/* Configuration Alert */}
      {!isConfigured && (
        <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
          <div className="flex">
            <AlertTriangle className="h-5 w-5 text-amber-400 mt-0.5" />
            <div className="ml-3">
              <h3 className="text-sm font-medium text-amber-800 dark:text-amber-200">
                {t('backup.dashboard.notConfigured.title')}
              </h3>
              <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
                {t('backup.dashboard.notConfigured.message')}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Health Score Card */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t('backup.dashboard.health.title')}</h3>
          <span className={`px-3 py-1 rounded-full text-sm font-medium bg-${healthColors[health.status]}-100 dark:bg-${healthColors[health.status]}-900/40 text-${healthColors[health.status]}-700 dark:text-${healthColors[health.status]}-300`}>
            {t(`backup.dashboard.healthStatus.${health.status}`)}
          </span>
        </div>

        <div className="flex items-center space-x-4">
          <div className="relative w-24 h-24">
            <svg className="w-24 h-24 transform -rotate-90">
              <circle
                cx="48"
                cy="48"
                r="36"
                stroke="currentColor"
                strokeWidth="8"
                fill="none"
                className="text-neutral-200 dark:text-neutral-700"
              />
              <circle
                cx="48"
                cy="48"
                r="36"
                stroke="currentColor"
                strokeWidth="8"
                fill="none"
                strokeDasharray={`${(health.score / 100) * 226} 226`}
                className={`text-${healthColors[health.status]}-500`}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{health.score}%</span>
            </div>
          </div>

          <div className="flex-1">
            <p className="text-neutral-700 dark:text-neutral-300 font-medium">{health.message}</p>
            {/* Show the last successful backup explicitly — previously
                this read `lastBackup.created_at` which silently rendered
                a failed/running row as if it were the last success. */}
            {lastSuccessfulBackup && (
              <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
                {t('backup.dashboard.lastSuccessful', 'Last successful backup')}: {formatDistanceToNow(new Date(lastSuccessfulBackup.created_at), { addSuffix: true })}
              </p>
            )}
            {/* If the most recent attempt is NOT the last successful
                run, surface it separately so the admin sees the
                divergence (latest attempt failed or running). */}
            {lastBackup && lastBackup.id !== lastSuccessfulBackup?.id && (
              <p className={`text-sm mt-1 ${
                lastBackup.status === 'failed'
                  ? 'text-red-600 dark:text-red-400 font-medium'
                  : lastBackup.status === 'running'
                    ? 'text-blue-600 dark:text-blue-400'
                    : 'text-neutral-500 dark:text-neutral-400'
              }`}>
                {t('backup.dashboard.lastAttempt', 'Last attempt')}: {formatDistanceToNow(new Date(lastBackup.created_at), { addSuffix: true })}
                {' · '}
                {t(`backup.dashboard.status.${lastBackup.status}`, lastBackup.status)}
                {lastBackup.status === 'failed' && lastBackup.error_message && (
                  <span className="block text-xs text-red-600 dark:text-red-400 mt-0.5">
                    {lastBackup.error_message.split('\n')[0].slice(0, 200)}
                  </span>
                )}
              </p>
            )}
            {/* Zombie warning — running >30min, almost certainly crashed.
                Admin needs to know they may be looking at a hung row
                that won't ever flip to completed. */}
            {zombieRuns.length > 0 && (
              <p className="text-sm mt-1 text-amber-700 dark:text-amber-300 font-medium">
                {t('backup.dashboard.zombieRuns',
                  '{{count}} backup(s) running >30min — may have crashed without completing',
                  { count: zombieRuns.length })}
              </p>
            )}

            <Button
              onClick={onRunBackup}
              disabled={!isConfigured || !isEnabled || isBackupRunning}
              className="mt-3"
              size="sm"
            >
              {isBackupRunning ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('backup.dashboard.actions.running')}
                </>
              ) : (
                <>
                  <Play className="mr-2 h-4 w-4" />
                  {t('backup.dashboard.actions.runBackupNow')}
                </>
              )}
            </Button>
          </div>
        </div>
      </Card>

      {/* Statistics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={FileArchive}
          label={t('backup.dashboard.stats.totalBackups')}
          value={status?.totalBackups || 0}
          color="blue"
          subtext={lastBackup ? `${t('backup.dashboard.stats.last')}: ${format(new Date(lastBackup.created_at))}` : t('backup.dashboard.stats.noBackupsYet')}
        />

        <StatCard
          icon={HardDrive}
          label={t('backup.dashboard.stats.backupSize')}
          value={formatBytes(statistics.total_size || 0)}
          color="green"
          subtext={`${statistics.files_processed || 0} ${t('backup.dashboard.stats.files')}`}
        />

        <StatCard
          icon={Clock}
          label={t('backup.dashboard.stats.lastDuration')}
          value={lastBackup ? `${Math.round(lastBackup.duration_seconds / 60)}m` : 'N/A'}
          color="purple"
          subtext={lastBackup ? formatTime(new Date(lastBackup.created_at)) : ''}
        />

        <StatCard
          icon={Shield}
          label={t('backup.dashboard.stats.backupStatus')}
          value={isEnabled ? t('backup.dashboard.stats.active') : t('backup.dashboard.stats.inactive')}
          color={isEnabled ? 'green' : 'gray'}
          subtext={config?.backup_destination_type || t('backup.dashboard.notConfigured.title')}
        />
      </div>

      {/* Recent Activity */}
      {status?.recentBackups && status.recentBackups.length > 0 && (
        <Card className="p-6">
          <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('backup.dashboard.recentActivity.title')}</h3>
          <div className="space-y-3">
            {status.recentBackups.slice(0, 5).map((backup) => (
              <div key={backup.id} className="flex items-center justify-between py-3 border-b border-neutral-100 dark:border-neutral-700 last:border-0">
                <div className="flex items-center space-x-3">
                  {backup.status === 'completed' ? (
                    <CheckCircle className="h-5 w-5 text-green-500" />
                  ) : backup.status === 'failed' ? (
                    <AlertCircle className="h-5 w-5 text-red-500" />
                  ) : (
                    <Loader2 className="h-5 w-5 text-blue-500 animate-spin" />
                  )}
                  <div>
                    <p className="font-medium text-neutral-900 dark:text-neutral-100">
                      {t('backup.dashboard.backupType', { type: backup.backup_type })}
                    </p>
                    <p className="text-sm text-neutral-500 dark:text-neutral-400">
                      {formatDateTime(new Date(backup.created_at))}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    {formatBytes(backup.statistics?.total_size || 0)}
                  </p>
                  <p className="text-sm text-neutral-500 dark:text-neutral-400">
                    {backup.statistics?.files_processed || 0} files
                  </p>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Storage Status */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-6">
          <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('backup.dashboard.coverage.title')}</h3>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Database className="h-5 w-5 text-neutral-400" />
                <span className="text-neutral-700 dark:text-neutral-300">Database</span>
              </div>
              <span className={`px-2 py-1 rounded text-xs font-medium ${
                statistics.database_backed_up ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300' : 'bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300'
              }`}>
                {statistics.database_backed_up ? t('backup.dashboard.coverage.included') : t('backup.dashboard.coverage.excluded')}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Image className="h-5 w-5 text-neutral-400" />
                <span className="text-neutral-700 dark:text-neutral-300">{t('backup.configuration.whatToBackup.photos')}</span>
              </div>
              <span className="text-sm text-neutral-500 dark:text-neutral-400">
                {statistics.photos_backed_up || 0} {t('common.of')} {statistics.total_photos || 0}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <FileArchive className="h-5 w-5 text-neutral-400" />
                <span className="text-neutral-700 dark:text-neutral-300">{t('backup.configuration.whatToBackup.archives')}</span>
              </div>
              <span className="text-sm text-neutral-500 dark:text-neutral-400">
                {statistics.archives_backed_up || 0} {t('backup.dashboard.stats.files')}
              </span>
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('backup.dashboard.storageDestination')}</h3>
          <div className="space-y-3">
            <div className="flex items-center space-x-3">
              {config?.backup_destination_type === 's3' ? (
                <Cloud className="h-5 w-5 text-blue-500" />
              ) : config?.backup_destination_type === 'rsync' ? (
                <Server className="h-5 w-5 text-purple-500" />
              ) : (
                <HardDrive className="h-5 w-5 text-neutral-500" />
              )}
              <div>
                <p className="font-medium text-neutral-900 dark:text-neutral-100">
                  {config?.backup_destination_type
                    ? t(`backup.configuration.destinationTypes.${config.backup_destination_type}.name`)
                    : t('backup.dashboard.notConfigured.title')}
                </p>
                <p className="text-sm text-neutral-500 dark:text-neutral-400">
                  {config?.backup_destination_type === 's3' && config?.backup_s3_bucket
                    ? `Bucket: ${config.backup_s3_bucket}`
                    : config?.backup_destination_type === 'local' && config?.backup_destination_path
                    ? `Path: ${config.backup_destination_path}`
                    : config?.backup_destination_type === 'rsync' && config?.backup_rsync_host
                    ? `Host: ${config.backup_rsync_host}`
                    : t('backup.dashboard.noDestinationSet')}
                </p>
              </div>
            </div>

            {config?.backup_retention_days && (
              <div className="mt-4 p-3 bg-neutral-50 dark:bg-neutral-700 rounded-lg">
                <div className="flex items-center space-x-2">
                  <Info className="h-4 w-4 text-neutral-400" />
                  <span className="text-sm text-neutral-600 dark:text-neutral-300">
                    {t('backup.configuration.schedule.retentionDays')} {config.backup_retention_days} {t('backup.configuration.schedule.retentionHelp').replace('days (older backups will be automatically deleted)', '')}
                  </span>
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
};
