import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ShieldCheck,
  ShieldAlert,
  FileX,
  Hash,
  HelpCircle,
  Play,
  Loader2,
} from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
// Locale-aware formatters per [[feedback_respect_general_format_settings]].
import { useLocalizedDate } from '../../hooks/useLocalizedDate';

import { Card, Button } from '../common';
import { adminService, BackupIntegrityReport } from '../../services/admin.service';

/**
 * BackupIntegrityCard — on-demand verifier for CRM document artefacts.
 *
 * Walks every `*_path` column on quotes / contracts / invoices and
 * confirms (a) the referenced file exists on disk, (b) where a SHA-256
 * is stored, the file's bytes hash to the expected value. Surfaces
 * three failure buckets:
 *
 *   - missing         — `*_path` set, file not on disk (broken FK)
 *   - hashMismatches  — file exists but bytes don't match the stored hash
 *   - existsButNoHash — verified by existence only; weaker evidence
 *
 * Designed to be portable. Currently embedded as a tab on
 * `BackupManagement.tsx`; when the System Health page (backlog item)
 * lands, this same component can be lifted there without changes.
 */
export const BackupIntegrityCard: React.FC = () => {
  const { t } = useTranslation();
  const { formatDateTime } = useLocalizedDate();
  const [report, setReport] = useState<BackupIntegrityReport | null>(null);
  const [expanded, setExpanded] = useState<'missing' | 'hashMismatches' | null>(null);

  const runCheck = useMutation({
    mutationFn: () => adminService.getBackupIntegrity(),
    onSuccess: (data) => {
      setReport(data);
      // Auto-expand whichever failure bucket has entries, prioritising
      // the more severe one (missing > hashMismatches).
      if (data.summary.missingFiles > 0) setExpanded('missing');
      else if (data.summary.hashMismatches > 0) setExpanded('hashMismatches');
      else setExpanded(null);
    },
  });

  const summary = report?.summary;
  const isHealthy = report
    && summary
    && summary.missingFiles === 0
    && summary.hashMismatches === 0;

  return (
    <Card className="p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            {isHealthy ? (
              <ShieldCheck className="w-5 h-5 text-green-600 dark:text-green-400" />
            ) : report ? (
              <ShieldAlert className="w-5 h-5 text-red-600 dark:text-red-400" />
            ) : (
              <ShieldCheck className="w-5 h-5 text-neutral-400" />
            )}
            <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              {t('backup.integrity.title', 'Document integrity')}
            </h3>
          </div>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 max-w-2xl">
            {t(
              'backup.integrity.description',
              'Verifies every CRM document (quote / contract / invoice / signature) referenced from the database actually exists on disk and — where a hash is stored — its bytes still match. Read-only, on-demand.',
            )}
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => runCheck.mutate()}
          disabled={runCheck.isPending}
          leftIcon={
            runCheck.isPending
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Play className="w-4 h-4" />
          }
        >
          {runCheck.isPending
            ? t('backup.integrity.running', 'Checking…')
            : t('backup.integrity.runNow', 'Run check now')}
        </Button>
      </div>

      {runCheck.isError && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/30 text-sm text-red-700 dark:text-red-300">
          {t('backup.integrity.error', 'Check failed: {{message}}', {
            message: (runCheck.error as Error)?.message ?? 'unknown error',
          })}
        </div>
      )}

      {report && summary && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
            <Counter
              label={t('backup.integrity.summary.total', 'Total')}
              value={summary.totalRows}
              tone="neutral"
            />
            <Counter
              label={t('backup.integrity.summary.verifiedOk', 'Hash-verified')}
              value={summary.verifiedOk}
              tone="green"
              icon={<Hash className="w-4 h-4" />}
            />
            <Counter
              label={t('backup.integrity.summary.existsButNoHash', 'Exists only')}
              value={summary.existsButNoHash}
              tone="amber"
              icon={<HelpCircle className="w-4 h-4" />}
              tooltip={t(
                'backup.integrity.summary.existsButNoHashHint',
                'File found, but no SHA-256 is stored for it (quote/invoice PDFs, signature drawings). Existence-only is weaker evidence in a dispute.',
              )}
            />
            <Counter
              label={t('backup.integrity.summary.missingFiles', 'Missing')}
              value={summary.missingFiles}
              tone={summary.missingFiles > 0 ? 'red' : 'neutral'}
              icon={<FileX className="w-4 h-4" />}
              onClick={summary.missingFiles > 0
                ? () => setExpanded(expanded === 'missing' ? null : 'missing')
                : undefined}
            />
            <Counter
              label={t('backup.integrity.summary.hashMismatches', 'Hash mismatches')}
              value={summary.hashMismatches}
              tone={summary.hashMismatches > 0 ? 'red' : 'neutral'}
              icon={<ShieldAlert className="w-4 h-4" />}
              onClick={summary.hashMismatches > 0
                ? () => setExpanded(expanded === 'hashMismatches' ? null : 'hashMismatches')
                : undefined}
            />
          </div>

          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-3">
            {t('backup.integrity.scannedAt', 'Last checked: {{when}}', {
              when: formatDateTime(new Date(report.scannedAt)),
            })}
          </p>

          {expanded === 'missing' && summary.missingFiles > 0 && (
            <ResultTable
              title={t('backup.integrity.missing.heading', 'Missing files')}
              caption={t(
                'backup.integrity.missing.caption',
                'These rows reference a path that does not exist on disk. After a restore, this means the artefact was lost from the backup chain; for fresh installs, it usually means the file was deleted manually.',
              )}
              rows={report.missing.map((m) => ({
                table: m.table,
                rowId: m.rowId,
                column: m.column,
                detail: m.expectedPath,
              }))}
            />
          )}

          {expanded === 'hashMismatches' && summary.hashMismatches > 0 && (
            <ResultTable
              title={t('backup.integrity.hashMismatches.heading', 'Hash mismatches')}
              caption={t(
                'backup.integrity.hashMismatches.caption',
                'The file exists but its current bytes do not match the SHA-256 captured at issue / sign time. Indicates tampering, bit-rot, or a restore that pulled in a different copy than the original.',
              )}
              rows={report.hashMismatches.map((m) => ({
                table: m.table,
                rowId: m.rowId,
                column: m.column,
                detail: `${m.expectedPath} (expected ${m.expectedSha.slice(0, 12)}…, got ${m.actualSha.slice(0, 12)}…)`,
              }))}
            />
          )}
        </>
      )}

      {!report && !runCheck.isPending && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400 italic">
          {t(
            'backup.integrity.emptyState',
            'No check has been run yet in this session. Click "Run check now" to scan the document estate.',
          )}
        </p>
      )}
    </Card>
  );
};

