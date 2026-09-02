/**
 * Admin → System health. Aggregates background failures that would
 * otherwise go unnoticed. v1: stuck/failed outbound emails (the queue
 * processor gave up or exhausted retries), with retry + dismiss.
 *
 * #1262 — "no failures" was being read as "everything went out". It is not the
 * same claim: a queue nobody is working produces no failures at all, because
 * every row sits at status='pending' with retry_count 0. So the page now leads
 * with what the processor itself last did, and lists due-but-unsent emails
 * next to the failed ones. The all-clear only shows when both are empty and
 * the processor is running.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, RefreshCw, Trash2, CheckCircle, Clock, Mail, MailX } from 'lucide-react';
import { Button, Card, Loading } from '../../components/common';
import { useMutationWithToast } from '../../hooks';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { systemHealthService, type StuckEmail } from '../../services/systemHealth.service';

export const SystemHealthPage: React.FC = () => {
  const { t } = useTranslation();
  const { formatDateTime: fmtDateTime } = useLocalizedDate();

  const { data, isLoading } = useQuery({
    queryKey: ['system-health-failures'],
    queryFn: () => systemHealthService.getFailures(),
  });

  const retryMutation = useMutationWithToast({
    mutationFn: (id: number) => systemHealthService.retryEmail(id),
    invalidateKeys: [['system-health-failures']],
    successMessage: t('systemHealth.retriedToast', 'Email re-queued.'),
    errorMessage: () => t('toast.saveError'),
  });
  const dismissMutation = useMutationWithToast({
    mutationFn: (id: number) => systemHealthService.dismissEmail(id),
    invalidateKeys: [['system-health-failures']],
    successMessage: t('systemHealth.dismissedToast', 'Dismissed.'),
    errorMessage: () => t('toast.saveError'),
  });

  const stuckEmails = data?.stuckEmails ?? [];
  const waitingEmails = data?.waitingEmails ?? [];
  const processor = data?.processor;

  // The processor is only "fine" when it has been started AND its last pass
  // didn't bail. A started-but-erroring processor is the case that used to
  // read as healthy, so it gets its own state rather than folding into either.
  const processorState: 'ok' | 'degraded' | 'stopped' = !processor
    ? 'ok'
    : !processor.started
      ? 'stopped'
      : processor.lastError
        ? 'degraded'
        : 'ok';

  const emailTable = (rows: StuckEmail[], showError: boolean) => (
    <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
            <tr>
              <th className="px-3 py-2 text-left">{t('systemHealth.stuckEmails.col.recipient', 'Recipient')}</th>
              <th className="px-3 py-2 text-left">{t('systemHealth.stuckEmails.col.type', 'Type')}</th>
              <th className="px-3 py-2 text-left">
                {showError
                  ? t('systemHealth.stuckEmails.col.error', 'Error')
                  : t('systemHealth.waitingEmails.col.attempts', 'Attempts')}
              </th>
              <th className="px-3 py-2 text-left">{t('systemHealth.stuckEmails.col.queued', 'Queued')}</th>
              <th className="px-3 py-2 text-right">{t('systemHealth.stuckEmails.col.actions', 'Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} className="border-t border-neutral-200 dark:border-neutral-700 align-top">
                <td className="px-3 py-2 break-all">{m.recipientEmail}</td>
                <td className="px-3 py-2 font-mono text-xs">{m.emailType}</td>
                <td className="px-3 py-2 max-w-xs">
                  {showError ? (
                    <span className="text-xs text-red-700 dark:text-red-400 break-words">
                      {m.errorMessage || t('systemHealth.stuckEmails.noError', 'retries exhausted')}
                    </span>
                  ) : (
                    <span className="text-xs text-neutral-600 dark:text-neutral-400">
                      {m.retryCount > 0
                        ? t('systemHealth.waitingEmails.attempted', '{{count}} attempt(s), last error: {{error}}', {
                          count: m.retryCount,
                          error: m.errorMessage || t('systemHealth.waitingEmails.unknownError', 'unknown'),
                        })
                        : t('systemHealth.waitingEmails.neverAttempted', 'never attempted')}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{m.createdAt ? fmtDateTime(m.createdAt) : '—'}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="outline" size="sm"
                      isLoading={retryMutation.isPending && retryMutation.variables === m.id}
                      onClick={() => retryMutation.mutate(m.id)}
                      leftIcon={<RefreshCw className="w-3.5 h-3.5" />}>
                      {t('systemHealth.retry', 'Retry')}
                    </Button>
                    <button type="button"
                      aria-label={t('systemHealth.dismiss', 'Dismiss') as string}
                      onClick={() => dismissMutation.mutate(m.id)}
                      className="p-1.5 text-neutral-400 hover:text-red-600">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="container py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{t('systemHealth.title', 'System health')}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
          {t('systemHealth.subtitle', 'Background failures that need attention.')}
        </p>
      </div>

      {/* Queue processor. Listed first because when this is stopped, every
          other count on the page is explained by it — and a stopped processor
          shows no failures at all, which is what made it invisible. */}
      {!isLoading && processor && (
        <Card padding="lg" className="mb-4">
          <div className="flex items-start gap-3">
            {processorState === 'ok'
              ? <Mail className="w-5 h-5 mt-0.5 text-green-600 dark:text-green-400 shrink-0" />
              : <MailX className="w-5 h-5 mt-0.5 text-red-600 dark:text-red-400 shrink-0" />}
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                {t('systemHealth.processor.title', 'Email queue processor')}
              </h2>
              <p className={`text-sm mt-0.5 ${
                processorState === 'ok'
                  ? 'text-neutral-600 dark:text-neutral-400'
                  : 'text-red-700 dark:text-red-400'
              }`}>
                {processorState === 'stopped'
                  ? t('systemHealth.processor.stopped',
                    'Not running on this instance. Queued emails are written to the database but nothing is sending them.')
                  : processorState === 'degraded'
                    ? t('systemHealth.processor.degraded',
                      'Running, but the last pass could not send: {{error}}', { error: processor.lastError })
                    : t('systemHealth.processor.running', 'Running.')}
              </p>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {processor.lastRunAt
                  ? t('systemHealth.processor.lastRun', 'Last pass {{when}}', { when: fmtDateTime(processor.lastRunAt) })
                  : t('systemHealth.processor.neverRan', 'Has not run since this instance started.')}
                {processor.lastResult && (
                  <> {' · '}
                    {t('systemHealth.processor.lastResult', '{{sent}} sent, {{failed}} failed', {
                      sent: processor.lastResult.sent,
                      failed: processor.lastResult.failed,
                    })}
                  </>
                )}
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Due but unsent. Distinct from failed: nothing went wrong with these,
          they were simply never picked up. */}
      <Card padding="lg" className="mb-4">
        <div className="flex items-center gap-2 mb-3">
          <Clock className="w-5 h-5 text-amber-500" />
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            {t('systemHealth.waitingEmails.title', 'Waiting to send')}
          </h2>
          {!isLoading && (
            <span className="ml-1 text-sm text-neutral-500 dark:text-neutral-400">({waitingEmails.length})</span>
          )}
        </div>

        {isLoading ? <Loading /> : waitingEmails.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400 py-6">
            <CheckCircle className="w-5 h-5" />
            {t('systemHealth.waitingEmails.empty', 'Nothing waiting — the queue is being worked.')}
          </div>
        ) : (
          <>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-3">
              {t('systemHealth.waitingEmails.description',
                'Queued more than 10 minutes ago, due now, and still unsent. These have not failed — nothing has tried to send them.')}
            </p>
            {emailTable(waitingEmails, false)}
          </>
        )}
      </Card>

      <Card padding="lg">
        <div className="flex items-center gap-2 mb-3">
          <AlertCircle className="w-5 h-5 text-amber-500" />
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            {t('systemHealth.stuckEmails.title', 'Stuck / failed emails')}
          </h2>
          {!isLoading && (
            <span className="ml-1 text-sm text-neutral-500 dark:text-neutral-400">({stuckEmails.length})</span>
          )}
        </div>

        {isLoading ? <Loading /> : stuckEmails.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400 py-6">
            <CheckCircle className="w-5 h-5" />
            {t('systemHealth.stuckEmails.empty', 'No stuck or failed emails — all clear.')}
          </div>
        ) : emailTable(stuckEmails, true)}
      </Card>
    </div>
  );
};
