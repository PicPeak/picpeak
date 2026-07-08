/**
 * Sent-emails feed — read-only, paginated view of the email_queue table.
 * Rendered as the "Sent emails" tab inside EmailConfigPage. Pairs with
 * the "Send queued emails now" flush button on the SMTP tab: flush, then
 * watch what sent / failed here.
 *
 * Filters: status (pending/sent/failed), free-text search (recipient or
 * type), and a created-at date range. email_data is never fetched.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, AlertCircle } from 'lucide-react';
import { Button, Card, Loading } from '../common';
import { LocalizedDateInput } from '../common/LocalizedDateInput';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { emailService, type EmailQueueStatus } from '../../services/email.service';

const STATUSES: EmailQueueStatus[] = ['pending', 'sent', 'failed'];

const statusClass = (s: EmailQueueStatus): string =>
  s === 'sent' ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
    : s === 'failed' ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
      : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300';

export const SentEmailsPanel: React.FC = () => {
  const { t } = useTranslation();
  const { formatDateTime: fmtDateTime } = useLocalizedDate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<EmailQueueStatus | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['email-queue', { search, statusFilter, from, to, page }],
    queryFn: () => emailService.listQueue({
      q: search || undefined,
      status: statusFilter || undefined,
      from: from || undefined,
      to: to || undefined,
      page,
      pageSize: 25,
    }),
  });

  const resetTo1 = () => setPage(1);

  return (
    <Card padding="lg">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-1">
        {t('email.sentEmails.title', 'Sent emails')}
      </h2>
      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
        {t('email.sentEmails.subtitle', 'Delivery status of every queued and sent notification.')}
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            type="text"
            placeholder={t('email.sentEmails.searchPlaceholder', 'Search by recipient or type…') as string}
            className="w-full pl-9 pr-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
            value={search}
            onChange={(e) => { setSearch(e.target.value); resetTo1(); }}
          />
        </div>
        <div className="w-40">
          <LocalizedDateInput label={t('email.sentEmails.from', 'From') as string} value={from}
            onChange={(iso) => { setFrom(iso); resetTo1(); }} />
        </div>
        <div className="w-40">
          <LocalizedDateInput label={t('email.sentEmails.to', 'To') as string} value={to}
            onChange={(iso) => { setTo(iso); resetTo1(); }} />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1">
        {STATUSES.map((s) => {
          const active = statusFilter === s;
          return (
            <button key={s} type="button"
              onClick={() => { setStatusFilter(active ? null : s); resetTo1(); }}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                active
                  ? 'bg-accent-dark text-white border-accent-dark'
                  : 'bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 border-neutral-300 dark:border-neutral-600'
              }`}
            >{t(`email.sentEmails.status.${s}`, s)}</button>
          );
        })}
      </div>

      <div className="mt-4">
        {isLoading ? <Loading /> : !data || data.items.length === 0 ? (
          <p className="text-center text-neutral-500 dark:text-neutral-400 py-8">
            {t('email.sentEmails.empty', 'No emails match these filters.')}
          </p>
        ) : (
          <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
                  <tr>
                    <th className="px-3 py-2 text-left">{t('email.sentEmails.col.recipient', 'Recipient')}</th>
                    <th className="px-3 py-2 text-left">{t('email.sentEmails.col.type', 'Type')}</th>
                    <th className="px-3 py-2 text-left">{t('email.sentEmails.col.status', 'Status')}</th>
                    <th className="px-3 py-2 text-left">{t('email.sentEmails.col.created', 'Queued')}</th>
                    <th className="px-3 py-2 text-left">{t('email.sentEmails.col.sent', 'Sent')}</th>
                    <th className="px-3 py-2 text-left">{t('email.sentEmails.col.event', 'Event')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((m) => (
                    <tr key={m.id} className="border-t border-neutral-200 dark:border-neutral-700 align-top">
                      <td className="px-3 py-2 break-all">{m.recipientEmail}</td>
                      <td className="px-3 py-2 font-mono text-xs">{m.emailType}</td>
                      <td className="px-3 py-2">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusClass(m.status)}`}>
                          {t(`email.sentEmails.status.${m.status}`, m.status)}
                        </span>
                        {m.status === 'failed' && m.errorMessage && (
                          <div className="mt-1 flex items-start gap-1 text-xs text-red-700 dark:text-red-400 max-w-xs">
                            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                            <span className="break-words">{m.errorMessage}</span>
                          </div>
                        )}
                        {m.status === 'pending' && m.retryCount > 0 && (
                          <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                            {t('email.sentEmails.retries', '{{count}} retries', { count: m.retryCount })}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{m.createdAt ? fmtDateTime(m.createdAt) : '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{m.sentAt ? fmtDateTime(m.sentAt) : '—'}</td>
                      <td className="px-3 py-2">
                        {m.eventId ? (
                          <Link to={`/admin/events/${m.eventId}`} className="text-accent hover:underline" onClick={(e) => e.stopPropagation()}>
                            {m.eventName || `#${m.eventId}`}
                          </Link>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.pagination.totalPages > 1 && (
              <div className="flex justify-between items-center px-3 py-2 border-t border-neutral-200 dark:border-neutral-700 text-sm">
                <span className="text-neutral-500 dark:text-neutral-400">
                  {t('email.sentEmails.pagination', 'Page {{page}} of {{total}} · {{count}} emails', {
                    page: data.pagination.page, total: data.pagination.totalPages, count: data.pagination.total,
                  })}
                </span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                    {t('common.previous', 'Previous')}
                  </Button>
                  <Button variant="outline" size="sm" disabled={page >= data.pagination.totalPages} onClick={() => setPage((p) => p + 1)}>
                    {t('common.next', 'Next')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
};