type Tone = 'neutral' | 'green' | 'amber' | 'red';

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200',
  green: 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300',
  amber: 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
  red: 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300',
};

const Counter: React.FC<{
  label: string;
  value: number;
  tone: Tone;
  icon?: React.ReactNode;
  tooltip?: string;
  onClick?: () => void;
}> = ({ label, value, tone, icon, tooltip, onClick }) => {
  const interactive = Boolean(onClick);
  const classes = `rounded-lg p-3 ${TONE_CLASSES[tone]} ${
    interactive ? 'cursor-pointer hover:ring-2 hover:ring-offset-1 hover:ring-current/30 transition' : ''
  }`;
  return (
    <div
      className={classes}
      onClick={onClick}
      title={tooltip}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide opacity-80">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-2xl font-semibold mt-1 tabular-nums">{value}</div>
    </div>
  );
};

const ResultTable: React.FC<{
  title: string;
  caption: string;
  rows: Array<{ table: string; rowId: number; column: string; detail: string }>;
}> = ({ title, caption, rows }) => {
  const { t } = useTranslation();
  return (
    <div className="mt-4 border border-neutral-200 dark:border-neutral-700 rounded-lg overflow-hidden">
      <div className="p-3 bg-neutral-50 dark:bg-neutral-800/50 border-b border-neutral-200 dark:border-neutral-700">
        <h4 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{title}</h4>
        <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">{caption}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 dark:bg-neutral-800/30">
            <tr className="text-left text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              <th className="px-3 py-2">{t('backup.integrity.results.table', 'Table')}</th>
              <th className="px-3 py-2">{t('backup.integrity.results.rowId', 'Row id')}</th>
              <th className="px-3 py-2">{t('backup.integrity.results.column', 'Column')}</th>
              <th className="px-3 py-2">{t('backup.integrity.results.detail', 'Detail')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={`${r.table}-${r.rowId}-${r.column}-${i}`}
                className="border-t border-neutral-200 dark:border-neutral-700"
              >
                <td className="px-3 py-2 font-mono text-xs text-neutral-700 dark:text-neutral-300">
                  {r.table}
                </td>
                <td className="px-3 py-2 tabular-nums text-neutral-700 dark:text-neutral-300">
                  {r.rowId}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-neutral-700 dark:text-neutral-300">
                  {r.column}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-neutral-700 dark:text-neutral-300 break-all">
                  {r.detail}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
