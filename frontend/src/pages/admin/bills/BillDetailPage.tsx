/**
 * Invoice detail page. Displays the invoice + line items + payment log;
 * exposes the action set: Preview PDF, Send, Mark paid (modal), Send
 * reminder (manual escalation), Cancel.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Send, CheckCircle, BellRing, XCircle, Truck, RefreshCw } from 'lucide-react';
import { DecimalInput } from '../../../components/common/DecimalInput';
import { ActionMenu, Badge, Button, Card, Loading, Input, LocalizedDateInput, Modal, Notice, useConfirm, type ActionMenuItem, type BadgeTone } from '../../../components/common';
import { DocumentHeader } from '../../../components/admin/DocumentHeader';
import { SettingsSaveBar } from '../../../components/admin/SettingsSaveBar';
import { usePermission } from '../../../hooks/usePermission';
import { BillForm, type BillFormHandle, type BillFormState } from './BillEditorPage';
import { DocumentLineageCard } from '../../../components/admin/DocumentLineageCard';
import { billsService, isDraftInvoice } from '../../../services/bills.service';
import { accountingService, type InvoiceRebillProof } from '../../../services/accounting.service';
import { useFeatureFlags } from '../../../contexts/FeatureFlagsContext';
import { formatMoney } from '../../../components/admin/LineItemsTable';
import { formatMoneyMinor } from '../../../utils/money';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { toast } from 'react-toastify';

export const BillDetailPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { format: fmtDate } = useLocalizedDate();
  const { flags } = useFeatureFlags();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => billsService.get(parseInt(id!, 10)),
    enabled: !!id,
  });

  const [payDialogOpen, setPayDialogOpen] = useState(false);
  const [payAmount, setPayAmount] = useState(0);
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

  // Send dialog with per-file re-bill proof selection (#866).
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [sendProofs, setSendProofs] = useState<InvoiceRebillProof[]>([]);
  const [selectedProofIds, setSelectedProofIds] = useState<Set<number>>(new Set());
  const [sending, setSending] = useState(false);

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
      // Discount lines (#1451) are numbered, but carry no quantity or unit price.
      const isDiscount = li.lineKind === 'discount';
      if (!isSub) { topCount += 1; subCount = 0; } else { subCount += 1; }
      const priceless = isSub && (!li.unitPriceMinor || Number(li.unitPriceMinor) === 0);
      const unitLabel = li.unit ? t(`crm.lineItems.unitShort.${li.unit}`, li.unit) : '';
      const quantityText = isDiscount
        ? ''
        : li.unit === 'flat' ? unitLabel : `${Number(li.quantity)}${unitLabel ? ` ${unitLabel}` : ''}`;
      rows.push(
        <tr
          key={`row-${li.id ?? li.position}`}
          className={`border-b border-line-faint ${
            isSub ? 'text-muted' : ''
          }`}
        >
          <td className="py-2">{isDiscount ? '' : isSub ? `${topCount}.${subCount}` : topCount}</td>
          <td className="py-2">{quantityText}</td>
          <td className={`py-2 whitespace-pre-line ${isSub ? 'pl-6' : ''}`}>
            {isSub ? '• ' : ''}{li.description}
          </td>
          <td className="py-2 text-right tabular-nums">
            {priceless || isDiscount ? '' : formatMoneyMinor(Number(li.unitPriceMinor || 0), currency)}
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
          <tr key={`details-${li.id ?? li.position}`} className="border-b border-line-faint">
            <td className="py-1"></td>
            <td className="py-1"></td>
            <td
              className={`py-1 text-xs italic text-muted whitespace-pre-line ${isSub ? 'pl-10' : 'pl-4'}`}
              colSpan={3}
            >
              {li.detailsText}
            </td>
          </tr>
        );
      }
    }
    return rows;
  }, [data, t]);

  const confirm = useConfirm();
  const canManage = usePermission('bills.manage');
  // A scheduled invoice's page is its editor; the form reports unsaved edits.
  const formRef = useRef<BillFormHandle>(null);
  const [formState, setFormState] = useState<BillFormState>({ dirty: false, busy: false, valid: true, spawnCount: 0 });
  const onFormState = useCallback((next: BillFormState) => setFormState(next), []);

  if (isLoading || !data) return <Loading />;
  const inv = data.invoice;
  // Not issued yet: the server still takes edits. Issued invoices never
  // change again (§ 14 UStG) — Storno and reissue instead.
  const editable = canManage && inv.kind !== 'storno' && inv.status === 'scheduled';
  const dirty = editable && formState.dirty;

  const handlePreview = async () => {
    if (dirty) { await formRef.current?.previewUnsaved(); return; }
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
  // Actually dispatch the send. `proofInboundIds` = the admin's explicit
  // re-bill proof picks (empty array = attach none); undefined = no selection,
  // let the resolved default decide.
  const doSend = async (proofInboundIds?: number[]) => {
    setSending(true);
    try {
      await billsService.send(inv.id, proofInboundIds);
      toast.success(t('bills.sentToast', 'Invoice sent.'));
      qc.invalidateQueries({ queryKey: ['invoice', id] });
      setSendDialogOpen(false);
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Send failed');
    } finally {
      setSending(false);
    }
  };
  const handleSend = async () => {
    // If this invoice re-bills captured supplier invoices, open the Send dialog
    // so the admin can pick which proofs ride the email. Otherwise, plain send.
    if (flags.incomingInvoices) {
      try {
        const { proofs, attachDefault } = await accountingService.getInvoiceRebillProofs(inv.id);
        if (proofs.length > 0) {
          setSendProofs(proofs);
          setSelectedProofIds(new Set(attachDefault ? proofs.filter((p) => p.hasProof).map((p) => p.id) : []));
          setSendDialogOpen(true);
          return;
        }
      } catch { /* fall through to the plain confirm+send */ }
    }
    if (!(await confirm(dirty
      ? { title: t('bills.saveAndSendTitle', 'Send with your unsaved changes?'), message: t('bills.saveAndSendMessage', 'Your changes are saved first, then the invoice goes to the customer.'), confirmLabel: t('bills.saveAndSend', 'Save & send') }
      : { message: t('bills.confirmSend', 'Send invoice to customer now?'), confirmLabel: t('bills.sendNow', 'Send now') }))) return;
    if (dirty && !(await formRef.current?.save())) return;
    await doSend(undefined);
  };
  const handleReminder = async () => {
    if (!(await confirm({ message: t('bills.confirmReminder', 'Send a reminder now?'), confirmLabel: t('bills.sendReminder', 'Send reminder') }))) return;
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
    if (!(await confirm({ message: msg, variant: 'danger', confirmLabel: inv.status === 'scheduled' ? t('bills.cancelDraft', 'Cancel draft') : t('bills.cancelWithStorno', 'Cancel with Storno') }))) return;
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
    if (!(await confirm({ message: msg, variant: inv.status === 'cancelled' ? 'primary' : 'danger', confirmLabel: inv.status === 'cancelled' ? t('bills.reissue', 'Reissue') : t('bills.cancelAndReissue', 'Cancel & reissue') }))) return;
    try {
      const result = await billsService.reissue(inv.id);
      toast.success(result.stornoId
        ? t('bills.reissuedWithStornoToast',
          'Stornorechnung issued — opening the new draft.')
        : t('bills.reissuedToast', 'Invoice reissued — opening the new draft.'));
      qc.invalidateQueries({ queryKey: ['invoice', id] });
      qc.invalidateQueries({ queryKey: ['invoices'] });
      navigate(`/admin/clients/bills/${result.id}`);
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
    if (!(await confirm({ message: t('bills.confirmRelease', 'Mark the photos as delivered and send this invoice to the customer now?'), confirmLabel: t('bills.releaseForDelivery', 'Mark delivered & send') }))) return;
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
        amountMinor: Math.round(payAmount * 100),
        paidAt: payDate || undefined,
        paymentMethod: payMethod || undefined,
        reference: payReference || undefined,
        notes: payNotes || undefined,
        skontoApplied: payWithSkonto,
      });
      setPayDialogOpen(false);
      setPayAmount(0); setPayMethod(''); setPayReference(''); setPayNotes('');
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

  const customerName = inv.customer.companyName || inv.customer.displayName || inv.customer.email;
  const isIssued = ['sent', 'overdue', 'paid'].includes(inv.status);
  const canSend = canManage && ['scheduled', 'sent', 'overdue'].includes(inv.status) && !inv.isMonthlyDraft;
  const canPay = canManage && inv.kind !== 'storno' && inv.status !== 'paid' && inv.status !== 'cancelled';
  const openPay = () => {
    // Pre-fill the reference with the invoice number — that's what the
    // admin types 95% of the time.
    setPayReference((cur) => cur || inv.invoiceNumber || '');
    setPayDialogOpen(true);
  };
  const statusTone: Record<string, BadgeTone> = {
    scheduled: 'neutral', pending_delivery: 'info', sent: 'info', overdue: 'danger', paid: 'success', cancelled: 'neutral',
  };
  // The primary action of the moment: Send while scheduled, Mark delivered
  // for a delivery invoice, Mark paid once issued.
  const primary: 'send' | 'release' | 'pay' | null = inv.status === 'scheduled' && canSend
    ? 'send'
    : (inv.kind !== 'storno' && inv.status === 'pending_delivery' && canManage)
      ? 'release'
      : canPay ? 'pay' : null;
  const menu: ActionMenuItem[] = canManage ? [
    ...(canSend && inv.status !== 'scheduled' ? [{ key: 'resend', icon: <Send />, label: t('bills.resend', 'Resend'), disabled: sending, onSelect: () => { void handleSend(); } }] : []),
    ...(canPay && primary !== 'pay' ? [{ key: 'pay', icon: <CheckCircle />, label: t('bills.markPaid', 'Mark paid'), onSelect: openPay }] : []),
    ...(inv.kind !== 'storno' && (inv.status === 'sent' || inv.status === 'overdue') && inv.reminderLevel < 2
      ? [{ key: 'reminder', icon: <BellRing />, label: t('bills.sendReminder', 'Send reminder'), onSelect: () => { void handleReminder(); } }] : []),
    // Cancel & reissue: the legally clean alternative to editing an issued
    // invoice (sent, overdue, paid), or a fresh copy of a cancelled one.
    ...(inv.kind !== 'storno' && ['sent', 'overdue', 'paid', 'cancelled'].includes(inv.status)
      ? [{ key: 'reissue', icon: <RefreshCw />, label: inv.status === 'cancelled' ? t('bills.reissue', 'Reissue') : t('bills.cancelAndReissue', 'Cancel & reissue'), danger: inv.status !== 'cancelled', onSelect: () => { void handleReissue(); } }] : []),
    ...(inv.kind !== 'storno' && inv.status !== 'cancelled'
      ? [{ key: 'cancel', icon: <XCircle />, label: inv.status === 'scheduled' ? t('bills.cancelDraft', 'Cancel draft') : t('bills.cancelWithStorno', 'Cancel with Storno'), danger: true, onSelect: () => { void handleCancel(); } }] : []),
  ] : [];

  return (
    <div>
      <DocumentHeader
        title={inv.invoiceNumber}
        status={(
          <>
            {inv.kind === 'storno' && <Badge tone="storno">{t('bills.kind.storno', 'Stornorechnung')}</Badge>}
            {/* Held invoice ('scheduled' with no send date, incl. the
                monthly/manual accumulator) never auto-ships — read it as
                "Draft", matching the Bills list. */}
            <Badge tone={isDraftInvoice(inv) ? 'neutral' : (statusTone[inv.status] ?? 'neutral')}>
              {isDraftInvoice(inv) ? t('bills.status.draft', 'Draft') : t(`bills.status.${inv.status}`, inv.status)}
            </Badge>
          </>
        )}
        meta={(
          <>
            <span>{t('bills.forCustomer', 'for {{name}}', { name: customerName })}</span>
            {inv.eventName && <span>· {inv.eventName}</span>}
          </>
        )}
        actions={(
          <>
            <ActionMenu items={menu} />
            <Button variant="outline" onClick={() => { void handlePreview(); }} leftIcon={<Eye className="w-4 h-4" />}>{t('common.preview', 'Preview')}</Button>
            {primary === 'send' && (
              <Button onClick={() => { void handleSend(); }} disabled={formState.busy || (dirty && !formState.valid)} leftIcon={<Send className="w-4 h-4" />}>
                {t('bills.sendNow', 'Send now')}
              </Button>
            )}
            {primary === 'release' && (
              <Button onClick={() => { void handleRelease(); }} leftIcon={<Truck className="w-4 h-4" />}>{t('bills.releaseForDelivery', 'Mark delivered & send')}</Button>
            )}
            {primary === 'pay' && (
              <Button onClick={openPay} leftIcon={<CheckCircle className="w-4 h-4" />}>{t('bills.markPaid', 'Mark paid')}</Button>
            )}
          </>
        )}
      />

      <div className="space-y-3 mb-4">
        {/* Monthly drafts ship via the customer's cadence day or "Trigger
            invoice now" on the customer page — never directly (migration 128). */}
        {inv.isMonthlyDraft && (
          <Notice tone="info">{t('bills.monthlyDraftBadge', 'Monthly draft — ships via the customer\'s cadence day or "Trigger invoice now"')}</Notice>
        )}
        {inv.kind === 'storno' && inv.cancelsInvoiceId && (
          <Notice tone="neutral">
            {t('bills.stornoCancelsLabel', 'This Stornorechnung cancels invoice')}{' '}
            <Link to={`/admin/clients/bills/${inv.cancelsInvoiceId}`} className="font-medium text-accent hover:underline">
              {inv.cancelsInvoiceNumber || `#${inv.cancelsInvoiceId}`}
            </Link>.
          </Notice>
        )}
        {inv.kind !== 'storno' && inv.status === 'cancelled' && inv.cancellationStornoId && (
          <Notice tone="warning">
            {t('bills.cancelledByStornoLabel', 'This invoice was cancelled by Stornorechnung')}{' '}
            <Link to={`/admin/clients/bills/${inv.cancellationStornoId}`} className="font-medium text-accent hover:underline">
              {inv.cancellationStornoNumber || `#${inv.cancellationStornoId}`}
            </Link>.
          </Notice>
        )}
        {inv.kind !== 'storno' && isIssued && (
          <Notice
            tone="neutral"
            title={t('bills.issuedLockedTitle', 'Issued invoices can\'t be changed.')}
            action={canManage ? <Button size="sm" variant="outline" onClick={() => { void handleReissue(); }}>{t('bills.cancelAndReissue', 'Cancel & reissue')}</Button> : undefined}
          >
            {t('bills.issuedLocked', 'To correct it, cancel it with a Storno invoice and issue a new one.')}
          </Notice>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-6 items-start">
        <div className="space-y-4 min-w-0">
          {editable ? (
            <BillForm ref={formRef} invoiceId={inv.id} onStateChange={onFormState} />
          ) : (
            <>
          <Card>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              {inv.eventName && (
                <div><div className="text-body">{t('bills.field.eventName', 'Event')}</div>
                  <div>
                    {inv.eventId ? (
                      <Link to={`/admin/events/${inv.eventId}`} className="text-heading hover:underline">{inv.eventName}</Link>
                    ) : inv.eventName}
                    {inv.eventDate ? ` · ${fmtDate(inv.eventDate)}` : ''}
                  </div>
                </div>
              )}
              <div><div className="text-body">{t('bills.field.issueDate', 'Issued')}</div><div>{fmtDate(inv.issueDate)}</div></div>
              <div><div className="text-body">{t('bills.field.dueDate', 'Due')}</div><div>{fmtDate(inv.dueDate)}</div></div>
              {inv.scheduledSendAt && <div><div className="text-body">{t('bills.field.scheduledSendAt', 'Scheduled send')}</div><div>{fmtDate(inv.scheduledSendAt)}</div></div>}
              {inv.installmentTotal > 1 && <div><div className="text-body">{t('bills.field.installment', 'Installment')}</div><div>{inv.installmentIndex + 1}/{inv.installmentTotal}</div></div>}
              <div><div className="text-body">{t('bills.field.total', 'Total')}</div><div>{formatMoney(Number(inv.totalAmountMinor || 0) / 100, inv.currency)}</div></div>
              <div><div className="text-body">{t('bills.field.paid', 'Paid')}</div><div>{formatMoney(Number(inv.paidAmountMinor || 0) / 100, inv.currency)}</div></div>
              <div><div className="text-body">{t('bills.field.outstanding', 'Outstanding')}</div>
                <div className={outstanding > 0 ? 'text-danger-text font-medium' : ''}>{formatMoney(outstanding, inv.currency)}</div></div>
              {inv.lateFeeAmountMinor > 0 && <div><div className="text-body">{t('bills.field.lateFee', 'Late fee')}</div><div className="text-warning-text">{formatMoney(Number(inv.lateFeeAmountMinor) / 100, inv.currency)}</div></div>}
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
              <thead><tr className="border-b border-line">
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
              <p className="text-sm text-muted">{t('bills.noPayments', 'No payments recorded yet.')}</p>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-line">
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
                    <tr key={p.id} className="border-b border-line-faint">
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
            </>
          )}
        </div>
        <div className="space-y-4">
          {/* Cross-document lineage via deal_uuid (migration 140). Storno
              relationships stay in the notices above — those are warnings,
              not just lineage. */}
          <DocumentLineageCard dealUuid={inv.dealUuid} current={{ kind: 'invoice', id: inv.id }} />
        </div>
      </div>

      {editable && (
        <SettingsSaveBar
          isDirty={formState.dirty}
          isSaving={formState.busy}
          canSave={formState.valid}
          onSave={() => { void formRef.current?.save(); }}
          onDiscard={() => formRef.current?.discard()}
        />
      )}

      <Modal
        open={sendDialogOpen}
        onClose={() => { if (!sending) setSendDialogOpen(false); }}
        closeOnBackdrop={!sending}
        title={t('bills.send.title', 'Send invoice')}
        size="md"
        footer={(
          <>
            <Button variant="outline" disabled={sending} onClick={() => setSendDialogOpen(false)}>{t('common.cancel', 'Cancel')}</Button>
            <Button
              disabled={sending || formState.busy || (dirty && !formState.valid)}
              onClick={async () => {
                // Unsaved edits go out with the invoice: save them first, and
                // send nothing when that save fails.
                if (dirty && !(await formRef.current?.save())) return;
                await doSend(sendProofs.filter((p) => p.hasProof && selectedProofIds.has(p.id)).map((p) => p.id));
              }}
            >
              {t('bills.send.sendWithCount', 'Send with {{count}} proof(s)', { count: sendProofs.filter((p) => p.hasProof && selectedProofIds.has(p.id)).length })}
            </Button>
          </>
        )}
      >
        {dirty && (
          <Notice tone="warning" className="mb-3">
            {t('bills.saveAndSendMessage', 'Your changes are saved first, then the invoice goes to the customer.')}
          </Notice>
        )}
        <p className="text-sm text-soft mb-3">
          {t('bills.send.proofIntro', 'This invoice re-bills captured supplier invoices. Choose which supplier proofs to attach to the email — the invoice PDF is always attached.')}
        </p>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium uppercase tracking-wider text-muted">
            {t('bills.send.proofsLabel', 'Supplier proofs')}
          </span>
          <div className="flex gap-3 text-xs">
            <button type="button" className="text-accent hover:underline"
              onClick={() => setSelectedProofIds(new Set(sendProofs.filter((p) => p.hasProof).map((p) => p.id)))}>
              {t('bills.send.selectAll', 'Select all')}
            </button>
            <button type="button" className="text-muted hover:underline"
              onClick={() => setSelectedProofIds(new Set())}>
              {t('bills.send.selectNone', 'None')}
            </button>
          </div>
        </div>
        <ul className="max-h-64 overflow-y-auto divide-y divide-line border border-line rounded-md">
          {sendProofs.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-3 py-2">
              <input
                type="checkbox"
                className="rounded border-line-strong"
                disabled={!p.hasProof}
                checked={selectedProofIds.has(p.id)}
                onChange={(e) => setSelectedProofIds((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(p.id); else next.delete(p.id);
                  return next;
                })}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-heading truncate">
                  {p.supplierName || t('bills.send.unknownSupplier', 'Supplier')}
                  <span className="ml-2 text-xs text-muted">
                    {p.mode === 'passthrough' ? t('bills.send.modePassthrough', 'passthrough') : t('bills.send.modeRebill', 're-bill')}
                  </span>
                </div>
                {p.hasProof ? (
                  <div className="text-xs text-muted truncate">{p.filename || 'proof.pdf'}</div>
                ) : (
                  <div className="text-xs text-warning-text">{t('bills.send.noProofFile', 'No stored proof file')}</div>
                )}
              </div>
              <span className="text-sm tabular-nums text-body">{formatMoneyMinor(p.amountMinor, p.currency || inv.currency)}</span>
            </li>
          ))}
        </ul>
      </Modal>

      <Modal
        open={payDialogOpen}
        onClose={() => setPayDialogOpen(false)}
        title={t('bills.markPaid', 'Mark paid')}
        size="sm"
        footer={(
          <>
            <Button variant="outline" onClick={() => setPayDialogOpen(false)}>{t('common.cancel', 'Cancel')}</Button>
            <Button onClick={submitPayment} disabled={!(payAmount > 0)}>{t('bills.recordPayment', 'Record payment')}</Button>
          </>
        )}
      >
        <div className="space-y-3">
          <label className="block">
            <span className="block text-sm font-medium text-body mb-1">{t('bills.payment.amount', 'Amount')}</span>
            <DecimalInput value={payAmount} onChange={setPayAmount} placeholder={outstanding.toFixed(2)} className="input" />
          </label>
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
                    setPayAmount(discounted);
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
              {t('bills.payment.method', 'Method')}
            </label>
            <select
              id="pay-method"
              value={payMethod}
              onChange={(e) => setPayMethod(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-line-strong bg-panel text-sm focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent-dark"
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
            <textarea rows={3} className="w-full rounded-md border border-line-strong bg-panel px-3 py-2 text-sm"
              value={payNotes} onChange={(e) => setPayNotes(e.target.value)} />
          </div>
        </div>
      </Modal>
    </div>
  );
};
