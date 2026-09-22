/**
 * Admin → customer record → Documents → "Requested from the customer"
 * (#1444 slice 10).
 *
 * The studio asks the customer for a document. The request shows under
 * "Needs your attention" in their portal until they upload against it; the
 * server mails the customer and follows up on the reminder ladder. Rendered
 * inside CustomerDocumentsCard, behind the same permission.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Inbox, Send, XCircle } from 'lucide-react';

import { Button } from '../common';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import {
  customerDocumentsAdminService,
  type AdminDocumentRequest,
} from '../../services/customerDocumentsAdmin.service';
import { calendarDay } from '../../utils/calendarDay';

const inputClass = 'h-9 w-full rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-2 text-sm text-neutral-900 dark:text-neutral-100';

const STATUS_STYLE: Record<AdminDocumentRequest['status'], string> = {
  open: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  fulfilled: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  cancelled: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
};

export const CustomerDocumentRequests: React.FC<{ customerId: number; canManage: boolean }> = ({ customerId, canManage }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { format: fmtDate } = useLocalizedDate();
  const queryKey = ['admin-customer-document-requests', customerId];
  const { data: requests = [] } = useQuery({
    queryKey,
    queryFn: () => customerDocumentsAdminService.listRequests(customerId),
    enabled: canManage,
  });
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const { notification } = await customerDocumentsAdminService.createRequest(customerId, {
        title: title.trim(),
        note: note.trim() || null,
        // A calendar day, stored at noon UTC and always shown by its UTC date
        // (calendarDay; the mail does the same). The admin's own end of day
        // was already the next day in UTC west of Greenwich.
        dueAt: due ? `${due}T12:00:00.000Z` : null,
      });
      const done = t('customers.documents.requests.created', 'Request sent.');
      if (notification === 'queued') toast.success(`${done} ${t('customers.documents.notified', 'The customer gets an email.')}`);
      else if (notification === 'failed') toast.warning(`${done} ${t('customers.documents.notifyFailed', 'The email to the customer could not be queued.')}`);
      else toast.success(done);
      setTitle(''); setNote(''); setDue('');
      await qc.invalidateQueries({ queryKey });
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t('customers.documents.actionError', 'That did not work. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (req: AdminDocumentRequest) => {
    setBusy(true);
    try {
      await customerDocumentsAdminService.cancelRequest(customerId, req.id);
      toast.success(t('customers.documents.requests.cancelled', 'Request cancelled.'));
      await qc.invalidateQueries({ queryKey });
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t('customers.documents.actionError', 'That did not work. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = (status: AdminDocumentRequest['status']) => (
    status === 'open'
      ? t('customers.documents.requests.status.open', 'Waiting')
      : status === 'fulfilled'
        ? t('customers.documents.requests.status.fulfilled', 'Received')
        : t('customers.documents.requests.status.cancelled', 'Cancelled')
  );

  return (
    <section aria-labelledby={`doc-requests-${customerId}`} className="mt-6 pt-4 border-t border-neutral-200 dark:border-neutral-700">
      <h3 id={`doc-requests-${customerId}`} className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 flex items-center gap-2 mb-1">
        <Inbox className="w-4 h-4" />
        {t('customers.documents.requests.title', 'Requested from the customer')}
      </h3>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-3">
        {t('customers.documents.requests.hint', 'Ask the customer for a document. It shows under "Needs your attention" in their portal until they upload it, with reminders after the days set in Settings → CRM.')}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-[2fr_2fr_1fr_auto] gap-2 md:items-end mb-3">
        <label className="text-xs text-neutral-600 dark:text-neutral-400">
          <span className="block mb-1">{t('customers.documents.requests.titleLabel', 'What do you need?')}</span>
          <input className={inputClass} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
        </label>
        <label className="text-xs text-neutral-600 dark:text-neutral-400">
          <span className="block mb-1">{t('customers.documents.requests.noteLabel', 'Note for the customer (optional)')}</span>
          <input className={inputClass} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
        </label>
        <label className="text-xs text-neutral-600 dark:text-neutral-400">
          <span className="block mb-1">{t('customers.documents.requests.dueLabel', 'Needed by (optional)')}</span>
          <input type="date" className={inputClass} value={due} onChange={(e) => setDue(e.target.value)} disabled={busy} />
        </label>
        <Button
          type="button" variant="primary" size="sm" onClick={create} disabled={busy || !title.trim()}
          leftIcon={<Send className="w-4 h-4" />}
        >
          {t('customers.documents.requests.create', 'Request document')}
        </Button>
      </div>

      {requests.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {t('customers.documents.requests.empty', 'Nothing requested yet.')}
        </p>
      ) : (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
          {requests.map((req) => (
            <li key={req.id} className="py-2 flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100 break-words">{req.title}</span>
                  <span className={`text-[11px] px-1.5 py-0.5 rounded font-semibold ${STATUS_STYLE[req.status]}`}>
                    {statusLabel(req.status)}
                  </span>
                </div>
                {req.note && <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-0.5 break-words">{req.note}</p>}
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                  {t('customers.documents.requests.meta', 'Requested {{date}} · {{reminders}} reminder(s) sent', {
                    date: req.createdAt ? fmtDate(req.createdAt) : '',
                    reminders: req.reminderCount,
                  })}
                  {req.dueAt && <>{' · '}{t('customers.documents.requests.due', 'Needed by {{date}}', { date: fmtDate(calendarDay(req.dueAt)) })}</>}
                </p>
              </div>
              {req.status === 'open' && (
                <Button
                  type="button" variant="ghost" size="sm" disabled={busy}
                  leftIcon={<XCircle className="w-4 h-4" />}
                  onClick={() => cancel(req)}
                >
                  {t('customers.documents.requests.cancel', 'Cancel request')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

export default CustomerDocumentRequests;
