/**
 * Admin → Backup → restore test API client.
 *
 * Every backup (and a weekly re-check of retained ones) is verified on the
 * server: a deep verify of the manifest, dump and file hashes, then a
 * restore drill into a throwaway database. These calls read those results
 * and start one on demand. Behind the `backupRestoreTest` feature flag: the
 * backend answers 403 BACKUP_RESTORE_TEST_DISABLED while it is off.
 * Reading needs `backup.view`, starting a test `backup.restore`.
 */
import { api } from '../config/api';

export type VerificationCheckResult = 'passed' | 'warning' | 'failed' | 'skipped';

export interface VerificationCheck {
  /** Stable key, e.g. `manifest_signature`, `drill_row_counts`. */
  name: string;
  result: VerificationCheckResult;
  detail?: string | null;
}

export type VerificationStatus = 'running' | 'passed' | 'warning' | 'failed' | 'skipped';

export type VerificationSkipReason =
  | 'not_verifiable_rsync'
  | 'insufficient_space'
  | 'busy'
  | 'no_backup'
  | 'not_standalone'
  | 'no_manifest'
  | 'interrupted'
  | 'no_database_dump';

export interface Verification {
  id: number;
  backup_run_id: number | null;
  database_backup_run_id: number | null;
  /** Highest level that actually ran. */
  level: 'deep' | 'drill';
  status: VerificationStatus;
  /** Free string on the wire; known values are in VerificationSkipReason. */
  skip_reason: string | null;
  checks: VerificationCheck[];
  /** Every file hashed, rather than business documents plus a sample. */
  full: boolean;
  sample_percent: number | null;
  triggered_by: 'backup' | 'schedule' | 'admin';
  triggered_by_admin_id: number | null;
  started_at: string;
  completed_at: string | null;
}

export type VerificationHealth = 'ok' | 'stale' | 'failed' | 'none' | 'running';

export type VerificationRunStatus = 'passed' | 'warning' | 'failed' | 'skipped' | 'running';

export interface VerificationsResponse {
  /** Newest first. */
  items: Verification[];
  /** Newest finished-or-running row. */
  latest: Verification | null;
  /** Newest passed OR warning completed_at. */
  lastPassedAt: string | null;
  health: VerificationHealth;
  staleDays: number;
  running: boolean;
  /** Latest status per backup_runs.id. */
  byBackupRun: Record<string, VerificationRunStatus>;
  settings: { enabled: boolean; cron: string; samplePercent: number };
}

/** The summary System health and /admin/backup/status carry. */
export interface BackupVerificationSummary {
  health: VerificationHealth;
  lastPassedAt: string | null;
  latest: Verification | null;
  staleDays: number;
}

export interface RunVerificationInput {
  backupRunId?: number;
  databaseBackupRunId?: number;
  full?: boolean;
}

export const BACKUP_VERIFICATIONS_QUERY_KEY = ['backup-verifications'] as const;

export const backupVerificationService = {
  async list(limit = 20): Promise<VerificationsResponse> {
    const response = await api.get<VerificationsResponse>('/admin/backup/verifications', { params: { limit } });
    return response.data;
  },

  /** 202 { id }; 409 VERIFICATION_BUSY; 404 NO_BACKUP. */
  async runNow(input: RunVerificationInput = {}): Promise<{ id: number }> {
    const response = await api.post<{ id: number }>('/admin/backup/verifications', input);
    return response.data;
  },
};
