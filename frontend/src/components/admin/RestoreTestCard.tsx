import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useQuery } from '@tanstack/react-query';
import { DatabaseBackup, Play, ChevronDown, ChevronUp } from 'lucide-react';

import { Button, Card, Loading, Notice } from '../common';
import { useMutationWithToast } from '../../hooks';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { usePermissions } from '../../contexts/PermissionsContext';
import {
  BACKUP_VERIFICATIONS_QUERY_KEY,
  backupVerificationService,
  type Verification,
} from '../../services/backupVerification.service';
import { CheckResultIcon, VerificationStatusBadge } from './RestoreTestStatus';

/**
 * Backup → Integrity → Restore test (feature flag `backupRestoreTest`).
 *
 * Shows the newest restore test the server ran — after every backup and on
 * its weekly schedule — check by check, and lets an admin holding
 * `backup.restore` start one. Polls while one is running.
 */

const HISTORY_SIZE = 5;
const POLL_MS = 5000;

const CHECK_LABELS: Record<string, [string, string]> = {
  manifest_signature: ['backup.restoreTest.checks.manifest_signature', 'Manifest signature'],
  dump_checksum: ['backup.restoreTest.checks.dump_checksum', 'Database dump checksum'],
  parent_chain: ['backup.restoreTest.checks.parent_chain', 'Backup chain'],
  business_docs: ['backup.restoreTest.checks.business_docs', 'Business documents'],
  files_sample: ['backup.restoreTest.checks.files_sample', 'File sample'],
  files_all: ['backup.restoreTest.checks.files_all', 'All files'],
  drill_load: ['backup.restoreTest.checks.drill_load', 'Load into a test database'],
  drill_integrity: ['backup.restoreTest.checks.drill_integrity', 'Database integrity'],
  drill_foreign_keys: ['backup.restoreTest.checks.drill_foreign_keys', 'Foreign keys'],
  drill_row_counts: ['backup.restoreTest.checks.drill_row_counts', 'Row counts'],
  drill_migrate: ['backup.restoreTest.checks.drill_migrate', 'Migrate to the current version'],
  drill_invariants: ['backup.restoreTest.checks.drill_invariants', 'Data consistency'],
  createdb_privilege: ['backup.restoreTest.checks.createdb_privilege', 'Permission to create a test database'],
  destination: ['backup.restoreTest.checks.destination', 'Backup destination'],
};

const SKIP_REASONS: Record<string, [string, string]> = {
  not_verifiable_rsync: [
    'backup.restoreTest.skipReasons.not_verifiable_rsync',
    "Backups sent over rsync can't be fetched back for testing, so they aren't verified. Use a local or S3 destination to get restore tests.",
  ],
  insufficient_space: [
    'backup.restoreTest.skipReasons.insufficient_space',
    'There was not enough free disk space to restore a test copy. Free up space on the server, then run the test again.',
  ],
  busy: [
    'backup.restoreTest.skipReasons.busy',
    'A backup, restore or another test was running at the time, so this test was skipped.',
  ],
  no_backup: [
    'backup.restoreTest.skipReasons.no_backup',
    'There was no successful backup to test.',
  ],
  not_standalone: [
    'backup.restoreTest.skipReasons.not_standalone',
    "This backup can't be restored on its own, so it was not test-restored.",
  ],
  no_manifest: [
    'backup.restoreTest.skipReasons.no_manifest',
    'This backup has no manifest, so its contents could not be checked.',
  ],
  interrupted: [
    'backup.restoreTest.skipReasons.interrupted',
    'The test was interrupted before it finished, for example by a server restart.',
  ],
  legacy_manifest: [
    'backup.restoreTest.skipReasons.legacy_manifest',
    'This backup was made before backup manifests were signed, so its checksums cannot be trusted and it was not tested. Backups made from now on are signed and tested.',
  ],
  no_database_in_backup: [
    'backup.restoreTest.skipReasons.no_database_in_backup',
    'This backup was made without the database (Configuration → What to Backup), so only its files were checked. Include the database to get full restore tests.',
  ],
  no_database_dump: [
    'backup.restoreTest.skipReasons.no_database_dump',
    'This backup holds no database dump, so there was nothing to test-restore.',
  ],
};

