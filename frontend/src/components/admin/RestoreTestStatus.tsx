import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CheckCircle2, XCircle, MinusCircle, AlertTriangle, Loader2 } from 'lucide-react';

import { Badge, type BadgeTone } from '../common';
import type {
  VerificationCheckResult,
  VerificationRunStatus,
  VerificationStatus,
} from '../../services/backupVerification.service';

/**
 * Shared pieces of the backup restore test UI: the status badge used on the
 * Restore test card, and the compact per-run badge in Backup → History.
 */

export const STATUS_TONE: Record<VerificationStatus, BadgeTone> = {
  passed: 'success',
  warning: 'warning',
  failed: 'danger',
  skipped: 'neutral',
  running: 'info',
};

export const statusLabel = (status: VerificationStatus, t: TFunction): string => {
  switch (status) {
  case 'passed': return t('backup.restoreTest.status.passed', 'Passed');
  case 'warning': return t('backup.restoreTest.status.warning', 'Passed with warnings');
  case 'failed': return t('backup.restoreTest.status.failed', 'Failed');
  case 'skipped': return t('backup.restoreTest.status.skipped', 'Skipped');
  case 'running': return t('backup.restoreTest.status.running', 'Running');
  default: return String(status);
  }
};

export const VerificationStatusBadge: React.FC<{ status: VerificationStatus }> = ({ status }) => {
  const { t } = useTranslation();
  return (
    <Badge
      tone={STATUS_TONE[status] ?? 'neutral'}
      icon={status === 'running' ? <Loader2 className="animate-spin" /> : undefined}
      dot={status !== 'running'}
    >
      {statusLabel(status, t)}
    </Badge>
  );
};

/** Icon for one check's result, coloured by the status tokens. */
export const CheckResultIcon: React.FC<{ result: VerificationCheckResult; className?: string }> = ({
  result,
  className = 'w-4 h-4',
}) => {
  switch (result) {
  case 'passed':
    return <CheckCircle2 className={`${className} text-success-text`} aria-hidden="true" />;
  case 'warning':
    return <AlertTriangle className={`${className} text-warning-text`} aria-hidden="true" />;
  case 'failed':
    return <XCircle className={`${className} text-danger-text`} aria-hidden="true" />;
  default:
    return <MinusCircle className={`${className} text-faint`} aria-hidden="true" />;
  }
};

/**
 * Backup → History row badge: whether the restore test of this backup run
 * passed. `undefined` means no test has looked at this run.
 */
export const RestoreTestRunBadge: React.FC<{ status?: VerificationRunStatus }> = ({ status }) => {
  const { t } = useTranslation();
  const hint = t(
    'backup.restoreTest.badge.hint',
    'Restore test: whether this backup was verified and test-restored into a throwaway database.',
  );
  if (status === 'running') {
    return (
      <Badge tone="info" icon={<Loader2 className="animate-spin" />} title={hint}>
        {t('backup.restoreTest.badge.running', 'Testing')}
      </Badge>
    );
  }
  if (status === 'passed' || status === 'warning') {
    return (
      <Badge
        tone={status === 'warning' ? 'warning' : 'success'}
        icon={<CheckCircle2 />}
        title={status === 'warning'
          ? `${hint} ${t('backup.restoreTest.badge.warningHint', 'Restorable, with warnings.')}`
          : hint}
      >
        {t('backup.restoreTest.badge.verified', 'Verified')}
      </Badge>
    );
  }
  if (status === 'failed') {
    return (
      <Badge tone="danger" icon={<XCircle />} title={hint}>
        {t('backup.restoreTest.badge.failed', 'Test failed')}
      </Badge>
    );
  }
  return (
    <Badge tone="neutral" appearance="outline" icon={<MinusCircle />} title={hint}>
      {status === 'skipped'
        ? t('backup.restoreTest.badge.skipped', 'Not testable')
        : t('backup.restoreTest.badge.notVerified', 'Not verified')}
    </Badge>
  );
};
