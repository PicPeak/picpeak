/**
 * Received-emails feed — read-only, paginated view of the received_emails log
 * (the IMAP poller's audit trail). Rendered as the "Received emails" tab in
 * EmailConfigPage, next to "Sent emails".
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Inbox, Paperclip } from 'lucide-react';
import { Card, Loading, Button, Badge, Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell, ErrorState, type BadgeTone } from '../common';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { emailService } from '../../services/email.service';

const statusTone = (s: string): BadgeTone =>
  s === 'ingested' ? 'success'
    : s === 'error' ? 'danger'
      : 'neutral';

export const ReceivedEmailsPanel: React.FC = () => {
  const { t } = useTranslation();
  const { formatDateTime: fmtDateTime } = useLocalizedDate();
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, isFetching, refetch } = useQuery({ queryKey: ['received-emails', page], queryFn: () => emailService.listReceived({ page, pageSize: 25 }), refetchInterval: 30000, refetchOnWindowFocus: true });

  if (isLoading) return <Loading />;
  const items = data?.items ?? [];
  const pg = data?.pagination;

  if (isError && !data) {
    return (
      <Card className="p-0">
        <ErrorState
          title={t('email.received.loadFailed', 'Could not load received emails')}
          onRetry={() => refetch()}
          retrying={isFetching}
          size="inline"
        />
      </Card>
    );
  }

  if (items.length === 0) {
    return (
      <Card className="p-8 text-center">
        <Inbox className="w-10 h-10 mx-auto mb-3 text-faint" />
        <p className="text-sm text-soft">{t('email.received.empty', 'No received emails yet. Enable incoming mail and configure the mailbox.')}</p>
      </Card>
    );
  }

  return (
    <Card className="p-0 overflow-hidden">
      <Table containerClassName="border-0 rounded-none">
        <TableHead>
          <tr>
            <TableHeaderCell className="py-2">{t('email.received.from', 'From')}</TableHeaderCell>
            <TableHeaderCell className="py-2">{t('email.received.subject', 'Subject')}</TableHeaderCell>
            <TableHeaderCell className="py-2">{t('email.received.received', 'Received')}</TableHeaderCell>
            <TableHeaderCell className="py-2">{t('email.received.status', 'Status')}</TableHeaderCell>
          </tr>
        </TableHead>
        <TableBody>
          {items.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="py-2 truncate max-w-[14rem]">{r.from_address || '—'}</TableCell>
              <TableCell className="py-2 text-heading">
                <span className="truncate inline-block max-w-[18rem] align-middle">{r.subject || '—'}</span>
                {r.attachment_count > 0 && (
                  <span className="ml-2 inline-flex items-center gap-0.5 text-xs text-muted">
                    <Paperclip className="w-3 h-3" />{r.attachment_count}
                    {r.inbound_document_id && <Link to="/admin/accounting/inbox" className="ml-1 text-accent hover:underline">{t('email.received.inbox', 'inbox')}</Link>}
                  </span>
                )}
              </TableCell>
              <TableCell className="py-2 text-muted whitespace-nowrap">{r.received_at ? fmtDateTime(r.received_at) : '—'}</TableCell>
              <TableCell className="py-2"><Badge tone={statusTone(r.status)}>{t(`email.received.statusValue.${r.status}`, r.status)}</Badge></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {pg && pg.totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-line-faint text-sm">
          <Button size="sm" variant="outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>{t('common.previous', 'Previous')}</Button>
          <span className="text-muted">{page} / {pg.totalPages}</span>
          <Button size="sm" variant="outline" onClick={() => setPage((p) => Math.min(pg.totalPages, p + 1))} disabled={page >= pg.totalPages}>{t('common.next', 'Next')}</Button>
        </div>
      )}
    </Card>
  );
};

export default ReceivedEmailsPanel;
