/**
 * Admin → System health. Aggregates background failures that would
 * otherwise go unnoticed. v1: stuck/failed outbound emails (the queue
 * processor gave up or exhausted retries), with retry + dismiss.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, RefreshCw, Trash2, CheckCircle } from 'lucide-react';
import { Button, Card, Loading } from '../../components/common';
import { useMutationWithToast } from '../../hooks';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { systemHealthService } from '../../services/systemHealth.service';

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

  return (
    <div className="container py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-theme">{t('systemHealth.title', 'System health')}</h1>
        <p className="text-sm text-muted-theme mt-1">
          {t('systemHealth.subtitle', 'Background failures that need attention.')}
        </p>
      </div>

      <Card padding="lg">
        <div className="flex items-center gap-2 mb-3">
          <AlertCircle className="w-5 h-5 text-amber-500" />
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            {t('systemHealth.stuckEmails.title', 'Stuck / failed emails')}
          </h2>
          {!isLoading && (
            <span className="ml-1 text-sm text-muted-theme">({stuckEmails.length})</span>
          )}
        </div>

        {isLoading ? <Loading /> : stuckEmails.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400 py-6">
            <CheckCircle className="w-5 h-5" />
            {t('systemHealth.stuckEmails.empty', 'No stuck or failed emails — all clear.')}
          </div>
        ) : (
          <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
                  <tr>
                    <th className="px-3 py-2 text-left">{t('systemHealth.stuckEmails.col.recipient', 'Recipient')}</th>
                    <th className="px-3 py-2 text-left">{t('systemHealth.stuckEmails.col.type', 'Type')}</th>
                    <th className="px-3 py-2 text-left">{t('systemHealth.stuckEmails.col.error', 'Error')}</th>
                    <th className="px-3 py-2 text-left">{t('systemHealth.stuckEmails.col.queued', 'Queued')}</th>
                    <th className="px-3 py-2 text-right">{t('systemHealth.stuckEmails.col.actions', 'Actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stuckEmails.map((m) => (
                    <tr key={m.id} className="border-t border-neutral-200 dark:border-neutral-700 align-top">
                      <td className="px-3 py-2 break-all">{m.recipientEmail}</td>
                      <td className="px-3 py-2 font-mono text-xs">{m.emailType}</td>
                      <td className="px-3 py-2 max-w-xs">
                        <span className="text-xs text-red-700 dark:text-red-400 break-words">
                          {m.errorMessage || t('systemHealth.stuckEmails.noError', 'retries exhausted')}
                        </span>
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
        )}
      </Card>
    </div>
  );
};
