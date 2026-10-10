/**
 * A quote's one page. While the server still lets it change (draft, sent,
 * expired — not accepted, declined or converted) and the admin may manage
 * quotes, the page is its editor: QuoteForm with the save bar. Afterwards
 * the same layout shows the quote read-only, with a notice saying why and
 * what to do instead. The header (status, ⋯ menu, Preview, the primary
 * action of the moment) is the same in both.
 */
import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Send, Copy, ArrowRightCircle, Receipt, CheckCircle2, ScrollText, XCircle, FilePlus, LayoutTemplate, RefreshCw } from 'lucide-react';
import { ActionMenu, Badge, Button, Card, Loading, Notice, useConfirm, usePrompt, type ActionMenuItem, type BadgeTone } from '../../../components/common';
import { DocumentHeader } from '../../../components/admin/DocumentHeader';
import { SettingsSaveBar } from '../../../components/admin/SettingsSaveBar';
import { usePermission } from '../../../hooks/usePermission';
import { QuoteForm, type QuoteFormHandle, type QuoteFormState } from './QuoteEditorPage';
import { DocumentLineageCard } from '../../../components/admin/DocumentLineageCard';
import { QuoteAddOnsCard } from './QuoteAddOnsCard';
import { quotesService } from '../../../services/quotes.service';
import { quoteCatalogService } from '../../../services/quoteCatalog.service';
import { formatMoney } from '../../../components/admin/LineItemsTable';
import { formatMoneyMinor } from '../../../utils/money';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { useFeatureFlags } from '../../../contexts/FeatureFlagsContext';
import { toast } from 'react-toastify';
import { quoteErrorText } from '../../../utils/quoteErrors';
import { ConvertToContractDialog } from './ConvertToContractDialog';

// The statuses the server refuses to edit (quoteService.updateQuote).
const LOCKED_STATUSES = ['accepted', 'declined', 'converted'];

