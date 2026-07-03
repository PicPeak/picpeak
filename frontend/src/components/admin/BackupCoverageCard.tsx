import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ShieldCheck,
  ShieldAlert,
  Database,
  FolderTree,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  EyeOff,
  Clock,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
// Locale-aware formatters per [[feedback_respect_general_format_settings]].
import { useLocalizedDate } from '../../hooks/useLocalizedDate';

import { Card, Button } from '../common';
import {
  adminService,
  BackupCoverageReport,
  BackupPathCoverage,
} from '../../services/admin.service';

/**
 * BackupCoverageCard — Stage C of the backup-hardening plan.
 *
 * Tells the admin what the next "Run Backup Now" will actually do:
 *
 *   - Database: inline-dump or scheduled, last dump age, staleness
 *   - Configured paths: per-row coverage (will-scan / skipped by
 *     toggle / skipped by feature flag / missing on disk)
 *   - Drift: top-level subdirs under STORAGE_PATH that have no
 *     `backup_paths` row (the "feature shipped without a backup row"
 *     footgun this whole effort is designed to catch)
 *
 * Auto-fetches on mount — unlike the integrity verifier, this is
 * a cheap query (no recursion) so admins should always see the
 * current state when they open the tab.
 */
export const BackupCoverageCard: React.FC = () => {
  const { t } = useTranslation();
  const { formatDateTime } = useLocalizedDate();
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['backup-coverage'],
    queryFn: () => adminService.getBackupCoverage(),
    // The report changes only when (a) backup_paths is edited or
    // (b) a new scheduled dump completes. Stale time of 30s keeps
    // the UI snappy without hammering the endpoint.
    staleTime: 30_000,
  });

  return (
    <Card className="p-6">
      <Header report={data} loading={isLoading} onRefresh={() => refetch()} refreshing={isFetching} />

      {isError && (
        <ErrorBanner message={(error as Error)?.message ?? 'unknown error'} />
      )}

      {data && (
        <>
          {data.summary.tableMissingFallbackInUse && (
            <FallbackWarning />
          )}

          <SectionGrid>
            <DatabaseStatusCard database={data.database} />
            <SummaryCard summary={data.summary} />
          </SectionGrid>

          <PathsTable paths={data.paths} />

          <DriftSection drift={data.drift} />

          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-4">
            {t('backup.coverage.generatedAt', 'Coverage generated: {{when}}', {
              when: formatDateTime(new Date(data.generatedAt)),
            })}
          </p>
        </>
      )}
    </Card>
  );
};

const Header: React.FC<{
  report: BackupCoverageReport | undefined;
  loading: boolean;
  onRefresh: () => void;
  refreshing: boolean;
}> = ({ report, loading, onRefresh, refreshing }) => {
  const { t } = useTranslation();
  const healthy = report?.summary.overallOk;
  return (
    <div className="flex items-start justify-between mb-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          {loading || refreshing ? (
            <Loader2 className="w-5 h-5 text-neutral-400 animate-spin" />
          ) : healthy ? (
            <ShieldCheck className="w-5 h-5 text-green-600 dark:text-green-400" />
          ) : report ? (
            <ShieldAlert className="w-5 h-5 text-amber-600 dark:text-amber-400" />
          ) : (
            <ShieldCheck className="w-5 h-5 text-neutral-400" />
          )}
          <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            {t('backup.coverage.title', 'Backup coverage')}
          </h3>
        </div>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 max-w-2xl">
          {t(
            'backup.coverage.description',
            'Shows what the next backup will include, skip, or silently miss. The database block confirms the dump strategy. The "drift" section flags subdirectories that exist on disk but are not in the backup configuration — usually a sign that a new feature shipped without a matching backup_paths row.',
          )}
        </p>
      </div>
      <Button
        variant="ghost"
        onClick={onRefresh}
        disabled={loading || refreshing}
        leftIcon={
          refreshing
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : <RefreshCw className="w-4 h-4" />
        }
      >
        {t('backup.coverage.refresh', 'Refresh')}
      </Button>
    </div>
  );
};

const ErrorBanner: React.FC<{ message: string }> = ({ message }) => {
  const { t } = useTranslation();
  return (
    <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/30 text-sm text-red-700 dark:text-red-300">
      {t('backup.coverage.error', 'Could not load coverage report: {{message}}', { message })}
    </div>
  );
};

const FallbackWarning: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className="mb-4 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/30 text-sm text-amber-800 dark:text-amber-200 flex items-start gap-2">
      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <span>
        {t(
          'backup.coverage.fallbackInUse',
          'The backup_paths table is missing. The walker is using its legacy hard-coded fallback. Migration 108 may not have run — check server logs and re-run migrations.',
        )}
      </span>
    </div>
  );
};

