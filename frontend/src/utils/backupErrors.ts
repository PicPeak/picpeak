import type { TFunction } from 'i18next';

/** Stable codes the backup API answers with (issue 1641). */
export const BACKUP_ERROR_CODES = [
  'S3_PRIVATE_ENDPOINT',
  'S3_ENDPOINT_FORBIDDEN',
  'S3_ENDPOINT_UNRESOLVED',
  'S3_ENDPOINT_INVALID',
  'S3_APPROVAL_MISMATCH',
  'S3_CONFIG_INCOMPLETE',
  'S3_CONNECTION_FAILED',
] as const;

export type BackupErrorCode = typeof BACKUP_ERROR_CODES[number];

const isBackupErrorCode = (value: unknown): value is BackupErrorCode =>
  typeof value === 'string' && (BACKUP_ERROR_CODES as readonly string[]).includes(value);

/**
 * The code in an API error body, or the one leading a stored backup run's
 * error_message ("S3 connection test failed: S3_PRIVATE_ENDPOINT: …").
 */
export function backupErrorCode(source: unknown): BackupErrorCode | null {
  if (typeof source === 'string') {
    const match = source.match(/\b(S3_[A-Z_]+):/);
    return match && isBackupErrorCode(match[1]) ? match[1] : null;
  }
  const code = (source as { response?: { data?: { code?: unknown } }; code?: unknown } | null)?.response?.data?.code
    ?? (source as { code?: unknown } | null)?.code;
  return isBackupErrorCode(code) ? code : null;
}

/** Translated text for a known code, or null so the caller keeps its own text. */
export function backupErrorText(code: BackupErrorCode | null, t: TFunction): string | null {
  if (!code) return null;
  return t(`backup.errors.${code}`);
}
