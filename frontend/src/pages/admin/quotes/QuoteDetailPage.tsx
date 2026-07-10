/**
 * Quote detail (read + actions). Renders a summary of the quote plus
 * action buttons: Preview PDF / Resend / Duplicate / Convert to event.
 * Edit hops back to the editor.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Eye, Send, Copy, ArrowRightCircle, Edit2, Receipt, CheckCircle2, ScrollText, XCircle } from 'lucide-react';
import { Button, Card, Loading } from '../../../components/common';
import { DocumentLineageCard } from '../../../components/admin/DocumentLineageCard';
import { quotesService } from '../../../services/quotes.service';
import { billsService } from '../../../services/bills.service';
import { formatMoney } from '../../../components/admin/LineItemsTable';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { useFeatureFlags } from '../../../contexts/FeatureFlagsContext';
import { toast } from 'react-toastify';

export const QuoteDetailPage: React.FC = () => {
  const { t } = useTranslation();
  // H.4 / H.5 — hide the convert-to-{contract,invoice} buttons when
  // the matching feature flag is off. Backend would refuse the convert
  // anyway because the routes are gated, but rendering a button that
  // 404s on click is bad UX.
  const { flags } = useFeatureFlags();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { format: fmtDate, formatDateTime: fmtDateTime, formatTime: fmtTime } = useLocalizedDate();
  const { data, isLoading } = useQuery({
    queryKey: ['quote', id],
    queryFn: () => quotesService.get(parseInt(id!, 10)),
    enabled: !!id,
  });

  // Reciprocal lookup — pulls every invoice whose source_quote_id
  if (isLoading || !data) return <Loading />;
  const q = data.quote;

  const handlePreview = async () => {
    // Open the placeholder window synchronously so the browser sees a
    // user-gesture-initiated popup; redirect to the blob URL once the
    // PDF buffer is fetched. Without this the popup blocker kills it.
    const previewWindow = window.open('about:blank', '_blank');
    if (!previewWindow) {
      toast.error(t('quotes.errors.popupBlocked', 'Allow pop-ups for this site to preview the PDF.'));
      return;
    }
    try {
      const url = await quotesService.pdfUrl(q.id);
      previewWindow.location.href = url;
    } catch (err: any) {
      previewWindow.close();
      toast.error(err?.response?.data?.error || err.message || 'Preview failed');
    }
  };

  const handleSend = async () => {
    if (!window.confirm(t('quotes.confirmSend', 'Send this quote to the customer now?'))) return;
    try {
      await quotesService.send(q.id);
      toast.success(t('quotes.sentToast', 'Quote sent to customer.'));
      qc.invalidateQueries({ queryKey: ['quote', id] });
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Send failed');
    }
  };

  const handleConvert = async () => {
    if (!window.confirm(t('quotes.confirmConvert', 'Convert this accepted quote into an event + scheduled invoices?'))) return;
    try {
      const result = await quotesService.convert(q.id);
      toast.success(t('quotes.convertedToast', 'Quote converted to event #{{id}}', { id: result.eventId }));
      qc.invalidateQueries({ queryKey: ['quote', id] });
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Convert failed');
    }
  };

  const handleConvertToInvoice = async () => {
    if (!window.confirm(t('quotes.confirmConvertToInvoice',
      'Convert this quote into invoice(s) only? No gallery / event will be created.'))) return;
    try {
      const result = await quotesService.convertToInvoice(q.id);
      toast.success(t('quotes.convertedToInvoiceToast',
        '{{count}} invoice(s) created from this quote', { count: result.installmentsCreated }));
      qc.invalidateQueries({ queryKey: ['quote', id] });
      qc.invalidateQueries({ queryKey: ['invoices'] });
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Convert failed');
    }
  };

  const handleConvertToContract = async () => {
    if (!window.confirm(t('quotes.confirmConvertToContract',
      'Draft a contract from this quote? The customer + admin will both sign before event / invoice creation.'))) return;
    try {
      const result = await quotesService.convertToContract(q.id);
      toast.success(result.alreadyConverted
        ? (t('quotes.contractAlreadyLinkedToast', 'A contract was already drafted from this quote.') as string)
        : (t('quotes.convertedToContractToast', 'Contract drafted from this quote.') as string));
      navigate(`/admin/clients/contracts/${result.contractId}`);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Convert failed');
    }
  };

  /**
   * Admin accept-on-behalf. Used when the customer verbally agrees
   * on the phone — admin flips the quote to accepted immediately so
   * they can convert to an event/invoice without waiting for the
   * customer to click the public response link.
   */
  const handleAcceptOnBehalf = async () => {
    if (!window.confirm(t('quotes.confirmAcceptOnBehalf',
      'Mark this quote as accepted on behalf of the customer? Use only when they have verbally agreed (e.g. on the phone).'))) return;
    try {
      await quotesService.acceptOnBehalf(q.id);
      toast.success(t('quotes.acceptedOnBehalfToast', 'Quote marked as accepted.'));
      qc.invalidateQueries({ queryKey: ['quote', id] });
      qc.invalidateQueries({ queryKey: ['quotes'] });
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Accept failed');
    }
  };

  /**
   * Admin decline-on-behalf. Used when the customer says no by phone/
   * email — admin flips the quote to declined and (optionally) records
   * why. The quote can still be duplicated to start a fresh round.
   */
  const handleDeclineOnBehalf = async () => {
    const reason = window.prompt(t('quotes.declineReasonPrompt',
      'Mark this quote as declined on behalf of the customer? Optionally note why (leave blank to skip).'));
    // prompt returns null on Cancel; '' (empty) means "decline, no reason".
    if (reason === null) return;
    try {
      await quotesService.declineOnBehalf(q.id, reason.trim() || undefined);
      toast.success(t('quotes.declinedOnBehalfToast', 'Quote marked as declined.'));
      qc.invalidateQueries({ queryKey: ['quote', id] });
      qc.invalidateQueries({ queryKey: ['quotes'] });
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Decline failed');
    }
  };

  const handleDuplicate = async () => {
    try {
      const result = await quotesService.duplicate(q.id);
      navigate(`/admin/clients/quotes/${result.id}`);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Duplicate failed');
    }
  };

  const responseLocked = q.responseLockedAt && new Date(q.responseLockedAt).getTime() < Date.now();
  const canSend = ['draft', 'declined', 'expired'].includes(q.status);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <button onClick={() => navigate('/admin/clients/quotes')}
            className="text-sm text-neutral-600 dark:text-neutral-400 hover:underline mb-1 inline-flex items-center gap-1">
            <ArrowLeft className="w-4 h-4" /> {t('common.back', 'Back')}
          </button>
          <h2 className="text-xl font-bold">
            {q.quoteNumber} <span className="ml-2 text-xs font-medium px-2 py-0.5 rounded bg-neutral-100 text-neutral-700">{t(`quotes.status.${q.status}`, q.status)}</span>
          </h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {q.customer.companyName || q.customer.displayName || q.customer.email}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" onClick={handlePreview}><Eye className="w-4 h-4 mr-1" />{t('common.preview', 'Preview')}</Button>
          <Button variant="outline" onClick={() => navigate(`/admin/clients/quotes/${q.id}/edit`)}>
            <Edit2 className="w-4 h-4 mr-1" />{t('common.edit', 'Edit')}
          </Button>
          <Button variant="outline" onClick={handleDuplicate}><Copy className="w-4 h-4 mr-1" />{t('common.duplicate', 'Duplicate')}</Button>
          {canSend && <Button onClick={handleSend}><Send className="w-4 h-4 mr-1" />{q.status === 'draft' ? t('quotes.send', 'Send') : t('quotes.resend', 'Resend')}</Button>}
          {/* Accept-on-behalf — shown while the quote is in a state
              that hasn't been responded to yet (draft / sent /
              expired). Hidden once accepted / declined / converted. */}
          {['draft', 'sent', 'expired'].includes(q.status) && (
            <Button variant="outline" onClick={handleAcceptOnBehalf}>
              <CheckCircle2 className="w-4 h-4 mr-1" />
              {t('quotes.acceptOnBehalf', 'Accept on behalf')}
            </Button>
          )}
          {/* Decline-on-behalf — same states as accept-on-behalf. Flips
              the quote to declined for "customer said no by phone"
              cases; hidden once accepted / declined / converted. */}
          {['draft', 'sent', 'expired'].includes(q.status) && (
            <Button variant="outline" onClick={handleDeclineOnBehalf}>
              <XCircle className="w-4 h-4 mr-1" />
              {t('quotes.declineOnBehalf', 'Decline on behalf')}
            </Button>
          )}
          {q.status === 'accepted' && (
            <>
              <Button onClick={handleConvert}>
                <ArrowRightCircle className="w-4 h-4 mr-1" />{t('quotes.convert', 'Convert to event')}
              </Button>
              {/* Direct convert-to-invoice for engagements without a
                  photo deliverable (consulting, hire, etc). Hidden
                  once converted to either an event or to invoices.
                  H.5 — also hidden when the `bills` feature is off. */}
              {flags.bills && (
                <Button variant="outline" onClick={handleConvertToInvoice}>
                  <Receipt className="w-4 h-4 mr-1" />{t('quotes.convertToInvoice', 'Convert to invoice only')}
                </Button>
              )}
              {/* Convert to contract — drafts a contract from this
                  quote, leaves the quote 'accepted' so the contract is
                  the active deliverable. After both parties sign, the
                  contract detail page exposes its own convert-to-event
                  / convert-to-invoice buttons.
                  H.4 — hidden when the `contracts` feature is off. */}
              {flags.contracts && (
                <Button variant="outline" onClick={handleConvertToContract}>
                  <ScrollText className="w-4 h-4 mr-1" />{t('quotes.convertToContract', 'Convert to contract')}
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      <Card>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div><div className="text-neutral-600 dark:text-neutral-300">{t('quotes.field.issueDate', 'Issued')}</div><div>{fmtDate(q.issueDate)}</div></div>
          {q.validUntil && <div><div className="text-neutral-600 dark:text-neutral-300">{t('quotes.field.validUntil', 'Valid until')}</div><div>{fmtDate(q.validUntil)}</div></div>}
          <div><div className="text-neutral-600 dark:text-neutral-300">{t('quotes.field.eventName', 'Event')}</div><div>{q.eventName || '—'}</div></div>
          {q.eventDate && <div><div className="text-neutral-600 dark:text-neutral-300">{t('quotes.field.eventDate', 'Event date')}</div><div>{fmtDate(q.eventDate)}{q.eventTimeStart ? ` ${fmtTime(q.eventTimeStart)}-${q.eventTimeEnd ? fmtTime(q.eventTimeEnd) : ''}` : ''}</div></div>}
          {q.sentAt && <div><div className="text-neutral-600 dark:text-neutral-300">{t('quotes.field.sentAt', 'Sent at')}</div><div>{fmtDateTime(q.sentAt)}</div></div>}
          {q.acceptedAt && <div><div className="text-neutral-600 dark:text-neutral-300">{t('quotes.field.acceptedAt', 'Accepted at')}</div><div>{fmtDateTime(q.acceptedAt)}</div></div>}
          {q.declinedAt && <div><div className="text-neutral-600 dark:text-neutral-300">{t('quotes.field.declinedAt', 'Declined at')}</div><div>{fmtDateTime(q.declinedAt)}</div></div>}
          {q.declineReason && <div className="col-span-2 md:col-span-4"><div className="text-neutral-600 dark:text-neutral-300">{t('quotes.field.declineReason', 'Decline reason')}</div><div className="whitespace-pre-line">{q.declineReason}</div></div>}
          {q.respondedAt && !responseLocked && (
            <div><div className="text-neutral-600 dark:text-neutral-300">{t('quotes.field.responseWindow', 'Response window')}</div>
              <div className="text-amber-700">{t('quotes.responseWindowOpen', 'Open until {{at}}', { at: q.responseLockedAt ? fmtDateTime(q.responseLockedAt) : '' })}</div></div>
          )}
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold mb-3">{t('quotes.section.lineItems', 'Line items')}</h3>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-neutral-200 dark:border-neutral-700">
            <th className="text-left py-2">#</th>
            <th className="text-left py-2">{t('crm.lineItems.quantity', 'Qty')}</th>
            <th className="text-left py-2">{t('crm.lineItems.description', 'Description')}</th>
            <th className="text-right py-2">{t('crm.lineItems.unitPrice', 'Unit')}</th>
            <th className="text-right py-2">{t('crm.lineItems.total', 'Total')}</th>
          </tr></thead>
          <tbody>
            {data.lineItems.map((li) => (
              <tr key={li.id} className="border-b border-neutral-100 dark:border-neutral-800">
                <td className="py-2">{li.position}</td>
                <td className="py-2">{Number(li.quantity)}</td>
                <td className="py-2 whitespace-pre-line">{li.description}</td>
                <td className="py-2 text-right tabular-nums">{formatMoney(Number(li.unitPriceMinor || 0) / 100, q.currency)}</td>
                <td className="py-2 text-right tabular-nums">{formatMoney(Number(li.lineTotalMinor || 0) / 100, q.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-col items-end gap-1 mt-4 text-sm">
          <div className="flex gap-6"><span className="text-neutral-600">{t('crm.lineItems.subtotal', 'Subtotal')}:</span>
            <span className="tabular-nums w-28 text-right">{formatMoney(Number(q.netAmountMinor || 0) / 100, q.currency)}</span></div>
          <div className="flex gap-6"><span className="text-neutral-600">{t('crm.lineItems.vat', 'VAT')} ({Number(q.vatRate || 0).toFixed(1)}%):</span>
            <span className="tabular-nums w-28 text-right">{formatMoney(Number(q.vatAmountMinor || 0) / 100, q.currency)}</span></div>
          <div className="flex gap-6 font-semibold text-base"><span>{t('crm.lineItems.total', 'Total')}:</span>
            <span className="tabular-nums w-28 text-right">{formatMoney(Number(q.totalAmountMinor || 0) / 100, q.currency)}</span></div>
        </div>
      </Card>

      {/* Cross-document lineage via deal_uuid (migration 140). One UUID
          groups every quote / contract / invoice / Storno / reissue
          for this engagement; admin sees the full chain in one card.
          Replaces the previous per-FK LinkedDocumentsCard. */}
      <DocumentLineageCard
        dealUuid={q.dealUuid}
        current={{ kind: 'quote', id: q.id }}
        className="mt-4"
      />

      {q.internalNotes && (
        <Card>
          <h3 className="font-semibold mb-2">{t('quotes.section.internalNotes', 'Internal notes')}</h3>
          <p className="text-sm whitespace-pre-line text-neutral-700 dark:text-neutral-300">{q.internalNotes}</p>
        </Card>
      )}
    </div>
  );
};
