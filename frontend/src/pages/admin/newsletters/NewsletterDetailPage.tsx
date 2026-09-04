/**
 * Clients → Newsletters → campaign detail (#1264).
 *
 * The delivery record. While a campaign is sending this polls so the
 * operator can watch it drain — and, more to the point, so they can hit
 * Cancel while there are still pending rows to cancel.
 *
 * Per-recipient errors are shown verbatim: a bounced address is the one
 * thing the operator can actually act on afterwards.
 */
import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban } from 'lucide-react';
import { toast } from 'react-toastify';

import { Button, Card, Loading, useConfirm } from '../../../components/common';
import { usePermissions } from '../../../contexts/PermissionsContext';
import {
  newslettersService, type RecipientStatus,
} from '../../../services/newsletters.service';
import { StatusChip } from './NewsletterListPage';

const RECIPIENT_STATUS_STYLES: Record<RecipientStatus, string> = {
  queued: 'text-neutral-600 dark:text-neutral-400',
  sent: 'text-green-700 dark:text-green-400',
  failed: 'text-red-700 dark:text-red-400',
  cancelled: 'text-neutral-400 dark:text-neutral-500',
  skipped_opt_out: 'text-amber-700 dark:text-amber-400',
};

export const NewsletterDetailPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const campaignId = Number(id);
  const navigate = useNavigate();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  // Cancel stops a live send, so it is a `send` action. Progress and the
  // recipient table stay visible to a view-only role (#1264 review).
  const { hasPermission } = usePermissions();
  const canSend = hasPermission('newsletters.send');
  const [statusFilter, setStatusFilter] = useState<RecipientStatus | ''>('');
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['newsletter', campaignId],
    queryFn: () => newslettersService.get(campaignId),
    enabled: Number.isFinite(campaignId),
    // Poll only while it is actually moving. A finished campaign is a
    // static record and does not need to be re-fetched every few seconds.
    refetchInterval: (query) => {
      const status = query.state.data?.campaign.status;
      return status === 'queued' || status === 'sending' ? 5000 : false;
    },
  });

  const { data: recipients } = useQuery({
    queryKey: ['newsletter-recipients-list', campaignId, statusFilter, page],
    queryFn: () => newslettersService.recipients(campaignId, {
      page, limit: 25, status: statusFilter || undefined,
    }),
    enabled: Number.isFinite(campaignId),
    // Poll alongside the summary while the campaign is draining — otherwise
    // every row sat at "queued" until the operator reloaded, while the
    // counters above them climbed.
    refetchInterval: data?.campaign.status === 'queued' || data?.campaign.status === 'sending'
      ? 5000
      : false,
  });

  const cancelCampaign = async () => {
    const ok = await confirm({
      title: t('newsletters.cancelTitle', 'Cancel this campaign?') as string,
      message: t('newsletters.cancelBody',
        'Emails that have not gone out yet will be dropped. Emails already sent cannot be recalled.') as string,
      variant: 'danger',
    });
    if (!ok) return;
    try {
      const res = await newslettersService.cancel(campaignId);
      queryClient.invalidateQueries({ queryKey: ['newsletter', campaignId] });
      queryClient.invalidateQueries({ queryKey: ['newsletter-recipients-list'] });
      toast.success(t('newsletters.cancelled', '{{count}} pending emails cancelled.',
        { count: res.cancelled }));
    } catch {
      toast.error(t('newsletters.cancelFailed', 'Could not cancel the campaign.'));
    }
  };

  if (isLoading || !data) return <Loading />;
  const { campaign } = data;
  const inFlight = campaign.status === 'queued' || campaign.status === 'sending';
  const progress = campaign.recipientCount > 0
    ? Math.round(((campaign.sentCount + campaign.failedCount) / campaign.recipientCount) * 100)
    : 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-6 gap-4">
        <button
          type="button"
          onClick={() => navigate('/admin/clients/newsletters')}
          className="flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-400 hover:underline"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('newsletters.backToList', 'All campaigns')}
        </button>
        {inFlight && canSend && (
          <Button variant="outline" onClick={cancelCampaign} leftIcon={<Ban className="w-4 h-4" />}>
            {t('newsletters.cancel', 'Cancel campaign')}
          </Button>
        )}
      </div>

      <Card className="mb-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
              {campaign.name}
            </h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">{campaign.subject}</p>
          </div>
          <StatusChip status={campaign.status} />
        </div>

        <div className="grid grid-cols-3 gap-4 text-center">
          {([
            ['recipients', campaign.recipientCount, ''],
            ['sent', campaign.sentCount, 'text-green-700 dark:text-green-400'],
            ['failed', campaign.failedCount, campaign.failedCount > 0 ? 'text-red-700 dark:text-red-400' : ''],
          ] as const).map(([key, value, cls]) => (
            <div key={key} className="rounded-md bg-neutral-50 dark:bg-neutral-800/60 p-3">
              <div className={`text-2xl font-semibold tabular-nums ${cls}`}>{value}</div>
              <div className="text-xs text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mt-1">
                {t(`newsletters.col.${key}`, key)}
              </div>
            </div>
          ))}
        </div>

        {inFlight && (
          <div className="mt-4">
            <div className="h-2 rounded-full bg-neutral-200 dark:bg-neutral-700 overflow-hidden">
              <div
                data-testid="newsletter-progress"
                className="h-full rounded-full transition-all"
                style={{ width: `${progress}%`, backgroundColor: 'var(--color-accent)' }}
              />
            </div>
            <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
              {t('newsletters.sendingAt', 'Sending at {{rate}} emails per minute.',
                { rate: campaign.sendRatePerMinute })}
            </p>
          </div>
        )}
      </Card>

      <Card padding="none">
        <div className="p-4 flex items-center justify-between gap-4 border-b border-neutral-200 dark:border-neutral-700">
          <h3 className="font-semibold text-neutral-900 dark:text-neutral-100">
            {t('newsletters.recipientsTitle', 'Recipients')}
          </h3>
          <select
            aria-label={t('newsletters.filterByStatus', 'Filter by status') as string}
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value as RecipientStatus | ''); setPage(1); }}
            className="rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-1.5 text-sm"
          >
            <option value="">{t('newsletters.allStatuses', 'All statuses')}</option>
            {(['queued', 'sent', 'failed', 'cancelled', 'skipped_opt_out'] as RecipientStatus[])
              .map((s) => (
                <option key={s} value={s}>{t(`newsletters.recipientStatus.${s}`, s)}</option>
              ))}
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {(recipients?.data ?? []).map((r) => (
                <tr key={r.id} className="border-b border-neutral-100 dark:border-neutral-800 last:border-0">
                  <td className="px-4 py-2 text-neutral-800 dark:text-neutral-200">{r.email}</td>
                  <td className={`px-4 py-2 ${RECIPIENT_STATUS_STYLES[r.status]}`}>
                    {t(`newsletters.recipientStatus.${r.status}`, r.status)}
                  </td>
                  <td className="px-4 py-2 text-xs text-neutral-500 dark:text-neutral-400">
                    {r.errorMessage || (r.sentAt ? new Date(r.sentAt).toLocaleString() : '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {recipients && recipients.pagination.totalPages > 1 && (
          <div className="p-4 flex items-center justify-between border-t border-neutral-200 dark:border-neutral-700">
            <Button variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              {t('common.previous', 'Previous')}
            </Button>
            <span className="text-sm text-neutral-500 dark:text-neutral-400">
              {t('common.pageOf', 'Page {{page}} of {{total}}',
                { page, total: recipients.pagination.totalPages })}
            </span>
            <Button
              variant="outline"
              disabled={!recipients.pagination.hasMore}
              onClick={() => setPage((p) => p + 1)}
            >
              {t('common.next', 'Next')}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
};