const SectionGrid: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">{children}</div>
);

const DatabaseStatusCard: React.FC<{
  database: BackupCoverageReport['database'];
}> = ({ database }) => {
  const { t } = useTranslation();
  const { formatDateTime } = useLocalizedDate();
  const isInline = database.mode === 'inline';
  const tone: Tone = database.ok ? 'green' : 'red';
  const dumpAge = database.lastDumpAgeMs !== null
    ? formatAge(database.lastDumpAgeMs)
    : null;

  return (
    <div className={`rounded-lg p-4 ${TONE_BG[tone]}`}>
      <div className="flex items-center gap-2 mb-2">
        <Database className="w-4 h-4" />
        <h4 className="font-semibold text-sm uppercase tracking-wide">
          {t('backup.coverage.database.title', 'Database')}
        </h4>
        {database.ok ? (
          <CheckCircle2 className="w-4 h-4 ml-auto" />
        ) : (
          <XCircle className="w-4 h-4 ml-auto" />
        )}
      </div>
      <dl className="space-y-1 text-sm">
        <Row
          label={t('backup.coverage.database.mode', 'Mode')}
          value={isInline
            ? t('backup.coverage.database.modeInline', 'Inline dump on every backup')
            : t('backup.coverage.database.modeScheduled', 'Scheduled-only (inline opted out)')}
        />
        {database.lastDumpAt ? (
          <>
            <Row
              label={t('backup.coverage.database.lastDump', 'Last dump')}
              value={`${formatDateTime(new Date(database.lastDumpAt))}${
                dumpAge ? ` (${dumpAge})` : ''
              }`}
            />
            <Row
              label={t('backup.coverage.database.lastDumpSize', 'Size')}
              value={formatBytes(database.lastDumpSizeBytes)}
            />
          </>
        ) : (
          <Row
            label={t('backup.coverage.database.lastDump', 'Last dump')}
            value={t('backup.coverage.database.noDump', 'No dump on file yet')}
          />
        )}
        {database.lastDumpStale && (
          <Row
            label={t('backup.coverage.database.staleLabel', 'Status')}
            value={t('backup.coverage.database.stale', 'Stale — older than 26h')}
            icon={<Clock className="w-3.5 h-3.5" />}
          />
        )}
      </dl>
    </div>
  );
};

const SummaryCard: React.FC<{
  summary: BackupCoverageReport['summary'];
}> = ({ summary }) => {
  const { t } = useTranslation();
  const tone: Tone = summary.overallOk
    ? 'green'
    : summary.driftCount > 0 || !summary.databaseOk
      ? 'amber'
      : 'neutral';
  return (
    <div className={`rounded-lg p-4 ${TONE_BG[tone]}`}>
      <div className="flex items-center gap-2 mb-2">
        <FolderTree className="w-4 h-4" />
        <h4 className="font-semibold text-sm uppercase tracking-wide">
          {t('backup.coverage.summary.title', 'Summary')}
        </h4>
      </div>
      <dl className="space-y-1 text-sm">
        <Row
          label={t('backup.coverage.summary.willScan', 'Will scan')}
          value={`${summary.willScanCount} / ${summary.configuredCount}`}
        />
        {summary.skippedByToggleCount > 0 && (
          <Row
            label={t('backup.coverage.summary.skippedByToggle', 'Skipped (toggle off)')}
            value={String(summary.skippedByToggleCount)}
          />
        )}
        {summary.skippedByFeatureFlagCount > 0 && (
          <Row
            label={t('backup.coverage.summary.skippedByFlag', 'Skipped (feature flag)')}
            value={String(summary.skippedByFeatureFlagCount)}
          />
        )}
        {summary.missingOnDiskCount > 0 && (
          <Row
            label={t('backup.coverage.summary.missingOnDisk', 'Missing on disk')}
            value={String(summary.missingOnDiskCount)}
          />
        )}
        <Row
          label={t('backup.coverage.summary.drift', 'Unconfigured on disk (drift)')}
          value={String(summary.driftCount)}
        />
      </dl>
    </div>
  );
};