const STATUS_TONE: Record<string, BadgeTone> = {
  draft: 'neutral', sent: 'info', expired: 'warning', accepted: 'success', declined: 'danger', converted: 'success',
};

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
  // "Convert to contract" asks which contract template to start from (#1445).
  const [convertOpen, setConvertOpen] = useState(false);
  const [converting, setConverting] = useState(false);
  const confirm = useConfirm();
  const [promptDialog, prompt] = usePrompt();
  const canManage = usePermission('quotes.manage');
  // The form (a draft's body) reports whether it holds unsaved edits.
  const formRef = useRef<QuoteFormHandle>(null);
  const [formState, setFormState] = useState<QuoteFormState>({ dirty: false, busy: false, valid: true, canRecalculate: false });
  const onFormState = useCallback((next: QuoteFormState) => setFormState(next), []);

  if (isLoading || !data) return <Loading />;
  const q = data.quote;
  // Accepted, and no contract, event or invoice yet: it can be reissued or declined.
  const canReissue = q.status === 'accepted' && !q.convertedEventId && !q.convertedContractId;
  const editable = canManage && !LOCKED_STATUSES.includes(q.status) && !q.replacedByQuoteId;
  const dirty = editable && formState.dirty;

  const handlePreview = async () => {
    if (dirty) { await formRef.current?.previewUnsaved(); return; }
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
    const to = q.customer.email || q.customer.companyName || q.customer.displayName || '';
    const ok = await confirm(dirty
      ? {
        title: t('quotes.saveAndSendTitle', 'Send with your unsaved changes?'),
        message: t('quotes.saveAndSendMessage', 'Your changes are saved first, then the quote goes to {{to}}.', { to }),
        confirmLabel: t('quotes.saveAndSend', 'Save & send'),
      }
      : {
        message: t('quotes.confirmSend', 'Send this quote to the customer now?'),
        confirmLabel: q.status === 'draft' ? t('quotes.send', 'Send') : t('quotes.resend', 'Resend'),
      });
    if (!ok) return;
    if (dirty) {
      const saved = await formRef.current?.save();
      if (!saved) return;
    }
    try {
      await quotesService.send(q.id);
      toast.success(t('quotes.sentToast', 'Quote sent to customer.'));
      qc.invalidateQueries({ queryKey: ['quote', id] });
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Send failed');
    }
  };

  const handleConvert = async () => {
    if (!(await confirm({
      message: t('quotes.confirmConvert', 'Convert this accepted quote into an event + scheduled invoices?'),
      confirmLabel: t('quotes.convert', 'Convert to event'),
    }))) return;
    try {
      const result = await quotesService.convert(q.id);
      toast.success(t('quotes.convertedToast', 'Quote converted to event #{{id}}', { id: result.eventId }));
      qc.invalidateQueries({ queryKey: ['quote', id] });
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Convert failed');
    }
  };

  const handleConvertToInvoice = async () => {
    if (!(await confirm({
      message: t('quotes.confirmConvertToInvoice', 'Convert this quote into invoice(s) only? No gallery / event will be created.'),
      confirmLabel: t('quotes.convertToInvoice', 'Convert to invoice only'),
    }))) return;
    setConverting(true);
    try {
      const result = await quotesService.convertToInvoice(q.id);
      toast.success(t('quotes.convertedToInvoiceToast',
        '{{count}} invoice(s) created from this quote', { count: result.installmentsCreated }));
      qc.invalidateQueries({ queryKey: ['quote', id] });
      qc.invalidateQueries({ queryKey: ['invoices'] });
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Convert failed');
    } finally {
      setConverting(false);
    }
  };

  const handleConvertToContract = async (contractTemplateId: number | null) => {
    setConverting(true);
    try {
      const result = await quotesService.convertToContract(q.id, contractTemplateId);
      toast.success(result.alreadyConverted
        ? (t('quotes.contractAlreadyLinkedToast', 'A contract was already drafted from this quote.') as string)
        : (t('quotes.convertedToContractToast', 'Contract drafted from this quote.') as string));
      navigate(`/admin/clients/contracts/${result.contractId}`);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Convert failed');
    } finally {
      setConverting(false);
    }
  };

  /**
   * Admin accept-on-behalf. Used when the customer verbally agrees
   * on the phone — admin flips the quote to accepted immediately so
   * they can convert to an event/invoice without waiting for the
   * customer to click the public response link.
   */
  const handleAcceptOnBehalf = async () => {
    // The customer agreed to what is on screen: unsaved edits are saved first.
    const savedFirst = dirty ? `\n\n${t('quotes.unsavedSavedFirst', 'Your unsaved changes are saved first.')}` : '';
    if (!(await confirm({
      message: t('quotes.confirmAcceptOnBehalf', 'Mark this quote as accepted on behalf of the customer? Use only when they have verbally agreed (e.g. on the phone).') + savedFirst,
      confirmLabel: t('quotes.acceptOnBehalf', 'Accept on behalf'),
    }))) return;
    if (dirty && !(await formRef.current?.save())) return;
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
    const savedFirst = dirty ? `\n\n${t('quotes.unsavedSavedFirst', 'Your unsaved changes are saved first.')}` : '';
    const reason = await prompt({
      title: t('quotes.declineOnBehalf', 'Decline on behalf'),
      message: t('quotes.declineReasonPrompt', 'Mark this quote as declined on behalf of the customer? Optionally note why (leave blank to skip).') + savedFirst,
      label: t('quotes.field.declineReason', 'Decline reason'),
      multiline: true,
      optional: true,
      confirmLabel: t('quotes.declineOnBehalf', 'Decline on behalf'),
      variant: 'danger',
    });
    // null on Cancel; '' (empty) means "decline, no reason".
    if (reason === null) return;
    if (dirty && !(await formRef.current?.save())) return;
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

  // Reissue an accepted quote, like an invoice with its Storno: this quote
  // is declined and a draft copy replaces it.
  const handleReissue = async () => {
    const reason = await prompt({
      title: t('quotes.reissue', 'Reissue'),
      message: t('quotes.reissuePrompt', 'Reissue this quote? It is declined (the customer\'s link stops working) and copied as a new draft that refers to it as "Replaces …". Optionally note why (leave blank to skip).'),
      label: t('quotes.reissueReason', 'Reason'),
      multiline: true,
      optional: true,
      confirmLabel: t('quotes.reissue', 'Reissue'),
    });
    // null on Cancel; '' (empty) means "no reason".
    if (reason === null) return;
    try {
      const result = await quotesService.reissue(q.id, reason.trim() || undefined);
      toast.success(t('quotes.reissuedToast', 'Quote reissued — opening the new draft.'));
      qc.invalidateQueries({ queryKey: ['quotes'] });
      navigate(`/admin/clients/quotes/${result.quoteId}`);
    } catch (err: unknown) {
      toast.error(quoteErrorText(err, t, 'Failed'));
    }
  };

  // Save this quote's lines, texts and defaults as a new draft template (#1451).
  const handleSaveAsTemplate = async () => {
    const name = await prompt({
      title: t('quotes.templates.saveAsTemplate', 'Save as template'),
      label: t('quotes.templates.saveAsPrompt', 'Name for the new template'),
      defaultValue: q.eventName || q.quoteNumber,
      confirmLabel: t('quotes.templates.saveAsTemplate', 'Save as template'),
    });
    if (!name) return;
    try {
      const { template } = await quoteCatalogService.saveQuoteAsTemplate(q.id, name);
      toast.success(t('quotes.templates.savedFromQuoteToast', 'Template created as a draft.'));
      navigate(`/admin/clients/quotes/catalog/templates/${template.id}`);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Save as template failed');
    }
  };

  const responseLocked = q.responseLockedAt && new Date(q.responseLockedAt).getTime() < Date.now();
  // A reissued quote is never sent again: the quote that replaced it is.
  const canSend = ['draft', 'declined', 'expired'].includes(q.status) && !q.replacedByQuoteId;

  const customerName = q.customer.companyName || q.customer.displayName || q.customer.email;
  const menu: ActionMenuItem[] = canManage ? [
    ...(editable && formState.canRecalculate ? [{ key: 'rates', icon: <RefreshCw />, label: t('quotes.recalculateRates', 'Recalculate with current rates'), onSelect: () => { void formRef.current?.recalculateRates(); } }] : []),
    ...(q.status === 'accepted' && flags.bills ? [{ key: 'invoice', icon: <Receipt />, label: t('quotes.convertToInvoice', 'Convert to invoice only'), disabled: converting, onSelect: () => { void handleConvertToInvoice(); } }] : []),
    ...(q.status === 'accepted' && flags.contracts ? [{ key: 'contract', icon: <ScrollText />, label: t('quotes.convertToContract', 'Convert to contract'), disabled: converting, onSelect: () => setConvertOpen(true) }] : []),
    ...(['draft', 'sent', 'expired'].includes(q.status) ? [{ key: 'accept', icon: <CheckCircle2 />, label: t('quotes.acceptOnBehalf', 'Accept on behalf'), onSelect: () => { void handleAcceptOnBehalf(); } }] : []),
    ...((['draft', 'sent', 'expired'].includes(q.status) || canReissue) ? [{ key: 'decline', icon: <XCircle />, label: t('quotes.declineOnBehalf', 'Decline on behalf'), onSelect: () => { void handleDeclineOnBehalf(); } }] : []),
    ...(canReissue ? [{ key: 'reissue', icon: <FilePlus />, label: t('quotes.reissue', 'Reissue'), onSelect: () => { void handleReissue(); } }] : []),
    { key: 'duplicate', icon: <Copy />, label: t('common.duplicate', 'Duplicate'), onSelect: () => { void handleDuplicate(); } },
    { key: 'template', icon: <LayoutTemplate />, label: t('quotes.templates.saveAsTemplate', 'Save as template'), onSelect: () => { void handleSaveAsTemplate(); } },
  ] : [];

  // Why the page is read-only, or what a sent quote means for editing.
  let notice: React.ReactNode = null;
  if (q.replacedByQuoteId && q.replacedByQuoteNumber) {
    notice = (
      <Notice tone="neutral" title={t('quotes.lockedNotice.replacedTitle', 'Replaced by {{number}}', { number: q.replacedByQuoteNumber })}
        action={<Button size="sm" variant="outline" onClick={() => navigate(`/admin/clients/quotes/${q.replacedByQuoteId}`)}>{t('quotes.openReplacement', 'Open {{number}}', { number: q.replacedByQuoteNumber })}</Button>}>
        {t('quotes.lockedNotice.replaced', 'This quote was reissued; the customer works with the new one.')}
      </Notice>
    );
  } else if (q.status === 'accepted' && canReissue) {
    notice = (
      <Notice tone="success" title={t('quotes.lockedNotice.acceptedTitle', 'Accepted{{at}}', { at: q.acceptedAt ? ` · ${fmtDateTime(q.acceptedAt)}` : '' })}
        action={canManage ? <Button size="sm" variant="outline" onClick={() => { void handleReissue(); }}>{t('quotes.reissue', 'Reissue')}</Button> : undefined}>
        {t('quotes.lockedNotice.accepted', 'This quote was already accepted and can\'t be edited. To change it, reissue it: the quote is declined and copied as a new draft. If it no longer applies, decline it.')}
      </Notice>
    );
  } else if (q.status === 'accepted') {
    notice = (
      <Notice tone="success" title={t('quotes.lockedNotice.acceptedTitle', 'Accepted{{at}}', { at: q.acceptedAt ? ` · ${fmtDateTime(q.acceptedAt)}` : '' })}>
        {t('quotes.lockedNotice.acceptedConverted', 'This quote was already accepted, and a contract, event or invoice exists for it. It can\'t be changed any more.')}
      </Notice>
    );
  } else if (q.status === 'declined') {
    notice = (
      <Notice tone="neutral"
        action={canManage ? <Button size="sm" variant="outline" onClick={() => { void handleDuplicate(); }}>{t('common.duplicate', 'Duplicate')}</Button> : undefined}>
        {t('quotes.lockedNotice.declined', 'This quote was declined and can\'t be edited. Duplicate it to start a new quote.')}
      </Notice>
    );
  } else if (q.status === 'converted') {
    notice = (
      <Notice tone="neutral">
        {t('quotes.lockedNotice.converted', 'This quote was already converted into an event or invoice and can\'t be changed any more.')}
      </Notice>
    );
  } else if (editable && q.status !== 'draft' && q.sentAt) {
    notice = (
      <Notice tone="info" title={t('quotes.sentNoticeTitle', 'Sent {{at}}', { at: fmtDateTime(q.sentAt) })}>
        {t('quotes.sentNotice', 'You can still change it. The customer sees changes after you send it again.')}
      </Notice>
    );
  }

  return (
    <div>
      <DocumentHeader
        title={q.quoteNumber}
        status={<Badge tone={STATUS_TONE[q.status] ?? 'neutral'}>{t(`quotes.status.${q.status}`, q.status)}</Badge>}
        meta={(
          <>
            <span>{t('quotes.forCustomer', 'for {{name}}', { name: customerName })}</span>
            {q.eventName && <span>· {q.eventName}</span>}
          </>
        )}
        actions={(
          <>
            <ActionMenu items={menu} />
            <Button variant="outline" onClick={() => { void handlePreview(); }} leftIcon={<Eye className="w-4 h-4" />}>
              {t('quotes.preview', 'Preview PDF')}
            </Button>
            {canManage && canSend && (
              <Button onClick={() => { void handleSend(); }} disabled={formState.busy || (dirty && !formState.valid)} leftIcon={<Send className="w-4 h-4" />}>
                {q.status === 'draft' ? t('quotes.send', 'Send') : t('quotes.resend', 'Resend')}
              </Button>
            )}
            {canManage && q.status === 'accepted' && (
              <Button onClick={() => { void handleConvert(); }} leftIcon={<ArrowRightCircle className="w-4 h-4" />}>
                {t('quotes.convert', 'Convert to event')}
              </Button>
            )}
          </>
        )}
      />
      {notice && <div className="mb-4">{notice}</div>}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-6 items-start">
        <div className="space-y-4 min-w-0">
          {editable ? (
            <QuoteForm ref={formRef} quoteId={q.id} onStateChange={onFormState} />
          ) : (
            <>
            <Card>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div><div className="text-body">{t('quotes.field.issueDate', 'Issued')}</div><div>{fmtDate(q.issueDate)}</div></div>
                {q.validUntil && <div><div className="text-body">{t('quotes.field.validUntil', 'Valid until')}</div><div>{fmtDate(q.validUntil)}</div></div>}
                <div><div className="text-body">{t('quotes.field.eventName', 'Event')}</div><div>{q.eventName || '—'}</div></div>
                {q.eventDate && <div><div className="text-body">{t('quotes.field.eventDate', 'Event date')}</div><div>{fmtDate(q.eventDate)}{q.eventTimeStart ? ` ${fmtTime(q.eventTimeStart)}-${q.eventTimeEnd ? fmtTime(q.eventTimeEnd) : ''}` : ''}</div></div>}
                {q.sentAt && <div><div className="text-body">{t('quotes.field.sentAt', 'Sent at')}</div><div>{fmtDateTime(q.sentAt)}</div></div>}
                {q.acceptedAt && <div><div className="text-body">{t('quotes.field.acceptedAt', 'Accepted at')}</div><div>{fmtDateTime(q.acceptedAt)}</div></div>}
                {q.declinedAt && <div><div className="text-body">{t('quotes.field.declinedAt', 'Declined at')}</div><div>{fmtDateTime(q.declinedAt)}</div></div>}
                {q.replacesQuoteId && q.replacesQuoteNumber && (
                  <div><div className="text-body">{t('quotes.replacesQuote', 'Replaces')}</div>
                    <button type="button" className="text-accent hover:underline"
                      onClick={() => navigate(`/admin/clients/quotes/${q.replacesQuoteId}`)}>{q.replacesQuoteNumber}</button></div>
                )}
                {q.replacedByQuoteId && q.replacedByQuoteNumber && (
                  <div><div className="text-body">{t('quotes.replacedByQuote', 'Replaced by')}</div>
                    <button type="button" className="text-accent hover:underline"
                      onClick={() => navigate(`/admin/clients/quotes/${q.replacedByQuoteId}`)}>{q.replacedByQuoteNumber}</button></div>
                )}
                {q.declineReason && <div className="col-span-2 md:col-span-4"><div className="text-body">{t('quotes.field.declineReason', 'Decline reason')}</div><div className="whitespace-pre-line">{q.declineReason}</div></div>}
                {q.respondedAt && !responseLocked && (
                  <div><div className="text-body">{t('quotes.field.responseWindow', 'Response window')}</div>
                    <div className="text-warning-text">{t('quotes.responseWindowOpen', 'Open until {{at}}', { at: q.responseLockedAt ? fmtDateTime(q.responseLockedAt) : '' })}</div></div>
                )}
              </div>
            </Card>
            <QuoteAddOnsCard quote={q} lineItems={data.lineItems} />

            <Card>
              <h3 className="font-semibold mb-3">{t('quotes.section.lineItems', 'Line items')}</h3>
              <table className="w-full text-sm">
                <thead><tr className="border-b border-line">
                  <th className="text-left py-2">#</th>
                  <th className="text-left py-2">{t('crm.lineItems.quantity', 'Qty')}</th>
                  <th className="text-left py-2">{t('crm.lineItems.description', 'Description')}</th>
                  <th className="text-right py-2">{t('crm.lineItems.unitPrice', 'Unit')}</th>
                  <th className="text-right py-2">{t('crm.lineItems.total', 'Total')}</th>
                </tr></thead>
                <tbody>
                  {(() => {
                    // Top-level lines are numbered 1, 2, 3…; sub-items indent under
                    // their parent; discount lines carry no number or unit price;
                    // an unticked optional add-on is shown but greyed out (#1451).
                    let number = 0;
                    return data.lineItems.map((li) => {
                      const isSubItem = li.parentPosition != null;
                      const isDiscountLine = li.lineKind === 'discount';
                      const notIncluded = !!li.isOptional && li.selected === false;
                      if (!isSubItem) number += 1;
                      const unitLabel = li.unit ? t(`crm.lineItems.unitShort.${li.unit}`, li.unit) : '';
                      return (
                        <tr key={li.id} className={`border-b border-line-faint ${notIncluded ? 'opacity-60' : ''}`}>
                          <td className="py-2">{isSubItem ? '' : number}</td>
                          <td className="py-2">{isDiscountLine ? '' : `${Number(li.quantity)}${unitLabel ? ` ${unitLabel}` : ''}`}</td>
                          <td className={`py-2 whitespace-pre-line ${isSubItem ? 'pl-6' : ''}`}>
                            {isSubItem ? '• ' : ''}{li.description}
                            {/* An add-on's status is the last line of its item. */}
                            {li.isOptional && (
                              <div className="text-xs text-muted">
                                {notIncluded
                                  ? t('crm.lineItems.optionalNotIncluded', '(add-on, not booked)')
                                  : t('crm.lineItems.optionalIncluded', '(add-on, booked)')}
                              </div>
                            )}
                          </td>
                          <td className="py-2 text-right tabular-nums">{isDiscountLine ? '' : formatMoneyMinor(Number(li.unitPriceMinor || 0), q.currency)}</td>
                          <td className="py-2 text-right tabular-nums">{formatMoneyMinor(Number(li.lineTotalMinor || 0), q.currency)}</td>
                        </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
              <div className="flex flex-col items-end gap-1 mt-4 text-sm">
                <div className="flex gap-6"><span className="text-soft">{t('crm.lineItems.subtotal', 'Subtotal')}:</span>
                  <span className="tabular-nums w-28 text-right">{formatMoney(Number(q.netAmountMinor || 0) / 100, q.currency)}</span></div>
                <div className="flex gap-6"><span className="text-soft">{t('crm.lineItems.vat', 'VAT')} ({Number(q.vatRate || 0).toFixed(1)}%):</span>
                  <span className="tabular-nums w-28 text-right">{formatMoney(Number(q.vatAmountMinor || 0) / 100, q.currency)}</span></div>
                <div className="flex gap-6 font-semibold text-base"><span>{t('crm.lineItems.total', 'Total')}:</span>
                  <span className="tabular-nums w-28 text-right">{formatMoney(Number(q.totalAmountMinor || 0) / 100, q.currency)}</span></div>
              </div>
            </Card>
            </>
          )}
        </div>
        <div className="space-y-4">
          {editable && q.replacesQuoteId && q.replacesQuoteNumber && (
            <Notice tone="neutral" size="sm">
              {t('quotes.replacesQuote', 'Replaces')}{' '}
              <button type="button" className="text-accent hover:underline" onClick={() => navigate(`/admin/clients/quotes/${q.replacesQuoteId}`)}>
                {q.replacesQuoteNumber}
              </button>
            </Notice>
          )}
          {/* What the customer wrote with their acceptance (#1451) — plain text. */}
          {q.customerMessage && (
            <Card>
              <h3 className="font-semibold mb-2 text-heading">
                {t('quotes.section.customerMessage', 'Message from the customer')}
              </h3>
              <p className="text-sm whitespace-pre-wrap break-words text-body">{q.customerMessage}</p>
            </Card>
          )}
          {/* Cross-document lineage via deal_uuid (migration 140): every
              quote / contract / invoice / Storno / reissue of this engagement. */}
          <DocumentLineageCard dealUuid={q.dealUuid} current={{ kind: 'quote', id: q.id }} />
          {!editable && q.internalNotes && (
            <Card>
              <h3 className="font-semibold mb-2 text-heading">{t('quotes.section.internalNotes', 'Internal notes')}</h3>
              <p className="text-sm whitespace-pre-line text-body">{q.internalNotes}</p>
            </Card>
          )}
        </div>
      </div>

      {editable && (
        <SettingsSaveBar
          isDirty={formState.dirty}
          isSaving={formState.busy}
          canSave={formState.valid}
          onSave={() => {
            void formRef.current?.save().then((savedId) => {
              if (savedId) toast.success(q.status === 'draft' ? t('quotes.savedToast', 'Quote saved as draft.') : t('quotes.savedToastSent', 'Quote saved.'));
            });
          }}
          onDiscard={() => formRef.current?.discard()}
        />
      )}
      {convertOpen && (
        <ConvertToContractDialog
          sourceTemplateId={q.sourceTemplateId}
          onClose={() => setConvertOpen(false)}
          onConvert={handleConvertToContract}
          converting={converting}
        />
      )}
      {promptDialog}
    </div>
  );
};