export const checkLabel = (name: string, t: TFunction): string => {
  const entry = CHECK_LABELS[name];
  return entry ? t(entry[0], entry[1]) : name;
};

export const skipReasonText = (reason: string, t: TFunction): string => {
  const entry = SKIP_REASONS[reason];
  return entry ? t(entry[0], entry[1]) : reason;
};

const levelLabel = (level: Verification['level'], t: TFunction) => (level === 'drill'
  ? t('backup.restoreTest.level.drill', 'Restore drill')
  : t('backup.restoreTest.level.deep', 'Deep verify'));

const triggerLabel = (trigger: Verification['triggered_by'], t: TFunction) => {
  switch (trigger) {
  case 'backup': return t('backup.restoreTest.trigger.backup', 'After the backup');
  case 'schedule': return t('backup.restoreTest.trigger.schedule', 'Scheduled re-check');
  case 'admin': return t('backup.restoreTest.trigger.admin', 'Started by an admin');
  default: return String(trigger);
  }
};

const targetLabel = (v: Verification, t: TFunction) => {
  if (v.backup_run_id != null) {
    return t('backup.restoreTest.target.backupRun', 'Backup #{{id}}', { id: v.backup_run_id });
  }
  if (v.database_backup_run_id != null) {
    return t('backup.restoreTest.target.databaseRun', 'Database backup #{{id}}', { id: v.database_backup_run_id });
  }
  return t('backup.restoreTest.target.none', 'No backup');
};

