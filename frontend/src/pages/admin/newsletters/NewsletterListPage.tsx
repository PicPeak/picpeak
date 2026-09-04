/**
 * Clients → Newsletters — campaign list (#1264).
 *
 * The list is the safety surface as much as the index: status, how many
 * people a campaign reached, and how many failed, all visible without
 * opening anything. A campaign that half-delivered should be obvious here.
 */
import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Megaphone, Trash2 } from 'lucide-react';
import { toast } from 'react-toastify';

import { Button, Card, Loading, useConfirm } from '../../../components/common';
import { usePermissions } from '../../../contexts/PermissionsContext';
import {
  newslettersService, type Campaign, type CampaignStatus,
} from '../../../services/newsletters.service';

const STATUS_STYLES: Record<CampaignStatus, string> = {
  draft: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200',
  queued: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  sending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  sent: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
  cancelled: 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

export const StatusChip: React.FC<{ status: CampaignStatus }> = ({ status }) => {
  const { t } = useTranslation();
  return (
    <span
      data-testid={`status-${status}`}
      className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      {t(`newsletters.status.${status}`, status)}
    </span>
  );
};

export const NewsletterListPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  // The backend deliberately splits view from send, so a role can read
  // campaigns without being able to mail anyone. Showing New/Delete to such a
  // role only produces a 403 after the click (#1264 review).
  const { hasPermission } = usePermissions();
  const canSend = hasPermission('newsletters.send');
  const [statusFilter, setStatusFilter] = useState<CampaignStatus | ''>('');

  const { data: campaigns, isLoading } = useQuery({
    queryKey: ['newsletters', statusFilter],
    queryFn: () => newslettersService.list(statusFilter || undefined),
  });

  const createDraft = async () => {
    try {
      const campaign = await newslettersService.create({
        name: t('newsletters.untitled', 'Untitled campaign'),
        subject: t('newsletters.untitledSubject', 'Newsletter'),
      });
      navigate(`/admin/clients/newsletters/${campaign.id}/edit`);
    } catch {
      toast.error(t('newsletters.createFailed', 'Could not create the campaign.'));
    }
  };

  const remove = async (campaign: Campaign) => {
    const ok = await confirm({
      title: t('newsletters.deleteTitle', 'Delete campaign?') as string,
      message: t('newsletters.deleteBody',
        '"{{name}}" will be deleted. This cannot be undone.', { name: campaign.name }) as string,
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await newslettersService.remove(campaign.id);
      queryClient.invalidateQueries({ queryKey: ['newsletters'] });
      toast.success(t('newsletters.deleted', 'Campaign deleted.'));
    } catch {
      toast.error(t('newsletters.deleteFailed', 'Could not delete the campaign.'));
    }
  };

  if (isLoading) return <Loading />;

  return (
    <div>
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            {t('newsletters.title', 'Newsletters')}
          </h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
            {t('newsletters.subtitle',
              'Send a campaign to your customer accounts. Everyone who has opted out is skipped automatically, and every send carries an unsubscribe link.')}
          </p>
        </div>
        {canSend && (
          <Button onClick={createDraft} leftIcon={<Plus className="w-4 h-4" />}>
            {t('newsletters.new', 'New campaign')}
          </Button>
        )}
      </div>

      <div className="mb-4">
        <select
          aria-label={t('newsletters.filterByStatus', 'Filter by status') as string}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as CampaignStatus | '')}
          className="rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm"
        >
          <option value="">{t('newsletters.allStatuses', 'All statuses')}</option>
          {(['draft', 'queued', 'sending', 'sent', 'cancelled', 'failed'] as CampaignStatus[])
            .map((s) => <option key={s} value={s}>{t(`newsletters.status.${s}`, s)}</option>)}
        </select>
      </div>

      {!campaigns || campaigns.length === 0 ? (
        <Card>
          <div className="py-12 text-center">
            <Megaphone className="w-10 h-10 mx-auto text-neutral-300 dark:text-neutral-600 mb-3" />
            <p className="text-neutral-600 dark:text-neutral-400">
              {t('newsletters.empty', 'No campaigns yet.')}
            </p>
          </div>
        </Card>
      ) : (
        <Card padding="none">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-neutral-200 dark:border-neutral-700">
                <tr className="text-left text-neutral-600 dark:text-neutral-400">
                  <th className="px-4 py-3 font-medium">{t('newsletters.col.name', 'Name')}</th>
                  <th className="px-4 py-3 font-medium">{t('newsletters.col.status', 'Status')}</th>
                  <th className="px-4 py-3 font-medium text-right">{t('newsletters.col.recipients', 'Recipients')}</th>
                  <th className="px-4 py-3 font-medium text-right">{t('newsletters.col.sent', 'Sent')}</th>
                  <th className="px-4 py-3 font-medium text-right">{t('newsletters.col.failed', 'Failed')}</th>
                  <th className="px-4 py-3 font-medium">{t('newsletters.col.created', 'Created')}</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.id} className="border-b border-neutral-100 dark:border-neutral-800 last:border-0">
                    <td className="px-4 py-3">
                      <Link
                        // A draft opens straight in the composer: the detail
                        // page has no edit action, so linking a draft there
                        // left the operator with no way to resume it.
                        to={c.status === 'draft' && canSend
                          ? `/admin/clients/newsletters/${c.id}/edit`
                          : `/admin/clients/newsletters/${c.id}`}
                        className="font-medium hover:underline"
                        style={{ color: 'var(--color-accent)' }}
                      >
                        {c.name}
                      </Link>
                      <div className="text-xs text-neutral-500 dark:text-neutral-400">{c.subject}</div>
                    </td>
                    <td className="px-4 py-3"><StatusChip status={c.status} /></td>
                    <td className="px-4 py-3 text-right tabular-nums">{c.recipientCount}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{c.sentCount}</td>
                    <td className={`px-4 py-3 text-right tabular-nums ${c.failedCount > 0 ? 'text-red-600 dark:text-red-400 font-medium' : ''}`}>
                      {c.failedCount}
                    </td>
                    <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">
                      {new Date(c.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {/* Only a draft or a cancelled campaign can be deleted —
                          a sent one is a delivery record. */}
                      {canSend && (c.status === 'draft' || c.status === 'cancelled') && (
                        <button
                          type="button"
                          onClick={() => remove(c)}
                          aria-label={t('newsletters.deleteAria', 'Delete {{name}}', { name: c.name }) as string}
                          className="text-neutral-400 hover:text-red-600 dark:hover:text-red-400"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
};