const PathsTable: React.FC<{ paths: BackupCoverageReport['paths'] }> = ({ paths }) => {
  const { t } = useTranslation();
  return (
    <div className="border border-neutral-200 dark:border-neutral-700 rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-neutral-50 dark:bg-neutral-800/50 border-b border-neutral-200 dark:border-neutral-700">
        <h4 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {t('backup.coverage.paths.heading', 'Configured paths')}
        </h4>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 dark:bg-neutral-800/30">
            <tr className="text-left text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              <th className="px-3 py-2">{t('backup.coverage.paths.path', 'Path')}</th>
              <th className="px-3 py-2">{t('backup.coverage.paths.coverage', 'Coverage')}</th>
              <th className="px-3 py-2">{t('backup.coverage.paths.featureFlag', 'Feature flag')}</th>
              <th className="px-3 py-2">{t('backup.coverage.paths.description', 'Description')}</th>
            </tr>
          </thead>
          <tbody>
            {paths.map((p) => (
              <tr
                key={p.path}
                className="border-t border-neutral-200 dark:border-neutral-700"
              >
                <td className="px-3 py-2 font-mono text-xs text-neutral-700 dark:text-neutral-300">
                  {p.path}
                </td>
                <td className="px-3 py-2">
                  <CoverageBadge coverage={p.coverage} />
                </td>
                <td className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400">
                  {p.featureFlag
                    ? `${p.featureFlag} = ${p.featureFlagValue === null ? '∅' : String(p.featureFlagValue)}`
                    : '—'}
                </td>
                <td className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400">
                  {p.description ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const DriftSection: React.FC<{ drift: BackupCoverageReport['drift'] }> = ({ drift }) => {
  const { t } = useTranslation();
  if (drift.unconfiguredOnDisk.length === 0) {
    return (
      <div className="mt-4 p-3 rounded-lg bg-green-50 dark:bg-green-900/30 text-sm text-green-700 dark:text-green-300 flex items-center gap-2">
        <CheckCircle2 className="w-4 h-4" />
        {t(
          'backup.coverage.drift.none',
          'No drift detected — every top-level subdirectory under STORAGE_PATH is either in backup_paths or in the expected non-backup allow-list.',
        )}
      </div>
    );
  }
  return (
    <div className="mt-4 border border-amber-300 dark:border-amber-700 rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-amber-50 dark:bg-amber-900/30 border-b border-amber-300 dark:border-amber-700">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-700 dark:text-amber-300" />
          <h4 className="text-sm font-semibold text-amber-800 dark:text-amber-200">
            {t('backup.coverage.drift.heading', 'Drift detected: subdirectories not covered by any backup_paths row')}
          </h4>
        </div>
        <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
          {t(
            'backup.coverage.drift.caption',
            'These directories exist on disk but the walker will skip them. Either add a backup_paths row, move the files into a covered location, or — if they are runtime caches — confirm they are safe to exclude.',
          )}
        </p>
      </div>
      <ul className="divide-y divide-amber-200 dark:divide-amber-800">
        {drift.unconfiguredOnDisk.map((d) => (
          <li
            key={d}
            className="px-3 py-2 font-mono text-xs text-amber-900 dark:text-amber-100 flex items-center gap-2"
          >
            <EyeOff className="w-3.5 h-3.5" />
            {d}
          </li>
        ))}
      </ul>
    </div>
  );
};

const CoverageBadge: React.FC<{ coverage: BackupPathCoverage }> = ({ coverage }) => {
  const { t } = useTranslation();
  const map: Record<BackupPathCoverage, { tone: Tone; label: string }> = {
    'will-scan': {
      tone: 'green',
      label: t('backup.coverage.coverage.willScan', 'Will scan'),
    },
    'skipped-by-toggle': {
      tone: 'neutral',
      label: t('backup.coverage.coverage.skippedByToggle', 'Off'),
    },
    'skipped-by-feature-flag': {
      tone: 'neutral',
      label: t('backup.coverage.coverage.skippedByFlag', 'Gated off'),
    },
    'missing-on-disk': {
      tone: 'amber',
      label: t('backup.coverage.coverage.missingOnDisk', 'Missing on disk'),
    },
  };
  const { tone, label } = map[coverage];
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${TONE_BG[tone]}`}>
      {label}
    </span>
  );
};

const Row: React.FC<{ label: string; value: string; icon?: React.ReactNode }> = ({
  label, value, icon,
}) => (
  <div className="flex justify-between items-center gap-3">
    <dt className="text-xs uppercase tracking-wide opacity-80 flex items-center gap-1">
      {icon}
      {label}
    </dt>
    <dd className="text-sm font-medium text-right">{value}</dd>
  </div>
);

type Tone = 'neutral' | 'green' | 'amber' | 'red';

const TONE_BG: Record<Tone, string> = {
  neutral: 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200',
  green: 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300',
  amber: 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
  red: 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300',
};

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatAge(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