const errorCode = (error: unknown): string | undefined =>
  (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code as string | undefined;

export const RestoreTestCard: React.FC = () => {
  const { t } = useTranslation();
  const { formatDateTime, formatDistanceToNow } = useLocalizedDate();
  const { hasPermission } = usePermissions();
  const canView = hasPermission('backup.view');
  const canRun = hasPermission('backup.restore');
  const [hashAll, setHashAll] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: BACKUP_VERIFICATIONS_QUERY_KEY,
    queryFn: () => backupVerificationService.list(20),
    // The results route needs backup.view; the Backup tab also opens for
    // settings.view alone.
    enabled: canView,
    refetchInterval: (query) => (query.state.data?.running ? POLL_MS : false),
  });

  const runNow = useMutationWithToast({
    mutationFn: (full: boolean) => backupVerificationService.runNow(full ? { full: true } : {}),
    successMessage: t('backup.restoreTest.started', 'Restore test started.'),
    errorMessage: (error: unknown) => {
      const code = errorCode(error);
      if (code === 'VERIFICATION_BUSY') {
        return t('backup.restoreTest.busy', 'A backup, restore or restore test is already running. Try again when it has finished.');
      }
      if (code === 'NO_BACKUP') {
        return t('backup.restoreTest.noBackup', 'There is no successful backup to test yet.');
      }
      return t('backup.restoreTest.startFailed', 'The restore test could not be started.');
    },
    invalidateKeys: [BACKUP_VERIFICATIONS_QUERY_KEY],
  });

  if (!canView) return null;

  const latest = data?.latest ?? null;
  const running = Boolean(data?.running);
  const history = (data?.items ?? []).filter((v) => v.id !== latest?.id).slice(0, HISTORY_SIZE);

  return (
    <Card className="p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <DatabaseBackup className="w-5 h-5 text-muted" />
            <h3 className="text-lg font-semibold text-heading">
              {t('backup.restoreTest.title', 'Restore test')}
            </h3>
          </div>
          <p className="text-sm text-soft max-w-2xl">
            {t(
              'backup.restoreTest.description',
              'After every backup, and on a schedule for retained backups, the server checks the backup can actually be restored: it verifies the signature and checksums, then restores the database into a throwaway copy and checks it.',
            )}
          </p>
        </div>
        {canRun && (
          <div className="flex flex-col items-start md:items-end gap-2 shrink-0">
            <Button
              variant="primary"
              onClick={() => runNow.mutate(hashAll)}
              disabled={running || runNow.isPending}
              isLoading={runNow.isPending}
              leftIcon={<Play className="w-4 h-4" />}
            >
              {t('backup.restoreTest.runNow', 'Run restore test now')}
            </Button>
            <label className="flex items-center gap-2 text-sm text-body">
              <input
                type="checkbox"
                checked={hashAll}
                onChange={(e) => setHashAll(e.target.checked)}
                className="h-4 w-4 text-accent focus:ring-accent border-line-strong rounded bg-inset"
              />
              {t('backup.restoreTest.hashAll', 'Hash every file')}
            </label>
          </div>
        )}
      </div>

      {isLoading && <Loading />}

      {isError && (
        <Notice tone="danger" className="mb-4">
          {t('backup.restoreTest.loadFailed', 'Restore test results could not be loaded.')}
        </Notice>
      )}

      {data && data.health === 'stale' && (
        <Notice tone="warning" className="mb-4">
          {t('backup.restoreTest.stale', 'No passed restore test in the last {{days}} days', { days: data.staleDays })}
        </Notice>
      )}

      {data && data.settings.enabled && (
        <p className="mb-4 text-xs text-muted">
          {t('backup.restoreTest.scheduleSummary', 'Re-check schedule: {{cron}} · other files sampled per run: {{percent}} %', {
            cron: data.settings.cron,
            percent: data.settings.samplePercent,
          })}
        </p>
      )}

      {data && !data.settings.enabled && (
        <Notice tone="info" className="mb-4">
          {t('backup.restoreTest.disabled', 'Automatic restore tests are turned off under Configuration. Backups are not tested unless you start a test here.')}
        </Notice>
      )}

      {data && !latest && (
        <p className="text-sm text-muted italic">
          {t('backup.restoreTest.empty', 'No restore test has run yet.')}
        </p>
      )}

      {latest && (
        <div className="rounded-lg border border-line p-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <VerificationStatusBadge status={latest.status} />
            <span className="text-sm font-medium text-heading">{levelLabel(latest.level, t)}</span>
            {latest.full ? (
              <span className="text-xs text-muted">{t('backup.restoreTest.fullCheck', 'every file hashed')}</span>
            ) : latest.sample_percent != null && (
              <span className="text-xs text-muted">
                {t('backup.restoreTest.sampled', '{{percent}} % of other files sampled', { percent: latest.sample_percent })}
              </span>
            )}
          </div>

          <dl className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-xs text-muted">{t('backup.restoreTest.when', 'When')}</dt>
              <dd className="text-body" title={formatDateTime(latest.started_at)}>
                {formatDistanceToNow(latest.completed_at ?? latest.started_at, { addSuffix: true })}
                <span className="block text-xs text-muted">
                  {formatDateTime(latest.completed_at ?? latest.started_at)}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t('backup.restoreTest.tested', 'Tested')}</dt>
              <dd className="text-body">{targetLabel(latest, t)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t('backup.restoreTest.triggeredBy', 'Trigger')}</dt>
              <dd className="text-body">{triggerLabel(latest.triggered_by, t)}</dd>
            </div>
          </dl>

          {latest.skip_reason && (
            <p className="mt-3 text-sm text-body">{skipReasonText(latest.skip_reason, t)}</p>
          )}

          {latest.checks.length > 0 && (
            <ul className="mt-4 divide-y divide-line border-t border-line">
              {latest.checks.map((check, index) => (
                <li key={`${check.name}-${index}`} className="flex items-start gap-2 py-2">
                  <CheckResultIcon result={check.result} className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm text-heading">{checkLabel(check.name, t)}</p>
                    {check.detail && (
                      <p className="text-xs text-soft break-words">{check.detail}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {history.length > 0 && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className="flex items-center gap-1 text-sm font-medium text-body hover:text-heading"
            aria-expanded={showHistory}
          >
            {showHistory ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            {t('backup.restoreTest.history', 'Earlier tests ({{count}})', { count: history.length })}
          </button>
          {showHistory && (
            <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
              {history.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                  <VerificationStatusBadge status={v.status} />
                  <span className="text-body">{formatDateTime(v.completed_at ?? v.started_at)}</span>
                  <span className="text-soft">{levelLabel(v.level, t)}</span>
                  <span className="text-soft">{targetLabel(v, t)}</span>
                  <span className="text-muted">{triggerLabel(v.triggered_by, t)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
};
