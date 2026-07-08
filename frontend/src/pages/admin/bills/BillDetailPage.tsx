/**
 * Invoice detail page. Displays the invoice + line items + payment log;
 * exposes the action set: Preview PDF, Send, Mark paid (modal), Send
 * reminder (manual escalation), Cancel.
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Eye, Send, CheckCircle, BellRing, XCircle, Truck, Edit2, RefreshCw } from 'lucide-react';
import { Button, Card, Loading, Input, LocalizedDateInput } from '../../../components/common';
import { DocumentLineageCard } from '../../../components/admin/DocumentLineageCard';
import { billsService, isDraftInvoice } from '../../../services/bills.service';
import { formatMoney } from '../../../components/admin/LineItemsTable';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { toast } from 'react-toastify';

export const BillDetailPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { format: fmtDate } = useLocalizedDate();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => billsService.get(parseInt(id!, 10)),
    enabled: !!id,
  });

  const [payDialogOpen, setPayDialogOpen] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  // Optional payment date — defaults to today, backdate it to when the
  // payment actually arrived. Drives `paid_at` (cash-basis revenue windows).
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [payMethod, setPayMethod] = useState('');
  const [payReference, setPayReference] = useState('');
  const [payNotes, setPayNotes] = useState('');
  // Migration 126 — admin ticks this when the customer paid the
  // discounted total within the Skonto window. The dialog auto-fills
  // the amount with total × (1 - skonto%) when ticked, but admin can
  // still override it (e.g. partial Skonto + partial waive).
  const [payWithSkonto, setPayWithSkonto] = useState(false);

  // Pre-build the line-item rows once per data change. Previously this
  // was an inline IIFE inside the JSX, rebuilding the array (and N
  // <tr> elements) on every render of the page — every payment-dialog
  // input keystroke triggered the full reshape. The hook lives above
  // the early-return so the rules of hooks stay happy; it returns []
  // while data is loading.
  const lineItemRows = useMemo<React.ReactNode[]>(() => {
    if (!data) return [];
    // Migration 119 hierarchy: top-level items get 1, 2, 3…, sub-items
    // render as N.M under their parent (indented, greyed, line total
    // in parens, empty price cells when unit_price = 0). Details_text
    // rows render as a small italic line below their parent. Mirrors
    // the customer-facing QuoteResponsePage table.
    let topCount = 0;
    let subCount = 0;
    const rows: React.ReactNode[] = [];
    const currency = data.invoice.currency;
    for (const li of data.lineItems) {
      const isSub = li.parentLineItemId != null || li.parentPosition != null;
      if (!isSub) { topCount += 1; subCount = 0; } else { subCount += 1; }
      const priceless = isSub && (!li.unitPriceMinor || Number(li.unitPriceMinor) === 0);
      rows.push(
        <tr
          key={`row-${li.id ?? li.position}`}
          className={`border-b border-neutral-100 dark:border-neutral-800 ${
            isSub ? 'text-neutral-500 dark:text-neutral-400' : ''
          }`}
        >
          <td className="py-2">{isSub ? `${topCount}.${subCount}` : topCount}</td>
          <td className="py-2">{Number(li.quantity)}</td>
          <td className={`py-2 whitespace-pre-line ${isSub ? 'pl-6' : ''}`}>
            {isSub ? '• ' : ''}{li.description}
          </td>
          <td className="py-2 text-right tabular-nums">
            {priceless ? '' : formatMoney(Number(li.unitPriceMinor || 0) / 100, currency)}
          </td>
          <td className={`py-2 text-right tabular-nums ${isSub ? 'italic' : ''}`}>
            {priceless
              ? ''
              : isSub
                ? `(${formatMoney(Number(li.lineTotalMinor || 0) / 100, currency)})`
                : formatMoney(Number(li.lineTotalMinor || 0) / 100, currency)}
          </td>
        </tr>
      );
      if (li.detailsText && String(li.detailsText).trim().length > 0) {
        rows.push(
          <tr key={`details-${li.id ?? li.position}`} className="border-b border-neutral-100 dark:border-neutral-800">
            <td className="py-1"></td>
            <td className="py-1"></td>
            <td
              className={`py-1 text-xs italic text-neutral-500 dark:text-neutral-400 whitespace-pre-line ${isSub ? 'pl-10' : 'pl-4'}`}
              colSpan={3}
            >
              {li.detailsText}
            </td>
          </tr>
        );
      }
    }
    return rows;
  }, [data]);

  if (isLoading || !data) return <Loading />;
  const inv = data.invoice;

  const handlePreview = async () => {
    // Sync-open the placeholder window before any await so the popup
    // blocker treats this as a user gesture, then redirect once the
    // blob URL is ready.
    const previewWindow = window.open('about:blank', '_blank');
    if (!previewWindow) {
      toast.error(t('bills.errors.popupBlocked', 'Allow pop-ups for this site to preview the PDF.'));
      return;
    }
    try {
      const url = await billsService.pdfUrl(inv.id);
      previewWindow.location.href = url;
    } catch (err: any) {
      previewWindow.close();
      toast.error(err?.response?.data?.error || err.message || 'Preview failed');
    }
  };
  const handleSend = async () => {
    if (!window.confirm(t('bills.confirmSend', 'Send invoice to customer now?'))) return;
    try { await billsService.send(inv.id); toast.success(t('bills.sentToast', 'Invoice sent.')); qc.invalidateQueries({ queryKey: ['invoice', id] }); }
    catch (e: any) { toast.error(e?.response?.data?.error || 'Send failed'); }
  };
  const handleReminder = async () => {
    if (!window.confirm(t('bills.confirmReminder', 'Send a reminder now?'))) return;
    try { await billsService.sendReminder(inv.id); toast.success(t('bills.reminderToast', 'Reminder sent.')); qc.invalidateQueries({ queryKey: ['invoice', id] }); }
    catch (e: any) { toast.error(e?.response?.data?.error || 'Reminder failed'); }
  };
  const handleCancel = async () => {
    // Confirmation copy depends on whether the invoice has been
    // issued: drafts get a quiet soft-cancel, but sent/overdue/paid
    // invoices trigger a Stornorechnung that's emailed to the
    // customer immediately. We surface that contract explicitly so
    // admins know it can't be undone.
    const msg = inv.status === 'scheduled'
      ? t('bills.confirmCancelDraft', 'Cancel this draft invoice? No document goes out.')
      : t('bills.confirmCancelIssued',
        'A Stornorechnung will be generated and emailed to the customer immediately. This cannot be undone. Continue?');
    if (!window.confirm(msg)) return;
    try {
      const result = await billsService.cancel(inv.id);
      toast.success(result.stornoId
        ? t('bills.cancelledWithStornoToast', 'Invoice cancelled — Stornorechnung issued to the customer.')
        : t('bills.cancelledToast', 'Invoice cancelled.'));
      qc.invalidateQueries({ queryKey: ['invoice', id] });
      qc.invalidateQueries({ queryKey: ['invoices'] });
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Cancel failed');
    }
  };
  /**
   * Cancel + reissue — the legally-correct alternative to editing
   * a sent invoice. Atomically:
   *   1. Cancels this invoice (status → cancelled)
   *   2. Creates a new scheduled invoice with a fresh number,
   *      same line items, linked via replacesInvoiceId
   *   3. Navigates to the new invoice's editor so the admin can
   *      adjust whatever was wrong before sending
   * For invoices that were never sent, use Edit instead — the
   * backend rejects reissue with USE_EDIT_INSTEAD.
   */
  const handleReissue = async () => {
    // For already-cancelled invoices the backend skips Storno creation
    // (the original was either soft-cancelled as a draft, or a prior
    // Storno already exists). For live invoices we explicitly warn
    // that a Stornorechnung will be issued + emailed.
    const msg = inv.status === 'cancelled'
      ? t('bills.confirmReissueCancelled',
        'Create a new scheduled invoice with the same line items, linked back to this cancelled one?')
      : t('bills.confirmReissue',
        'A Stornorechnung will be issued to the customer for this invoice, and a new scheduled draft will be created with the same line items. The new invoice will reference this one as "Replaces R-XXXX". Continue?');
    if (!window.confirm(msg)) return;
    try {
      const result = await billsService.reissue(inv.id);
      toast.success(result.stornoId
        ? t('bills.reissuedWithStornoToast',
          'Stornorechnung issued — opening the new draft.')
        : t('bills.reissuedToast', 'Invoice reissued — opening the new draft.'));
      qc.invalidateQueries({ queryKey: ['invoice', id] });
      qc.invalidateQueries({ queryKey: ['invoices'] });
      navigate(`/admin/clients/bills/${result.id}/edit`);
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Reissue failed');
    }
  };

  /**
   * Release a delivery invoice — fires immediately. Used for the
   * last installment in a split-payment plan (after_delivery
   * trigger). Photos have been delivered, admin clicks the button,
   * customer gets the final invoice.
   */
  const handleRelease = async () => {
    if (!window.confirm(t('bills.confirmRelease',
      'Mark the photos as delivered and send this invoice to the customer now?'))) return;
    try {
      await billsService.releaseForDelivery(inv.id);
      toast.success(t('bills.releasedToast', 'Delivery invoice sent.'));
      qc.invalidateQueries({ queryKey: ['invoice', id] });
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Release failed');
    }
  };
  const submitPayment = async () => {
    try {
      await billsService.markPaid(inv.id, {
        amountMinor: Math.round(Number(payAmount) * 100),
        paidAt: payDate || undefined,
        paymentMethod: payMethod || undefined,
        reference: payReference || undefined,
        notes: payNotes || undefined,
        skontoApplied: payWithSkonto,
      });
      setPayDialogOpen(false);
      setPayAmount(''); setPayMethod(''); setPayReference(''); setPayNotes('');
      setPayWithSkonto(false);
      setPayDate(new Date().toISOString().slice(0, 10));
      qc.invalidateQueries({ queryKey: ['invoice', id] });
      toast.success(t('bills.paymentRecordedToast', 'Payment recorded.'));
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Failed to record payment');
    }
  };

  // "Outstanding" mirrors the server's paid-threshold (principal only,
  // late fee tracked separately) so the placeholder value in the
  // mark-paid dialog matches the amount that flips the invoice to
  // status='paid'. The late-fee row above still shows the surcharge
  // separately so admins know what they could optionally collect.
  //
  // When the server has already flipped the invoice to 'paid' — including
  // the Skonto path where paid_amount_minor < total_amount_minor by the
  // discount — outstanding MUST read zero. Without this, the Skonto branch
  // of markPaid leaves the customer-facing UI claiming the discounted
  // amount is still owed (migration 126 bug surfaced as `total - paid`
  // doesn't subtract the Skonto discount).
  const outstanding = inv.status === 'paid'
    ? 0
    : (Number(inv.totalAmountMinor || 0) - Number(inv.paidAmountMinor || 0)) / 100;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <button onClick={() => navigate('/admin/clients/bills')}
            className="text-sm text-neutral-600 dark:text-neutral-400 hover:underline mb-1 inline-flex items-center gap-1">
            <ArrowLeft className="w-4 h-4" /> {t('common.back', 'Back')}
          </button>
          <h2 className="text-xl font-bold">{inv.invoiceNumber}
            {/* Storno discriminator badge — sits next to the number so
                the admin sees at a glance that this row is a
                cancellation document, not an invoice. */}
            {inv.kind === 'storno' && (
              <span className="ml-2 text-xs font-semibold px-2 py-0.5 rounded bg-purple-100 text-purple-800">
                {t('bills.kind.storno', 'Stornorechnung')}
              </span>
            )}
            <span className="ml-2 text-xs font-medium px-2 py-0.5 rounded bg-neutral-100 text-neutral-700">
              {/* Held invoice ('scheduled' with no send date, incl. the
                  monthly/manual accumulator) never auto-ships — read it as
                  "Draft", matching the Bills list. */}
              {isDraftInvoice(inv) ? t('bills.status.draft', 'Draft') : t(`bills.status.${inv.status}`, inv.status)}
            </span>
          </h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {inv.customer.companyName || inv.customer.displayName || inv.customer.email}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" onClick={handlePreview}><Eye className="w-4 h-4 mr-1" />{t('common.preview', 'Preview')}</Button>
          {/* The bulk of the action set is gated on `kind === 'invoice'`
              — a Stornorechnung can't be edited, marked paid,
              reminded, cancelled, or reissued. The backend enforces
              these guards (IS_STORNO errors), but hiding the buttons
              keeps the admin from staring at greyed-out controls.
              The Send button stays available for storni in the rare
              edge case where the auto-send during creation failed
              and the scheduler hasn't retried yet. */}
          {inv.kind !== 'storno' && inv.status === 'scheduled' && (
            <Button variant="outline" onClick={() => navigate(`/admin/clients/bills/${inv.id}/edit`)}>
              <Edit2 className="w-4 h-4 mr-1" />{t('common.edit', 'Edit')}
            </Button>
          )}
          {/* Send button: hidden on monthly drafts (migration 128).
              Drafts ship only via "Trigger invoice now" on the customer
              detail page OR via the scheduled cadence-day flush —
              never directly. Clicking Send on a draft would early-ship
              the running accumulator AND leave is_monthly_draft=true,
              causing the next line-item save to silently append onto
              the already-sent row. Backend also enforces this. */}
          {['scheduled', 'sent', 'overdue'].includes(inv.status) && !inv.isMonthlyDraft && (
            <Button onClick={handleSend}><Send className="w-4 h-4 mr-1" />{inv.status === 'scheduled' ? t('bills.sendNow', 'Send now') : t('bills.resend', 'Resend')}</Button>
          )}
          {inv.isMonthlyDraft && (
            <span className="inline-flex items-center px-3 py-1.5 rounded-md text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200">
              {t('bills.monthlyDraftBadge',
                'Monthly draft — ships via the customer\'s cadence day or "Trigger invoice now"')}
            </span>
          )}
          {inv.kind !== 'storno' && inv.status === 'pending_delivery' && (
            <Button onClick={handleRelease}>
              <Truck className="w-4 h-4 mr-1" />
              {t('bills.releaseForDelivery', 'Mark delivered & send')}
            </Button>
          )}
          {inv.kind !== 'storno' && inv.status !== 'paid' && inv.status !== 'cancelled' && (
            <Button variant="outline" onClick={() => {
              // Pre-fill the reference with the invoice number — that's
              // what the admin types 95% of the time, so save them the
              // keystroke. Method left blank so the dropdown's "Select
              // method…" placeholder still nudges them to pick.
              setPayReference((cur) => cur || inv.invoiceNumber || '');
              setPayDialogOpen(true);
            }}>
              <CheckCircle className="w-4 h-4 mr-1" />{t('bills.markPaid', 'Mark paid')}
            </Button>
          )}
          {inv.kind !== 'storno' && (inv.status === 'sent' || inv.status === 'overdue') && inv.reminderLevel < 2 && (
            <Button variant="outline" onClick={handleReminder}>
              <BellRing className="w-4 h-4 mr-1" />{t('bills.sendReminder', 'Send reminder')}
            </Button>
          )}
          {inv.kind !== 'storno' && inv.status !== 'cancelled' && (
            <Button variant="outline" onClick={handleCancel}>
              <XCircle className="w-4 h-4 mr-1" />{t('common.cancel', 'Cancel')}
            </Button>
          )}
          {/* Cancel & reissue — the legally-clean alternative to
              post-send editing. Available for any invoice that's
              already been issued (sent, overdue, paid) or already
              cancelled (no-op cancel + create-new). Hidden for
              scheduled (use Edit) and pending_delivery (Release
              first if relevant). Hidden on storni — a Storno is the
              cancellation, not a candidate for further cancellation. */}
          {inv.kind !== 'storno' && ['sent', 'overdue', 'paid', 'cancelled'].includes(inv.status) && (
            <Button variant="outline" onClick={handleReissue}>
              <RefreshCw className="w-4 h-4 mr-1" />
              {inv.status === 'cancelled'
                ? t('bills.reissue', 'Reissue')
                : t('bills.cancelAndReissue', 'Cancel & reissue')}
            </Button>
          )}
        </div>
      </div>

      {/* Storno lineage banners. Two cases:
          - This row IS a Storno → show "Cancels Rechnung R-XXXX" with
            a link back to the original it reverses.
          - This row is a cancelled invoice with a Storno on file →
            show "Cancelled by Storno S-XXXX" with a forward link.
          Both lineage links are clickable so the admin can hop
          between the document pair without leaving the detail flow. */}
      {inv.kind === 'storno' && inv.cancelsInvoiceId && (
        <Card padding="md" className="bg-purple-50 dark:bg-purple-950/30 border-purple-200 dark:border-purple-800">
          <p className="text-sm text-purple-900 dark:text-purple-200">
            {t('bills.stornoCancelsLabel', 'This Stornorechnung cancels invoice')}{' '}
            <Link to={`/admin/clients/bills/${inv.cancelsInvoiceId}`} className="font-medium underline">
              {inv.cancelsInvoiceNumber || `#${inv.cancelsInvoiceId}`}
            </Link>
            .
          </p>
        </Card>
      )}
      {inv.kind !== 'storno' && inv.status === 'cancelled' && inv.cancellationStornoId && (
        <Card padding="md" className="bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800">
          <p className="text-sm text-amber-900 dark:text-amber-200">
            {t('bills.cancelledByStornoLabel', 'This invoice was cancelled by Stornorechnung')}{' '}
            <Link to={`/admin/clients/bills/${inv.cancellationStornoId}`} className="font-medium underline">
              {inv.cancellationStornoNumber || `#${inv.cancellationStornoId}`}
            </Link>
            .
          </p>
        </Card>
      )}

      {/* Cross-document lineage via deal_uuid (migration 140). Replaces
          the per-FK LinkedDocumentsCard. Storno relationships stay in
          the coloured callout cards above — those are warnings, not
          just lineage. */}
      <DocumentLineageCard
        dealUuid={inv.dealUuid}
        current={{ kind: 'invoice', id: inv.id }}
        className="mt-4"
      />

      <Card>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          {inv.eventName && (
            <div><div className="text-neutral-600 dark:text-neutral-300">{t('bills.field.eventName', 'Event')}</div>
              <div>
                {inv.eventId ? (
                  <Link to={`/admin/events/${inv.eventId}`} className="text-neutral-900 dark:text-neutral-100 hover:underline">{inv.eventName}</Link>
                ) : inv.eventName}
                {inv.eventDate ? ` · ${fmtDate(inv.eventDate)}` : ''}
              </div>
            </div>
          )}
          <div><div className="text-neutral-600 dark:text-neutral-300">{t('bills.field.issueDate', 'Issued')}</div><div>{fmtDate(inv.issueDate)}</div></div>
          <div><div className="text-neutral-600 dark:text-neutral-300">{t('bills.field.dueDate', 'Due')}</div><div>{fmtDate(inv.dueDate)}</div></div>
          {inv.scheduledSendAt && <div><div className="text-neutral-600 dark:text-neutral-300">{t('bills.field.scheduledSendAt', 'Scheduled send')}</div><div>{fmtDate(inv.scheduledSendAt)}</div></div>}
          {inv.installmentTotal > 1 && <div><div className="text-neutral-600 dark:text-neutral-300">{t('bills.field.installment', 'Installment')}</div><div>{inv.installmentIndex + 1}/{inv.installmentTotal}</div></div>}
          <div><div className="text-neutral-600 dark:text-neutral-300">{t('bills.field.total', 'Total')}</div><div>{formatMoney(Number(inv.totalAmountMinor || 0) / 100, inv.currency)}</div></div>
          <div><div className="text-neutral-600 dark:text-neutral-300">{t('bills.field.paid', 'Paid')}</div><div>{formatMoney(Number(inv.paidAmountMinor || 0) / 100, inv.currency)}</div></div>
          <div><div className="text-neutral-600 dark:text-neutral-300">{t('bills.field.outstanding', 'Outstanding')}</div>
            <div className={outstanding > 0 ? 'text-red-700 font-medium' : ''}>{formatMoney(outstanding, inv.currency)}</div></div>
          {inv.lateFeeAmountMinor > 0 && <div><div className="text-neutral-600 dark:text-neutral-300">{t('bills.field.lateFee', 'Late fee')}</div><div className="text-amber-700">{formatMoney(Number(inv.lateFeeAmountMinor) / 100, inv.currency)}</div></div>}
          {/* Source-quote / source-contract cross-links moved out of
              the top stats grid into the unified Linked-documents card
              above, mirroring the quote + contract detail pages. The
              customers see the same provenance as a "Bezug: ..." line
              on the PDF itself. */}
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold mb-3">{t('bills.section.lineItems', 'Line items')}</h3>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-neutral-200 dark:border-neutral-700">
            <th className="text-left py-2">#</th>
            <th className="text-left py-2">{t('crm.lineItems.quantity', 'Qty')}</th>
            <th className="text-left py-2">{t('crm.lineItems.description', 'Description')}</th>
            <th className="text-right py-2">{t('crm.lineItems.unitPrice', 'Unit')}</th>
            <th className="text-right py-2">{t('crm.lineItems.total', 'Total')}</th>
          </tr></thead>
          <tbody>{lineItemRows}</tbody>
        </table>
      </Card>

      <Card>
        <h3 className="font-semibold mb-3">{t('bills.section.paymentLog', 'Payment log')}</h3>
        {data.payments.length === 0 ? (
          <p className="text-sm text-neutral-500">{t('bills.noPayments', 'No payments recorded yet.')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-neutral-200 dark:border-neutral-700">
              {/* Per-cell horizontal padding so the right-aligned
                  Amount column and the left-aligned Method column
                  have visible breathing room. Without padding the
                  two collide visually on narrow rows. */}
              <th className="text-left py-2 pr-4">{t('bills.payment.paidAt', 'Date')}</th>
              <th className="text-right py-2 px-4">{t('bills.payment.amount', 'Amount')}</th>
              <th className="text-left py-2 pl-4 pr-4">{t('bills.payment.method', 'Method')}</th>
              <th className="text-left py-2 pr-4">{t('bills.payment.reference', 'Reference')}</th>
              <th className="text-left py-2">{t('bills.payment.notes', 'Notes')}</th>
            </tr></thead>
            <tbody>
              {data.payments.map((p) => (
                <tr key={p.id} className="border-b border-neutral-100 dark:border-neutral-800">
                  <td className="py-2 pr-4 whitespace-nowrap">{fmtDate(p.paidAt)}</td>
                  <td className="py-2 px-4 text-right tabular-nums whitespace-nowrap">{formatMoney(Number(p.amountMinor) / 100, inv.currency)}</td>
                  <td className="py-2 pl-4 pr-4 whitespace-nowrap">{p.paymentMethod || '—'}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{p.reference || '—'}</td>
                  <td className="py-2">{p.notes || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {payDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setPayDialogOpen(false)}>
          <div className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl w-full max-w-md mx-4 p-5"
            onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold mb-3 text-lg">{t('bills.markPaid', 'Mark paid')}</h3>
            <div className="space-y-3">
              <Input type="number" step="0.01" label={t('bills.payment.amount', 'Amount') as string} value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)} placeholder={String(outstanding.toFixed(2))} />
              {/* Optional payment date — drives `paid_at`, which the
                  dashboard's cash-basis revenue windows key on. Defaults
                  to today; backdate it to when the payment actually arrived. */}
              <LocalizedDateInput
                label={t('bills.payment.date', 'Payment date') as string}
                value={payDate}
                onChange={setPayDate}
              />
              {/* Skonto checkbox (migration 126). Only surfaced when
                  the invoice's payment terms actually offer Skonto —
                  the backend resolves skontoPercent from the snapshot
                  (with legacy + global fallback). Toggling auto-fills
                  the amount with total × (1 - skonto%); admin can
                  still override afterwards. */}
              {inv.skontoPercent != null && inv.skontoPercent > 0 && (
                <label className="flex items-start gap-2 text-sm py-1 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={payWithSkonto}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setPayWithSkonto(next);
                      if (next) {
                        const discounted = Math.round(
                          Number(inv.totalAmountMinor) * (1 - Number(inv.skontoPercent) / 100),
                        ) / 100;
                        setPayAmount(discounted.toFixed(2));
                      }
                    }}
                  />
                  <span>
                    {t('bills.payment.withSkonto',
                      'Paid with Skonto ({{percent}}% discount)',
                      { percent: inv.skontoPercent })}
                  </span>
                </label>
              )}
              {/* Payment method — common methods as a dropdown; we
                  persist the value verbatim so admins can still record
                  an out-of-band method by typing into the Notes field. */}
              <div>
                <label htmlFor="pay-method" className="block text-sm font-medium mb-1">
                  {t('bills.payment.method', 'Payment method')}
                </label>
                <select
                  id="pay-method"
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value)}
                  className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
                >
                  <option value="">{t('bills.payment.methodPlaceholder', 'Select method…')}</option>
                  <option value="bank_transfer">{t('bills.payment.methods.bankTransfer', 'Bank transfer')}</option>
                  <option value="cash">{t('bills.payment.methods.cash', 'Cash')}</option>
                  <option value="card">{t('bills.payment.methods.card', 'Card')}</option>
                  <option value="paypal">{t('bills.payment.methods.paypal', 'PayPal')}</option>
                  <option value="twint">{t('bills.payment.methods.twint', 'TWINT')}</option>
                </select>
              </div>
              <Input label={t('bills.payment.reference', 'Reference') as string} value={payReference}
                onChange={(e) => setPayReference(e.target.value)} />
              <div>
                <label className="block text-sm font-medium mb-1">{t('bills.payment.notes', 'Notes')}</label>
                <textarea rows={3} className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm"
                  value={payNotes} onChange={(e) => setPayNotes(e.target.value)} />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setPayDialogOpen(false)}>{t('common.cancel', 'Cancel')}</Button>
                <Button onClick={submitPayment} disabled={!payAmount}>{t('bills.recordPayment', 'Record payment')}</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
