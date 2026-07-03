/**
 * Invoice editor — create (manual) or edit. Most invoices come from
 * quote conversion; this page is for one-off / ad-hoc invoicing.
 * Smaller surface than the quote editor on purpose.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Eye, Save as SaveIcon } from 'lucide-react';
import { Button, Card, Loading, Input, LocalizedDateInput, TimeField } from '../../../components/common';
import { billsService, type InvoiceCreatePayload, type InvoiceQrFormat } from '../../../services/bills.service';
import { quotesService } from '../../../services/quotes.service';
import { contractsService } from '../../../services/contracts.service';
import { businessProfileService } from '../../../services/businessProfile.service';
import { CustomerPicker } from '../../../components/admin/CustomerPicker';
import { VatRateSelect } from '../../../components/admin/VatRateSelect';
import { accountingService } from '../../../services/accounting.service';
import { vatCodesService } from '../../../services/vatCodes.service';
import { LineItemsTable, type EditableLineItem } from '../../../components/admin/LineItemsTable';
import { InstallmentsPanel } from '../../../components/admin/InstallmentsPanel';
import { customerAdminService } from '../../../services/customerAdmin.service';
import { userManagementService } from '../../../services/userManagement.service';
import { settingsService } from '../../../services/settings.service';
import { useAdminAuth } from '../../../contexts/AdminAuthContext';
import { toast } from 'react-toastify';

function toMinor(amount: number) {
  return Math.round((Number(amount) || 0) * 100);
}

export const BillEditorPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isEdit = id && id !== 'new';

  const [customerId, setCustomerId] = useState<number | null>(null);
  const [customerLabel, setCustomerLabel] = useState('');
  // Tracks whether the selected customer is a passive (admin-only)
  // account so the editor can render the "Passive — admin only"
  // badge next to the label. Driven by the same isPassive boolean
  // the backend exposes on transformInvoice.customer + transformQuote.customer.
  const [customerIsPassive, setCustomerIsPassive] = useState(false);
  // Customer search + inline-create state moved into <CustomerPicker> (C.5).
  const [currency, setCurrency] = useState('CHF');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState('');
  // Due date is normally view-only: it auto-tracks (send date else issue
  // date) + the selected Net-days template, so the payment clock starts
  // on the day the invoice actually goes out. Flipping this lets the
  // admin type a different date by hand; we keep it pinned so the auto
  // effect below stops clobbering their value.
  const [dueDateOverridden, setDueDateOverridden] = useState(false);
  const [scheduledSendAt, setScheduledSendAt] = useState('');
  // null = inherit profile default at render time. 'none' / 'swiss' /
  // 'epc' = explicit per-invoice override. (Existing invoices that
  // already have a value carry it through `setQrFormat` in the load
  // effect; new invoices start as null so they pick up profile.)
  const [qrFormat, setQrFormat] = useState<InvoiceQrFormat | null>(null);
  const [vatRate, setVatRate] = useState(0);
  // Migration 130 — snapshot of the chosen output VAT code (null = custom rate).
  const [vatCode, setVatCode] = useState<string | null>(null);
  const [shipping, setShipping] = useState(0);
  const [ccPdfEmail, setCcPdfEmail] = useState('');
  const [lineItems, setLineItems] = useState<EditableLineItem[]>([]);
  const [paymentTermTemplateId, setPaymentTermTemplateId] = useState<number | null>(null);
  // Migration 124 — split payment-term picker. Net days + Timing are
  // chosen independently; the backend composes the merged snapshot.
  const [paymentNetDaysTemplateId, setPaymentNetDaysTemplateId] = useState<number | null>(null);
  const [paymentTimingTemplateId, setPaymentTimingTemplateId] = useState<number | null>(null);
  // null = use the business-profile default for the chosen currency.
  // A number = explicit per-invoice override pointing at a specific
  // business_bank_accounts row. The backend's
  // resolveBankAccountForCurrency() already prefers this over the
  // currency-default when set, so we just need to surface a picker.
  const [businessBankAccountId, setBusinessBankAccountId] = useState<number | null>(null);
  // Migration 126 — per-invoice Skonto opt-out. Default false so new
  // invoices inherit whatever the template / global default offers.
  const [skontoDisabled, setSkontoDisabled] = useState(false);
  // Ad-hoc installments (commit #6). null = single-invoice mode.
  // Array = the plan; backend spawns N invoices on save when length≥2.
  const [installments, setInstallments] = useState<import('../../../services/quotes.service').PaymentTermInstallment[] | null>(null);
  const [installmentsValid, setInstallmentsValid] = useState(true);
  // Inline event snapshot (migration 123). Mirrors the quote editor's
  // event section — admin can type a free-text label without needing
  // an actual events row, and it carries through to the customer
  // portal + tax report + email templates.
  const [eventId, setEventId] = useState<number | null>(null);
  const [eventName, setEventName] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [eventTimeStart, setEventTimeStart] = useState('');
  const [eventTimeEnd, setEventTimeEnd] = useState('');
  const [busy, setBusy] = useState(false);

  // Load every configured bank account so the override dropdown can
  // offer them all. We filter by currency in the dropdown itself
  // (with an "any currency" fallback in case the admin wants to be
  // explicit about a cross-currency bank).
  const { data: bankAccountsData } = useQuery({
    queryKey: ['business-bank-accounts'],
    queryFn: () => businessProfileService.listBankAccounts(),
  });
  const bankAccounts = bankAccountsData?.bankAccounts || [];

  // Migration 124 split the legacy payment-term template into Net days
  // + Timing. The editor now drives entirely off the two split lists;
  // the legacy `ptTemplates` query was kept around "for back-compat
  // preview text" but never read. Removed (D.1 cleanup).
  const { data: netDaysTemplates } = useQuery({
    queryKey: ['payment-net-days-templates'],
    queryFn: () => quotesService.listPaymentNetDaysTemplates(),
  });
  const { data: timingTemplates } = useQuery({
    queryKey: ['payment-timing-templates'],
    queryFn: () => quotesService.listPaymentTimingTemplates(),
  });

  const { data: existing, isLoading } = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => billsService.get(parseInt(id!, 10)),
    enabled: !!isEdit,
  });

  useEffect(() => {
    if (existing) {
      const inv = existing.invoice;
      setCustomerId(inv.customerAccountId);
      setCustomerLabel(inv.customer.companyName || inv.customer.displayName || inv.customer.email || '');
      setCustomerIsPassive(Boolean(inv.customer.isPassive));
      setCurrency(inv.currency);
      setIssueDate(inv.issueDate);
      setDueDate(inv.dueDate);
      // The invoice already carries a due date — preserve it rather than
      // letting the auto effect recompute and surprise the admin. They
      // can untick "Override" to re-enable auto-tracking.
      setDueDateOverridden(true);
      setScheduledSendAt(inv.scheduledSendAt ? inv.scheduledSendAt.slice(0, 16) : '');
      // Preserve null when the saved invoice has no explicit format —
      // it inherits the profile default at render time.
      setQrFormat((inv.qrFormat as InvoiceQrFormat | null) || null);
      setVatRate(Number(inv.vatRate || 0));
      setVatCode(((inv as { vatCode?: string | null }).vatCode
        ?? (inv as { totals?: { vatCode?: string | null } }).totals?.vatCode) ?? null);
      setShipping(Number(inv.shippingAmountMinor || 0) / 100);
      setCcPdfEmail(inv.ccPdfEmail || '');
      setPaymentTermTemplateId(inv.paymentTermTemplateId ?? null);
      setPaymentNetDaysTemplateId(inv.paymentNetDaysTemplateId ?? null);
      setPaymentTimingTemplateId(inv.paymentTimingTemplateId ?? null);
      setBusinessBankAccountId(inv.businessBankAccountId ?? null);
      setSkontoDisabled(Boolean(inv.skontoDisabled));
      setEventId(inv.eventId ?? null);
      setEventName(inv.eventName || '');
      setEventDate(inv.eventDate || '');
      setEventTimeStart(inv.eventTimeStart || '');
      setEventTimeEnd(inv.eventTimeEnd || '');
      setLineItems(existing.lineItems.map((li) => ({
        id: li.id,
        position: li.position,
        quantity: Number(li.quantity),
        description: li.description,
        unitPrice: Number(li.unitPriceMinor || 0) / 100,
        discountPercent: Number(li.discountPercent || 0),
        parentPosition: li.parentPosition ?? null,
        detailsText: li.detailsText || '',
      })));
    }
  }, [existing]);

  // Admin auth + list — used to pre-fill + offer a dropdown for the
  // "CC PDF to" field (mirrors the QuoteEditorPage pattern + the
  // admin_email picker on CreateEventPage). Falls back to an empty
  // list silently if the current user lacks users.view permission so
  // basic admins still get the auto-prefill from currentAdmin.
  const { user: currentAdmin } = useAdminAuth();
  const { data: adminUsers } = useQuery({
    queryKey: ['admin-users-list'],
    queryFn: async () => {
      try { return await userManagementService.getUsers(); } catch { return []; }
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const activeAdmins = useMemo(
    () => (adminUsers || []).filter((u: any) => u.isActive !== false && !!u.email),
    [adminUsers]
  );

  // Pre-fill CC PDF email with the current admin's email on a brand-
  // new invoice. Skip on edit and don't clobber existing values.
  const didPrefillCcRef = useRef(false);
  useEffect(() => {
    if (isEdit) return;
    if (didPrefillCcRef.current) return;
    if (!currentAdmin?.email) return;
    didPrefillCcRef.current = true;
    setCcPdfEmail((cur) => cur || currentAdmin.email);
  }, [currentAdmin?.email, isEdit]);

  // Seed the VAT from the configured default OUTPUT code (Settings →
  // Accounting) on a brand-new, blank invoice — so new invoices don't silently
  // start at 0%. Skips edits and conversions (quote/contract bring their own
  // VAT), and never clobbers a value the admin already touched.
  const { data: acctSettings } = useQuery({ queryKey: ['accounting-settings'], queryFn: () => accountingService.getSettings() });
  const { data: outputVatCodes } = useQuery({ queryKey: ['vat-codes', 'output'], queryFn: () => vatCodesService.listOutput() });
  const didSeedVatRef = useRef(false);
  useEffect(() => {
    if (isEdit || didSeedVatRef.current) return;
    if (searchParams.get('fromContractId') || searchParams.get('fromQuoteId')) return;
    if (vatCode || vatRate) return;
    const code = acctSettings?.accounting_default_output_vat_code;
    if (!code || !outputVatCodes) return;
    const match = outputVatCodes.find((c) => c.code === code);
    if (match) { didSeedVatRef.current = true; setVatRate(Number(match.rate)); setVatCode(match.code); }
  }, [isEdit, searchParams, acctSettings, outputVatCodes, vatCode, vatRate]);

  // Pre-fill the customer when the editor is opened from a customer
  // detail page via `?customerAccountId=42`. Runs once on mount, only
  // when creating a new invoice, and skips if the user has already
  // picked a customer.
  const didPrefillCustomerRef = useRef(false);
  useEffect(() => {
    if (isEdit) return;
    if (didPrefillCustomerRef.current) return;
    const raw = searchParams.get('customerAccountId');
    const cid = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(cid) || cid <= 0) return;
    didPrefillCustomerRef.current = true;
    (async () => {
      try {
        const c = await customerAdminService.get(cid);
        if (!customerId) {
          setCustomerId(c.id);
          setCustomerLabel(c.companyName || c.displayName || c.email);
          setCustomerIsPassive(Boolean(c.isPassive));
        }
      } catch {
        // Silent fail — admin can still pick the customer manually.
      }
    })();
  }, [isEdit, searchParams, customerId]);

  // Pre-fill the event link + snapshot when opened from an event's
  // "Create invoice" button (/admin/clients/bills/new?eventId=&eventName=&eventDate=).
  const didPrefillEventRef = useRef(false);
  useEffect(() => {
    if (isEdit) return;
    if (didPrefillEventRef.current) return;
    const eidRaw = searchParams.get('eventId');
    const eid = eidRaw ? parseInt(eidRaw, 10) : NaN;
    const en = searchParams.get('eventName');
    const ed = searchParams.get('eventDate');
    if (!(Number.isFinite(eid) && eid > 0) && !en && !ed) return;
    didPrefillEventRef.current = true;
    if (Number.isFinite(eid) && eid > 0) setEventId(eid);
    if (en) setEventName((prev) => prev || en);
    if (ed) setEventDate((prev) => prev || ed);
  }, [isEdit, searchParams]);

  // Pre-fill from a fully-signed contract when the editor is opened
  // via `?fromContractId=<id>` (the "New invoice" link on
  // ContractDetailPage's header, used after the contract has been
  // converted to event / invoices-only and the admin wants to mint
  // an ad-hoc invoice on top of the scheduled ones).
  //
  // Pulls customer + event snapshot from the contract itself, then
  // the line items + currency + VAT from the source quote (contracts
  // don't carry line items themselves — they're composed of free-text
  // blocks). Standalone contracts (no source quote) still pre-fill
  // the customer + event snapshot; the admin types the line items.
  const didPrefillContractRef = useRef(false);
  useEffect(() => {
    if (isEdit) return;
    if (didPrefillContractRef.current) return;
    const raw = searchParams.get('fromContractId');
    const cid = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(cid) || cid <= 0) return;
    didPrefillContractRef.current = true;
    (async () => {
      try {
        const { contract } = await contractsService.get(cid);
        if (!customerId) {
          setCustomerId(contract.customerAccountId);
          setCustomerLabel(
            contract.customer.companyName
              || [contract.customer.firstName, contract.customer.lastName].filter(Boolean).join(' ')
              || contract.customer.displayName
              || contract.customer.email
              || '',
          );
          setCustomerIsPassive(Boolean((contract.customer as any).isPassive));
        }
        // Event snapshot — contracts copy these from the source quote
        // on createFromQuote, then the contract editor can override
        // them. Either way we prefer the contract's own values here.
        if (contract.eventName) setEventName(contract.eventName);
        if (contract.eventDate) setEventDate(contract.eventDate);
        if (contract.eventTimeStart) setEventTimeStart(contract.eventTimeStart);
        if (contract.eventTimeEnd) setEventTimeEnd(contract.eventTimeEnd);

        if (contract.sourceQuoteId) {
          const { quote, lineItems: quoteLineItems } = await quotesService.get(contract.sourceQuoteId);
          if (quote.currency) setCurrency(quote.currency);
          if (quote.vatRate != null) setVatRate(Number(quote.vatRate));
          setVatCode((quote as { vatCode?: string | null }).vatCode ?? null);
          if (quote.shippingAmountMinor != null) {
            setShipping(Number(quote.shippingAmountMinor) / 100);
          }
          // Map the quote's line items into the editor's editable
          // shape. ids drop (this is a brand-new invoice; line items
          // get fresh ids on save) but position + parent linkage are
          // preserved so the hierarchy carries through.
          setLineItems((quoteLineItems || []).map((li: any) => ({
            position: li.position,
            quantity: Number(li.quantity),
            description: li.description,
            unitPrice: Number(li.unitPriceMinor || 0) / 100,
            discountPercent: Number(li.discountPercent || 0),
            parentPosition: li.parentPosition ?? null,
            detailsText: li.detailsText || '',
          })));
        }
      } catch {
        // Silent fail — admin can still author the invoice manually.
      }
    })();
  }, [isEdit, searchParams, customerId]);

  // Customer autocomplete moved into <CustomerPicker> (C.5).

  // Load the admin-configured CRM defaults (migration 125). The
  // editor's prefill prefers these over the hardcoded fallbacks below
  // so the per-invoice picker is a true override.
  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: () => settingsService.getAllSettings(),
    enabled: !isEdit,
  });

  // Auto-default both pickers on a brand-new invoice. Resolution
  // order: configured setting → Net 30 / first-timing fallback → first.
  const didPrefillPaymentRef = useRef(false);
  useEffect(() => {
    if (isEdit) return;
    if (didPrefillPaymentRef.current) return;
    if (!netDaysTemplates?.templates?.length || !timingTemplates?.templates?.length) return;
    if (appSettings === undefined) return;

    const settingNetDaysId = appSettings?.crm_invoices_default_payment_net_days_template_id;
    const settingTimingId  = appSettings?.crm_invoices_default_payment_timing_template_id;
    const settingNetDays = settingNetDaysId
      ? netDaysTemplates.templates.find((t) => t.id === settingNetDaysId)
      : null;
    const settingTiming = settingTimingId
      ? timingTemplates.templates.find((t) => t.id === settingTimingId)
      : null;

    const defaultNetDays = settingNetDays
      || netDaysTemplates.templates.find((t) => t.netDays === 30)
      || netDaysTemplates.templates[0];
    const defaultTiming = settingTiming
      || timingTemplates.templates[0];

    didPrefillPaymentRef.current = true;
    setPaymentNetDaysTemplateId((prev) => prev ?? defaultNetDays.id);
    setPaymentTimingTemplateId((prev) => prev ?? defaultTiming.id);
  }, [isEdit, netDaysTemplates, timingTemplates, appSettings]);

  // Auto-track the due date off (scheduled send date else issue date) +
  // the selected Net-days template, mirroring the backend's
  // computeDueDate. The clock starts the day the invoice goes out, so
  // scheduling a future send pushes the due date out with it. Skipped
  // once the admin overrides the field by hand. Date math is in UTC to
  // match the backend (which parses the YYYY-MM-DD base as UTC midnight).
  useEffect(() => {
    if (dueDateOverridden) return;
    const base = (scheduledSendAt ? scheduledSendAt.slice(0, 10) : issueDate) || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) return;
    const tpl = netDaysTemplates?.templates?.find((t) => t.id === paymentNetDaysTemplateId);
    const netDays = tpl?.netDays != null
      ? Number(tpl.netDays)
      : Number(appSettings?.crm_payment_default_net_days) || 30;
    const d = new Date(`${base}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + netDays);
    setDueDate(d.toISOString().slice(0, 10));
  }, [dueDateOverridden, scheduledSendAt, issueDate, paymentNetDaysTemplateId, netDaysTemplates, appSettings]);

  const buildPayload = (): InvoiceCreatePayload => ({
    customerAccountId: customerId || 0,
    currency,
    issueDate,
    dueDate: dueDate || undefined,
    scheduledSendAt: scheduledSendAt || undefined,
    // Omit when null so the server inherits the profile default;
    // including null would persist as an explicit "no preference"
    // which is the same outcome but pollutes the column.
    qrFormat: qrFormat || undefined,
    vatRate,
    vatCode,
    shippingAmountMinor: toMinor(shipping),
    ccPdfEmail: ccPdfEmail || undefined,
    // Payment-term template id (migration 113). null = no template
    // selected; backend falls back to source-quote snapshot or the
    // global crm_invoices_* defaults.
    paymentTermTemplateId: paymentTermTemplateId ?? undefined,
    // Migration 124 — split picker. Backend engages the new path only
    // when both are present; legacy single-FK is still accepted.
    paymentNetDaysTemplateId: paymentNetDaysTemplateId ?? undefined,
    paymentTimingTemplateId: paymentTimingTemplateId ?? undefined,
    // Per-invoice bank-account override. Sending `null` explicitly
    // (instead of stripping the key with `?? undefined`) ensures the
    // PUT handler can detect "clear this override" — JSON serialises
    // undefined out of the body, so an omitted key would otherwise
    // leave the previously-pinned bank in place. A number pins the
    // chosen account; the renderer reads it from
    // invoices.business_bank_account_id at PDF time, no further
    // lookup needed.
    businessBankAccountId: businessBankAccountId,
    // Per-invoice Skonto opt-out (migration 126). Always send so the
    // PUT handler can clear a previously-set opt-out by unchecking.
    skontoDisabled,
    // Ad-hoc installments (commit #6). When set with ≥2 rows backend
    // spawns N invoices via spawnInstallmentInvoices and returns
    // { invoiceIds: [...] }; single-row or null → single invoice.
    installments: installments || undefined,
    // Inline event snapshot (migration 123). Empty string → undefined
    // so the backend can distinguish "not provided" from a deliberate
    // clear (which the route's `optional({ values: 'falsy' })` already
    // treats identically — falsy values bypass validation entirely).
    eventId: eventId ?? undefined,
    eventName: eventName || undefined,
    eventDate: eventDate || undefined,
    eventTimeStart: eventTimeStart || undefined,
    eventTimeEnd: eventTimeEnd || undefined,
    lineItems: lineItems.map((li) => ({
      position: li.position,
      quantity: li.quantity,
      description: li.description,
      unitPriceMinor: toMinor(li.unitPrice),
      discountPercent: li.discountPercent,
      // Migration 119 — sub-items + details survive save → reload.
      parentPosition: li.parentPosition ?? null,
      detailsText: li.detailsText || null,
    })),
  });

  const handleSave = async (then?: 'preview') => {
    if (!customerId) { toast.error(t('bills.errors.customerRequired', 'Pick a customer first.')); return; }
    // Open the preview tab synchronously so popup blockers don't kill
    // it (they reject any window.open that runs after an `await`).
    const previewWindow = then === 'preview' ? window.open('about:blank', '_blank') : null;
    if (then === 'preview' && !previewWindow) {
      toast.error(t('bills.errors.popupBlocked', 'Allow pop-ups for this site to preview the PDF.'));
      return;
    }
    setBusy(true);
    try {
      const payload = buildPayload();
      const saved = isEdit
        ? await billsService.update(parseInt(id!, 10), payload)
        : await billsService.create(payload);
      qc.invalidateQueries({ queryKey: ['invoices'] });
      if (then === 'preview') {
        const url = await billsService.pdfUrl(saved.invoice.id);
        if (previewWindow) previewWindow.location.href = url;
      } else if (saved.invoiceIds && saved.invoiceIds.length > 1) {
        // Multi-installment spawn: backend created N invoices. Toast
        // the count and redirect to the first sibling.
        toast.success(t('bills.savedToastMulti',
          'Created {{n}} invoices.', { n: saved.invoiceIds.length }));
      } else {
        toast.success(t('bills.savedToast', 'Invoice saved.'));
      }
      // Redirect to the first invoice (single case = the only invoice;
      // multi case = first installment, admin navigates to siblings
      // via the lineage card).
      navigate(`/admin/clients/bills/${saved.invoice.id}`);
    } catch (err: any) {
      if (previewWindow) previewWindow.close();
      toast.error(err?.response?.data?.error || err.message || 'Save failed');
    } finally { setBusy(false); }
  };

  const handlePreviewUnsaved = async () => {
    if (!customerId) { toast.error(t('bills.errors.customerRequired', 'Pick a customer first.')); return; }
    const previewWindow = window.open('about:blank', '_blank');
    if (!previewWindow) {
      toast.error(t('bills.errors.popupBlocked', 'Allow pop-ups for this site to preview the PDF.'));
      return;
    }
    try {
      const url = await billsService.previewPdfUrl(buildPayload());
      previewWindow.location.href = url;
    } catch (err: any) {
      previewWindow.close();
      toast.error(err?.response?.data?.error || 'Preview failed');
    }
  };

  if (isEdit && isLoading) return <Loading />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <button onClick={() => navigate('/admin/clients/bills')}
            className="text-sm text-neutral-600 dark:text-neutral-400 hover:underline mb-1 inline-flex items-center gap-1">
            <ArrowLeft className="w-4 h-4" /> {t('common.back', 'Back')}
          </button>
          <h2 className="text-xl font-bold">{isEdit ? `${t('bills.edit', 'Edit invoice')} ${existing?.invoice.invoiceNumber || ''}` : t('bills.new', 'New invoice')}</h2>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handlePreviewUnsaved} disabled={busy}>
            <Eye className="w-4 h-4 mr-1" />{t('common.preview', 'Preview')}
          </Button>
          <Button onClick={() => handleSave()} disabled={busy || !installmentsValid}>
            <SaveIcon className="w-4 h-4 mr-1" />
            {installments && installments.length > 1
              ? t('bills.saveAndSpawn', 'Create {{n}} invoices', { n: installments.length })
              : t('common.save', 'Save')}
          </Button>
        </div>
      </div>

      <Card>
        <h3 className="font-semibold mb-2">{t('bills.section.customer', 'Customer')}</h3>
        <CustomerPicker
          value={customerId}
          label={customerLabel}
          isPassive={customerIsPassive}
          onSelect={(c) => {
            setCustomerId(c.id);
            setCustomerLabel(c.companyName || c.displayName || c.email);
            setCustomerIsPassive(Boolean(c.isPassive));
          }}
          onCreate={(c) => {
            setCustomerId(c.id);
            setCustomerLabel(c.companyName || c.displayName || c.email);
            setCustomerIsPassive(Boolean(c.isPassive));
          }}
          onClear={() => {
            setCustomerId(null);
            setCustomerLabel('');
            setCustomerIsPassive(false);
          }}
          searchPlaceholder={t('bills.customerSearch', 'Search by email or company…') as string}
        />
      </Card>

      {/* Event snapshot section (migration 123). Mirrors the quote
          editor's Event section — free-text label that doesn't require
          a linked events row. The values flow into the invoice email
          template's {{event_name}} placeholder, the customer portal
          row heading, the admin list "Event" column, and the tax
          report event column. */}
      <Card>
        <h3 className="font-semibold mb-2">{t('bills.section.event', 'Event details')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input label={t('bills.field.eventName', 'Event') as string}
            value={eventName} onChange={(e) => setEventName(e.target.value)} />
          <LocalizedDateInput label={t('bills.field.eventDate', 'Event date') as string}
            value={eventDate} onChange={setEventDate} />
          <TimeField label={t('bills.field.eventTimeStart', 'Start time') as string}
            value={eventTimeStart} onChange={setEventTimeStart} />
          <TimeField label={t('bills.field.eventTimeEnd', 'End time') as string}
            value={eventTimeEnd} onChange={setEventTimeEnd} />
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold mb-2">{t('bills.section.details', 'Details')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <LocalizedDateInput label={t('bills.field.issueDate', 'Issue date') as string} value={issueDate} onChange={setIssueDate} />
          <div>
            <LocalizedDateInput
              label={t('bills.field.dueDate', 'Due date') as string}
              value={dueDate}
              onChange={setDueDate}
              disabled={!dueDateOverridden}
            />
            <label className="mt-1.5 flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
              <input
                type="checkbox"
                checked={dueDateOverridden}
                onChange={(e) => setDueDateOverridden(e.target.checked)}
                className="rounded border-neutral-300 dark:border-neutral-600"
              />
              {dueDateOverridden
                ? t('bills.field.dueDateOverrideOn', 'Manual due date — untick to auto-set from send date + payment term')
                : t('bills.field.dueDateOverrideOff', 'Auto from send date + payment term — tick to set manually')}
            </label>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">{t('bills.field.scheduledSendAt', 'Scheduled send (optional)')}</label>
            {/* Localized date + time (honours general_date_format +
                general_time_format) instead of a native datetime-local, which
                renders in the browser locale (US date + 12h). Recombined into
                the "YYYY-MM-DDTHH:MM" the payload + scheduler expect. */}
            <div className="grid grid-cols-2 gap-3">
              <LocalizedDateInput
                value={scheduledSendAt ? scheduledSendAt.slice(0, 10) : ''}
                onChange={(iso) => {
                  if (!iso) { setScheduledSendAt(''); return; }
                  const time = scheduledSendAt.length >= 16 ? scheduledSendAt.slice(11, 16) : '09:00';
                  setScheduledSendAt(`${iso}T${time}`);
                }}
              />
              <TimeField
                value={scheduledSendAt.length >= 16 ? scheduledSendAt.slice(11, 16) : ''}
                onChange={(hhmm) => {
                  const date = scheduledSendAt ? scheduledSendAt.slice(0, 10) : '';
                  if (!date) return;
                  setScheduledSendAt(`${date}T${hhmm || '09:00'}`);
                }}
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">{t('bills.field.qrFormat', 'Payment QR format')}</label>
            <select
              value={qrFormat || ''}
              onChange={(e) => setQrFormat((e.target.value || null) as any)}
              className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm">
              {/* Empty value = use the business-profile default. Server
                  resolves the actual format at render time, so admins
                  who curate it once in Settings → Business profile
                  never have to think about it per-invoice. */}
              <option value="">{t('bills.qrFormat.profileDefault', 'Use business profile default')}</option>
              <option value="none">{t('bills.qrFormat.none', 'None (override)')}</option>
              <option value="swiss">{t('bills.qrFormat.swiss', 'Swiss QR-bill')}</option>
              <option value="epc">{t('bills.qrFormat.epc', 'EPC QR (SEPA)')}</option>
            </select>
          </div>
          {/* Per-invoice bank-account override (migration 102 column
              business_bank_account_id). Empty value = let the server
              pick the default account for the invoice currency at
              save time. Showing every configured bank lets the admin
              pin one for this invoice without changing the global
              defaults in Settings → Business profile. */}
          <div className="md:col-span-2">
            <label className="block text-sm font-medium mb-1">
              {t('bills.field.businessBankAccount', 'Payment account')}
            </label>
            <select
              value={businessBankAccountId == null ? '' : String(businessBankAccountId)}
              onChange={(e) => setBusinessBankAccountId(e.target.value ? Number(e.target.value) : null)}
              className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm">
              <option value="">
                {t('bills.field.bankAccountProfileDefault',
                  'Use business profile default for {{currency}}', { currency })}
              </option>
              {bankAccounts.map((b) => {
                const labelParts = [
                  b.label || b.accountHolder || b.iban,
                  b.currency,
                  b.isDefault ? t('bills.field.bankAccountDefaultBadge', '(default)') : null,
                ].filter(Boolean);
                return (
                  <option key={b.id} value={b.id}>
                    {labelParts.join(' · ')} — {b.iban}
                  </option>
                );
              })}
            </select>
            <p className="text-xs text-neutral-500 mt-1">
              {t('bills.field.bankAccountHelp',
                'Overrides the profile default for this invoice only. Leave on default to inherit the currency-matched account from Settings → Business profile.')}
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold mb-2">{t('bills.section.lineItems', 'Line items')}</h3>
        <LineItemsTable items={lineItems} currency={currency} showDiscount={false}
          vatRate={vatRate / 100} shippingAmount={shipping}
          roundTotal={appSettings?.crm_invoice_round_total === true} onChange={setLineItems} />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
          <VatRateSelect
            label={t('bills.field.vatRate', 'VAT rate %') as string}
            rate={vatRate}
            code={vatCode}
            onChange={(rate, code) => { setVatRate(rate); setVatCode(code); }} />
          <Input type="number" step="0.01" label={t('bills.field.shipping', 'Shipping') as string}
            value={shipping} onChange={(e) => setShipping(Number(e.target.value))} />
          <div>
            <label className="block text-sm font-medium mb-1">{t('bills.field.currency', 'Currency')}</label>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm">
              <option>CHF</option><option>EUR</option><option>USD</option><option>GBP</option>
            </select>
          </div>
        </div>
      </Card>

      {/* Payment conditions — picks net-days + Skonto from the shared
          payment-term templates (same dropdown the quote editor uses).
          Optional: leave at "— Select —" to let the renderer fall back
          to the source quote's snapshot, or to the global
          crm_invoices_* defaults for ad-hoc invoices. */}
      {/* Migration 124 — split payment-term picker. Two side-by-side
          dropdowns replace the legacy single one. The `ptTemplates`
          query is still mounted above so legacy invoices whose state
          only has the single FK still resolve their preview text. */}
      <Card>
        <h3 className="font-semibold mb-2">{t('bills.section.payment', 'Payment conditions')}</h3>
        <Link to="/admin/settings?tab=crm"
          className="text-xs text-accent hover:underline mb-2 inline-block">
          {t('common.configureInSettings', 'Configure defaults in Settings ↗')}
        </Link>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium mb-1">{t('bills.field.paymentNetDays', 'Net days')}</label>
            <select
              className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
              value={paymentNetDaysTemplateId || ''}
              onChange={(e) => setPaymentNetDaysTemplateId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">{t('bills.field.selectNetDays', '— Select net days —')}</option>
              {netDaysTemplates?.templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">{t('bills.field.paymentTiming', 'Payment schedule')}</label>
            <select
              className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
              value={paymentTimingTemplateId || ''}
              onChange={(e) => setPaymentTimingTemplateId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">{t('bills.field.selectTiming', '— Select schedule —')}</option>
              {timingTemplates?.templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
              ))}
            </select>
          </div>
        </div>
        {/* Per-invoice Skonto opt-out (migration 126). Surfaced
            alongside the payment-term pickers because it's a peer
            override of the same CRM defaults. Admin ticks this for
            invoices that shouldn't qualify even when the global
            default offers Skonto (e.g. Storni, instalments, retainers). */}
        <label className="flex items-start gap-2 text-sm mt-3 cursor-pointer">
          <input
            type="checkbox"
            className="mt-1"
            checked={skontoDisabled}
            onChange={(e) => setSkontoDisabled(e.target.checked)}
          />
          <span>
            {t('bills.field.skontoDisabled',
              'Disable Skonto for this invoice (suppresses the early-payment-discount block on the PDF and the "Paid with Skonto" buttons in the admin email / record-payment dialog).')}
          </span>
        </label>
        <p className="text-xs text-neutral-500 mt-2">
          {t('bills.field.paymentTermHelp',
            'Net days + Skonto for this invoice. Leave blank to inherit from the source quote or the global CRM defaults.')}
        </p>

        {/* Ad-hoc installments panel (commit #6). When the admin builds
            a multi-row plan and clicks Save, the backend spawns one
            invoice per row via spawnInstallmentInvoices (commit #4)
            and returns the array of new ids. */}
        <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
          <InstallmentsPanel
            value={installments}
            onChange={setInstallments}
            onValidityChange={setInstallmentsValid}
            eventDate={eventDate || null}
          />
        </div>
      </Card>

      <Card>
        {/* CC PDF — admin email prefilled, with a picker when more than
            one admin exists. Mirrors the quote editor + CreateEventPage
            so the muscle memory carries over. */}
        <div className="space-y-1">
          <Input type="email"
            label={t('bills.field.ccPdfEmail', 'CC PDF to (extra recipient)') as string}
            placeholder={t('bills.field.ccPdfEmailPlaceholder', 'name@example.com') as string}
            value={ccPdfEmail} onChange={(e) => setCcPdfEmail(e.target.value)} />
          {activeAdmins.length > 1 && (
            <div className="flex items-center gap-2">
              <label htmlFor="bill-cc-pdf-picker" className="text-xs text-neutral-600 dark:text-neutral-400 whitespace-nowrap">
                {t('bills.field.ccPdfPickFromAdmins', 'Pick from admins:')}
              </label>
              <select
                id="bill-cc-pdf-picker"
                value={activeAdmins.some((a: any) => a.email === ccPdfEmail) ? ccPdfEmail : ''}
                onChange={(e) => {
                  const email = e.target.value;
                  if (email) setCcPdfEmail(email);
                }}
                className="text-xs px-2 py-1 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
              >
                <option value="">{t('bills.field.ccPdfCustom', 'Custom email')}</option>
                {activeAdmins.map((a: any) => (
                  <option key={a.id} value={a.email}>{a.email}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};
