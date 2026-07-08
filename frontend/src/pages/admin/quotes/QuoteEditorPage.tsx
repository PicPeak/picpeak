/**
 * Quote editor — create or edit. Five sections:
 *  1. Customer
 *  2. Event data
 *  3. Line items (LineItemsTable)
 *  4. Payment conditions
 *  5. Intro/outro + CC PDF email + internal notes
 *
 * Send is a deliberate two-step action (confirm dialog) since it emails
 * the customer. Preview PDF is available before save (POST /preview)
 * and after save (GET /:id/pdf) for the "what does my customer see?"
 * check.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Eye, Send } from 'lucide-react';
import { Button, Card, Loading, Input, LocalizedDateInput, TimeField } from '../../../components/common';
import {
  quotesService,
  type QuoteCreatePayload,
  type PaymentTermInstallment,
} from '../../../services/quotes.service';
import { LineItemsTable, type EditableLineItem } from '../../../components/admin/LineItemsTable';
import { CustomerPicker } from '../../../components/admin/CustomerPicker';
import { ProjectSelect } from '../../../components/admin/ProjectSelect';
import { VatRateSelect } from '../../../components/admin/VatRateSelect';
import { accountingService } from '../../../services/accounting.service';
import { vatCodesService } from '../../../services/vatCodes.service';
import { eventTypesService } from '../../../services/eventTypes.service';
import { workflowsService } from '../../../services/workflows.service';
import { useFeatureFlags } from '../../../contexts/FeatureFlagsContext';
import { InstallmentsPanel } from '../../../components/admin/InstallmentsPanel';
import { customerAdminService } from '../../../services/customerAdmin.service';
import { userManagementService } from '../../../services/userManagement.service';
import { settingsService } from '../../../services/settings.service';
import { useAdminAuth } from '../../../contexts/AdminAuthContext';
import { toast } from 'react-toastify';

interface FormState {
  customerAccountId: number | null;
  customerLabel: string;
  /** Mirrors the customer.isPassive flag from the API. Drives the
   *  "Passive — admin only" badge next to the customer label. */
  customerIsPassive: boolean;
  language: string;
  currency: string;
  issueDate: string;
  validUntil: string;
  eventName: string;
  eventDate: string;
  eventType: string;
  bookingWorkflowId: number | null;
  eventTimeStart: string;
  eventTimeEnd: string;
  expectedDurationHours: string;
  paymentTermTemplateId: number | null;
  // Migration 124 — split payment-term picker. Both required when
  // saving a new quote; legacy quotes may have these null but their
  // status='sent' editor is locked anyway.
  paymentNetDaysTemplateId: number | null;
  paymentTimingTemplateId: number | null;
  vatRate: number;
  /** Migration 130 — snapshot of the chosen output VAT code (null = custom rate). */
  vatCode: string | null;
  shippingAmount: number;
  introText: string;
  outroText: string;
  internalNotes: string;
  ccPdfEmail: string;
  businessBankAccountId: number | null;
  /** Migration 121 — optional Project Overview link. */
  projectId: number | null;
  lineItems: EditableLineItem[];
  // Ad-hoc installments (commit #6). null = use the payment-timing
  // template's installments; array = explicit per-quote override.
  installments?: import('../../../services/quotes.service').PaymentTermInstallment[] | null;
}

const empty: FormState = {
  customerAccountId: null,
  customerLabel: '',
  customerIsPassive: false,
  language: 'de',
  currency: 'CHF',
  issueDate: new Date().toISOString().slice(0, 10),
  validUntil: '',
  eventName: '',
  eventDate: '',
  eventType: '',
  bookingWorkflowId: null,
  eventTimeStart: '',
  eventTimeEnd: '',
  expectedDurationHours: '',
  paymentTermTemplateId: null,
  paymentNetDaysTemplateId: null,
  paymentTimingTemplateId: null,
  vatRate: 0,
  vatCode: null,
  shippingAmount: 0,
  introText: '',
  outroText: '',
  internalNotes: '',
  ccPdfEmail: '',
  businessBankAccountId: null,
  projectId: null,
  lineItems: [],
  installments: null,
};

function toMinor(amount: number) {
  return Math.round((Number(amount) || 0) * 100);
}

function buildPayload(f: FormState): QuoteCreatePayload {
  return {
    customerAccountId: f.customerAccountId || 0,
    language: f.language,
    currency: f.currency,
    issueDate: f.issueDate,
    validUntil: f.validUntil || undefined,
    eventName: f.eventName || undefined,
    eventDate: f.eventDate || undefined,
    eventType: f.eventType || null,
    bookingWorkflowId: f.bookingWorkflowId,
    eventTimeStart: f.eventTimeStart || undefined,
    eventTimeEnd: f.eventTimeEnd || undefined,
    expectedDurationHours: f.expectedDurationHours ? Number(f.expectedDurationHours) : undefined,
    paymentTermTemplateId: f.paymentTermTemplateId || undefined,
    // Migration 124 — split picker. Send both; backend ignores either
    // half unless both are set (legacy single FK still works).
    paymentNetDaysTemplateId: f.paymentNetDaysTemplateId || undefined,
    paymentTimingTemplateId: f.paymentTimingTemplateId || undefined,
    // Ad-hoc installments (commit #6) — overrides the template's
    // installments on the snapshot. Sent only when populated.
    installments: f.installments && f.installments.length > 0 ? f.installments : undefined,
    vatRate: f.vatRate,
    vatCode: f.vatCode,
    shippingAmountMinor: toMinor(f.shippingAmount),
    introText: f.introText || undefined,
    outroText: f.outroText || undefined,
    internalNotes: f.internalNotes || undefined,
    ccPdfEmail: f.ccPdfEmail || undefined,
    businessBankAccountId: f.businessBankAccountId || undefined,
    // Migration 121 — Project Overview link. Send null to clear.
    projectId: f.projectId ?? null,
    lineItems: f.lineItems.map((li) => ({
      position: li.position,
      quantity: li.quantity,
      description: li.description,
      unitPriceMinor: toMinor(li.unitPrice),
      discountPercent: li.discountPercent,
      // Migration 119 — sub-items + details. Pass through to backend
      // so the hierarchy survives save → reload.
      parentPosition: li.parentPosition ?? null,
      detailsText: li.detailsText || null,
    })),
  };
}

export const QuoteEditorPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isEdit = id && id !== 'new';

  const [form, setForm] = useState<FormState>(empty);
  const [installmentsValid, setInstallmentsValid] = useState(true);
  const [busy, setBusy] = useState(false);

  // Pre-fill the customer when the editor is opened from a customer
  // detail page via `?customerAccountId=42`. Runs once on mount, only
  // when creating a new quote, and skips if the user has already
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
        setForm((prev) => prev.customerAccountId ? prev : ({
          ...prev,
          customerAccountId: c.id,
          customerLabel: c.companyName || c.displayName || c.email,
          customerIsPassive: Boolean(c.isPassive),
          // Inherit the customer's preferred language for the quote so
          // the email + PDF land in the right locale automatically.
          language: prev.language || c.preferredLanguage || 'de',
        }));
      } catch {
        // Silent fail — admin can still pick the customer manually.
      }
    })();
  }, [isEdit, searchParams]);

  // Seed the VAT from the configured default OUTPUT code (Settings →
  // Accounting) on a brand-new, blank quote — so quotes (and the invoices they
  // convert to) don't silently start at 0%. Never clobbers a touched value.
  const { data: acctSettings } = useQuery({ queryKey: ['accounting-settings'], queryFn: () => accountingService.getSettings() });
  const { data: outputVatCodes } = useQuery({ queryKey: ['vat-codes', 'output'], queryFn: () => vatCodesService.listOutput() });
  // Active event types — drives the event-type dropdown (and the type of the
  // event this quote converts into).
  const { data: eventTypes = [] } = useQuery({ queryKey: ['event-types-active'], queryFn: () => eventTypesService.getActiveEventTypes() });
  // Booking-workflow picker: the flows that run on quote acceptance. Only shown
  // when the workflow engine is live.
  const { flags } = useFeatureFlags();
  const workflowsLive = !!flags.workflows;
  const { data: allWorkflows = [] } = useQuery({
    queryKey: ['workflows'],
    queryFn: () => workflowsService.list(),
    enabled: workflowsLive,
  });
  const bookingWorkflows = useMemo(
    () => allWorkflows.filter((w) => w.trigger_type === 'quote.accepted'),
    [allWorkflows],
  );
  const didSeedVatRef = useRef(false);
  useEffect(() => {
    if (isEdit || didSeedVatRef.current) return;
    const code = acctSettings?.accounting_default_output_vat_code;
    if (!code || !outputVatCodes) return;
    const match = outputVatCodes.find((c) => c.code === code);
    if (!match) return;
    setForm((prev) => (prev.vatCode || prev.vatRate ? prev : { ...prev, vatRate: Number(match.rate), vatCode: match.code }));
    didSeedVatRef.current = true;
  }, [isEdit, acctSettings, outputVatCodes]);

  // Customer search + inline-create state now lives inside
  // <CustomerPicker> (migration C.5 extraction).

  // Load existing quote
  const { data: existing, isLoading } = useQuery({
    queryKey: ['quote', id],
    queryFn: () => quotesService.get(parseInt(id!, 10)),
    enabled: !!isEdit,
  });

  useEffect(() => {
    if (existing) {
      const q = existing.quote;
      setForm({
        customerAccountId: q.customerAccountId,
        customerLabel: q.customer.companyName || q.customer.displayName || q.customer.email || '',
        customerIsPassive: Boolean(q.customer.isPassive),
        language: q.language,
        currency: q.currency,
        issueDate: q.issueDate,
        validUntil: q.validUntil || '',
        eventName: q.eventName || '',
        eventDate: q.eventDate || '',
        eventType: q.eventType || '',
        bookingWorkflowId: q.bookingWorkflowId ?? null,
        eventTimeStart: q.eventTimeStart || '',
        eventTimeEnd: q.eventTimeEnd || '',
        expectedDurationHours: q.expectedDurationHours?.toString() || '',
        paymentTermTemplateId: q.paymentTermTemplateId,
        paymentNetDaysTemplateId: q.paymentNetDaysTemplateId,
        paymentTimingTemplateId: q.paymentTimingTemplateId,
        vatRate: Number(q.vatRate || 0),
        vatCode: (q as { vatCode?: string | null }).vatCode ?? null,
        shippingAmount: Number(q.shippingAmountMinor || 0) / 100,
        introText: q.introText || '',
        outroText: q.outroText || '',
        internalNotes: q.internalNotes || '',
        ccPdfEmail: q.ccPdfEmail || '',
        businessBankAccountId: q.businessBankAccountId,
        projectId: q.projectId ?? null,
        lineItems: existing.lineItems.map((li) => ({
          id: li.id,
          position: li.position,
          quantity: Number(li.quantity),
          description: li.description,
          unitPrice: Number(li.unitPriceMinor || 0) / 100,
          discountPercent: Number(li.discountPercent || 0),
          parentPosition: li.parentPosition ?? null,
          detailsText: li.detailsText || '',
        })),
      });
    }
  }, [existing]);

  // Customer autocomplete moved into <CustomerPicker> (C.5).

  // Payment-term templates + line-item presets. Migration 124 split
  // the legacy single dropdown into Net days + Timing — load both.
  // The legacy ptTemplates query stays so the installment-preview
  // helper still resolves for old quotes whose state only has the
  // legacy FK.
  const { data: ptTemplates } = useQuery({
    queryKey: ['payment-term-templates'],
    queryFn: () => quotesService.listPaymentTermTemplates(),
  });
  const { data: netDaysTemplates } = useQuery({
    queryKey: ['payment-net-days-templates'],
    queryFn: () => quotesService.listPaymentNetDaysTemplates(),
  });
  const { data: timingTemplates } = useQuery({
    queryKey: ['payment-timing-templates'],
    queryFn: () => quotesService.listPaymentTimingTemplates(),
  });
  const { data: liPresets } = useQuery({
    queryKey: ['line-item-presets'],
    queryFn: () => quotesService.listLineItemPresets(),
  });

  // Admin user list — used to pre-fill + offer a dropdown for the
  // "CC PDF to" field, mirroring CreateEventPage's admin_email picker.
  // Falls back to an empty list silently if the current user lacks
  // users.view permission so basic admins still get the auto-prefill
  // from the currently signed-in admin.
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

  // Auto-prefill the CC PDF email with the current admin's email, only
  // on a brand-new quote and only once. Don't clobber edits or existing
  // values from a saved quote.
  const didPrefillCcRef = useRef(false);
  useEffect(() => {
    if (isEdit) return;
    if (didPrefillCcRef.current) return;
    if (!currentAdmin?.email) return;
    didPrefillCcRef.current = true;
    setForm((prev) => (prev.ccPdfEmail ? prev : { ...prev, ccPdfEmail: currentAdmin.email }));
  }, [currentAdmin?.email, isEdit]);

  // Load the CRM defaults (migration 125 seeded; admin-editable on
  // the CRM settings page). The prefill effect below prefers these
  // over hardcoded fallbacks so the per-quote picker becomes a true
  // override of an admin-configurable global default.
  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: () => settingsService.getAllSettings(),
    enabled: !isEdit,
  });

  // Auto-default the two new pickers on a brand-new quote. Resolution
  // order: settings-configured default → "Net 30" + first-timing
  // hardcoded fallback (for fresh installs missing the seed) → first
  // available template.
  const didPrefillPaymentRef = useRef(false);
  useEffect(() => {
    if (isEdit) return;
    if (didPrefillPaymentRef.current) return;
    if (!netDaysTemplates?.templates?.length || !timingTemplates?.templates?.length) return;
    // Wait for settings to load so the admin's configured default
    // wins over the hardcoded fallback. Empty/missing setting → null.
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
    setForm((prev) => ({
      ...prev,
      paymentNetDaysTemplateId: prev.paymentNetDaysTemplateId ?? defaultNetDays.id,
      paymentTimingTemplateId: prev.paymentTimingTemplateId ?? defaultTiming.id,
    }));
  }, [isEdit, netDaysTemplates, timingTemplates, appSettings]);

  const installmentPreview = useMemo<PaymentTermInstallment[]>(() => {
    // Migration 124 — preview now comes from the timing template when
    // the new picker is in use. Fall back to the legacy template for
    // quotes authored before the split so the preview stays useful.
    const timingTpl = timingTemplates?.templates.find((x) => x.id === form.paymentTimingTemplateId);
    if (timingTpl) return timingTpl.installments;
    const tpl = ptTemplates?.templates.find((x) => x.id === form.paymentTermTemplateId);
    return tpl?.installments || [];
  }, [timingTemplates, form.paymentTimingTemplateId, ptTemplates, form.paymentTermTemplateId]);

  const handleSave = async (then?: 'send' | 'preview') => {
    if (!form.customerAccountId) {
      toast.error(t('quotes.errors.customerRequired', 'Pick a customer first.'));
      return;
    }
    // If the user asked to preview, confirm/cancel BEFORE async work so
    // the popup opens directly off the click (browsers block popups
    // that happen after an `await`). We open a blank window now and
    // point it at the blob URL once it's ready.
    const previewWindow = then === 'preview' ? window.open('about:blank', '_blank') : null;
    if (then === 'preview' && !previewWindow) {
      toast.error(t('quotes.errors.popupBlocked', 'Allow pop-ups for this site to preview the PDF.'));
      return;
    }

    setBusy(true);
    try {
      const payload = buildPayload(form);
      const saved = isEdit
        ? await quotesService.update(parseInt(id!, 10), payload)
        : await quotesService.create(payload);
      queryClient.invalidateQueries({ queryKey: ['quotes'] });

      if (then === 'send') {
        if (!window.confirm(t('quotes.confirmSend', 'Send this quote to the customer now?'))) {
          setBusy(false);
          return;
        }
        await quotesService.send(saved.quote.id);
        toast.success(t('quotes.sentToast', 'Quote sent to customer.'));
        navigate(`/admin/clients/quotes/${saved.quote.id}`);
      } else if (then === 'preview') {
        const url = await quotesService.pdfUrl(saved.quote.id);
        if (previewWindow) previewWindow.location.href = url;
        navigate(`/admin/clients/quotes/${saved.quote.id}`);
      } else {
        toast.success(t('quotes.savedToast', 'Quote saved as draft.'));
        navigate(`/admin/clients/quotes/${saved.quote.id}`);
      }
    } catch (err: any) {
      // Close the placeholder window if the save failed so it doesn't
      // sit there showing "about:blank".
      if (previewWindow) previewWindow.close();
      const msg = err?.response?.data?.error || err.message || 'Save failed';
      // Server returns a friendly code for the "customer feature off"
      // case — surface a clearer message so admins know to flip the
      // toggle on the customer detail page.
      if (err?.response?.data?.code === 'CUSTOMER_FEATURE_DISABLED') {
        toast.error(t('quotes.errors.customerFeatureDisabled',
          'This customer has Quotes disabled. Enable "Quotes" on the customer detail page first.'));
      } else if (err?.response?.data?.code === 'PROJECT_CUSTOMER_MISMATCH') {
        toast.error(t('projects.error.customerMismatch',
          'That project belongs to a different customer than this entry.'));
      } else if (err?.response?.data?.code === 'VALIDATION_ERROR' && Array.isArray(err?.response?.data?.details)) {
        // Show the first field that failed validation so the admin
        // knows what to fix instead of just seeing "Validation failed".
        const first = err.response.data.details[0];
        toast.error(`${first.field}: ${first.message}`);
      } else {
        toast.error(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  const handlePreviewUnsaved = async () => {
    if (!form.customerAccountId) {
      toast.error(t('quotes.errors.customerRequired', 'Pick a customer first.'));
      return;
    }
    // Open the placeholder window synchronously to preserve the user
    // gesture, then redirect it to the blob URL once the PDF is ready.
    // Without this the browser pop-up blocker eats the open() because
    // it happens after an `await`.
    const previewWindow = window.open('about:blank', '_blank');
    if (!previewWindow) {
      toast.error(t('quotes.errors.popupBlocked', 'Allow pop-ups for this site to preview the PDF.'));
      return;
    }
    try {
      const url = await quotesService.previewPdfUrl(buildPayload(form));
      previewWindow.location.href = url;
    } catch (err: any) {
      previewWindow.close();
      toast.error(err?.response?.data?.error || err.message || 'Preview failed');
    }
  };

  if (isEdit && isLoading) return <Loading />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <button onClick={() => navigate('/admin/clients/quotes')}
            className="text-sm text-neutral-600 dark:text-neutral-400 hover:underline mb-1 inline-flex items-center gap-1">
            <ArrowLeft className="w-4 h-4" /> {t('common.back', 'Back')}
          </button>
          <h2 className="text-xl font-bold">
            {isEdit ? `${t('quotes.edit', 'Edit quote')} ${existing?.quote.quoteNumber || ''}` : t('quotes.new', 'New quote')}
          </h2>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handlePreviewUnsaved} disabled={busy}>
            <Eye className="w-4 h-4 mr-1" />{t('quotes.preview', 'Preview PDF')}
          </Button>
          <Button variant="outline" onClick={() => handleSave()} disabled={busy || !installmentsValid}>
            {t('common.save', 'Save')}
          </Button>
          <Button onClick={() => handleSave('send')} disabled={busy || !installmentsValid}>
            <Send className="w-4 h-4 mr-1" />{t('quotes.saveAndSend', 'Save & send')}
          </Button>
        </div>
      </div>

      {/* Section: Customer */}
      <Card>
        <h3 className="font-semibold mb-2">1. {t('quotes.section.customer', 'Customer')}</h3>
        <CustomerPicker
          value={form.customerAccountId}
          label={form.customerLabel}
          isPassive={form.customerIsPassive}
          onSelect={(c) => setForm((f) => ({
            ...f,
            customerAccountId: c.id,
            customerLabel: c.companyName || c.displayName || c.email,
            customerIsPassive: Boolean(c.isPassive),
          }))}
          onCreate={(c) => setForm((f) => ({
            ...f,
            customerAccountId: c.id,
            customerLabel: c.companyName || c.displayName || c.email,
            customerIsPassive: Boolean(c.isPassive),
            // Inherit the new customer's language so the quote
            // gets rendered in their locale by default.
            language: f.language || c.preferredLanguage || 'de',
          }))}
          onClear={() => setForm((f) => ({
            ...f, customerAccountId: null, customerLabel: '', customerIsPassive: false,
          }))}
          searchPlaceholder={t('quotes.customerSearch', 'Search customer by email or company…') as string}
        />
        {/* Project link (renders only when the projects feature is on). */}
        <div className="mt-3">
          <ProjectSelect
            label={t('projects.picker.label', 'Project') as string}
            value={form.projectId}
            customerAccountId={form.customerAccountId}
            onChange={(projectId) => setForm((f) => ({ ...f, projectId }))}
          />
        </div>
      </Card>

      {/* Section: Event */}
      <Card>
        <h3 className="font-semibold mb-2">2. {t('quotes.section.event', 'Event details')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Input label={t('quotes.field.eventName', 'Event name') as string} value={form.eventName}
            onChange={(e) => setForm((f) => ({ ...f, eventName: e.target.value }))} />
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('quotes.field.eventType', 'Event type')}
            </label>
            <select
              value={form.eventType}
              onChange={(e) => setForm((f) => ({ ...f, eventType: e.target.value }))}
              className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100"
            >
              <option value="">{t('quotes.field.eventTypeNone', '— Use default —')}</option>
              {eventTypes.map((et) => (
                <option key={et.id} value={et.slug_prefix}>{et.emoji ? `${et.emoji} ` : ''}{et.name}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              {t('quotes.field.eventTypeHint', 'Used for the event created when this quote is accepted.')}
            </p>
          </div>
          {workflowsLive && (
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('quotes.field.bookingWorkflow', 'Booking workflow (on acceptance)')}
              </label>
              <select
                value={form.bookingWorkflowId ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, bookingWorkflowId: e.target.value ? Number(e.target.value) : null }))}
                className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100"
              >
                <option value="">{t('quotes.field.bookingWorkflowNone', '— None —')}</option>
                {bookingWorkflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}{(w.enabled === true || w.enabled === 1) ? '' : ` ${t('quotes.field.bookingWorkflowDisabled', '(disabled)')}`}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                {t('quotes.field.bookingWorkflowHint', 'The flow that runs when the customer accepts. Leave as None to run no booking flow. The flow must be enabled to fire.')}
              </p>
            </div>
          )}
          <LocalizedDateInput label={t('quotes.field.eventDate', 'Event date') as string} value={form.eventDate}
            onChange={(iso) => setForm((f) => ({ ...f, eventDate: iso }))} />
          <TimeField label={t('quotes.field.eventTimeStart', 'Start time') as string} value={form.eventTimeStart}
            onChange={(v) => setForm((f) => ({ ...f, eventTimeStart: v }))} />
          <TimeField label={t('quotes.field.eventTimeEnd', 'End time') as string} value={form.eventTimeEnd}
            onChange={(v) => setForm((f) => ({ ...f, eventTimeEnd: v }))} />
          <Input type="number" step="0.5" label={t('quotes.field.expectedDuration', 'Expected duration (h)') as string}
            value={form.expectedDurationHours}
            onChange={(e) => setForm((f) => ({ ...f, expectedDurationHours: e.target.value }))} />
          <LocalizedDateInput label={t('quotes.field.validUntil', 'Valid until') as string} value={form.validUntil}
            onChange={(iso) => setForm((f) => ({ ...f, validUntil: iso }))} />
        </div>
      </Card>

      {/* Section: Line items */}
      <Card>
        <h3 className="font-semibold mb-2">3. {t('quotes.section.lineItems', 'Line items')}</h3>
        <LineItemsTable
          items={form.lineItems}
          currency={form.currency}
          showDiscount={true}
          vatRate={form.vatRate / 100}
          shippingAmount={form.shippingAmount}
          roundTotal={appSettings?.crm_invoice_round_total === true}
          presets={liPresets?.presets || []}
          onChange={(items) => setForm((f) => ({ ...f, lineItems: items }))}
        />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
          <VatRateSelect
            label={t('quotes.field.vatRate', 'VAT rate %') as string}
            rate={form.vatRate}
            code={form.vatCode}
            onChange={(rate, code) => setForm((f) => ({ ...f, vatRate: rate, vatCode: code }))} />
          <Input type="number" step="0.01" label={t('quotes.field.shipping', 'Shipping amount') as string}
            value={form.shippingAmount}
            onChange={(e) => setForm((f) => ({ ...f, shippingAmount: Number(e.target.value) }))} />
          <div>
            <label className="block text-sm font-medium mb-1">{t('quotes.field.currency', 'Currency')}</label>
            <select value={form.currency} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
              className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm">
              <option>CHF</option><option>EUR</option><option>USD</option><option>GBP</option>
            </select>
          </div>
        </div>
      </Card>

      {/* Section: Payment — migration 124 split picker. Two orthogonal
          dropdowns (Net days × Payment timing) replace the single
          legacy "Payment conditions" dropdown. The installment preview
          below now reads from the timing template. */}
      <Card>
        <h3 className="font-semibold mb-2">4. {t('quotes.section.payment', 'Payment conditions')}</h3>
        <Link to="/admin/settings?tab=crm"
          className="text-xs text-accent hover:underline mb-2 inline-block">
          {t('common.configureInSettings', 'Configure defaults in Settings ↗')}
        </Link>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium mb-1">{t('quotes.field.paymentNetDays', 'Net days')}</label>
            <select
              className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
              value={form.paymentNetDaysTemplateId || ''}
              onChange={(e) => setForm((f) => ({ ...f, paymentNetDaysTemplateId: e.target.value ? Number(e.target.value) : null }))}
            >
              <option value="">{t('quotes.field.selectNetDays', '— Select net days —')}</option>
              {netDaysTemplates?.templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">{t('quotes.field.paymentTiming', 'Payment schedule')}</label>
            <select
              className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
              value={form.paymentTimingTemplateId || ''}
              onChange={(e) => setForm((f) => ({ ...f, paymentTimingTemplateId: e.target.value ? Number(e.target.value) : null }))}
            >
              <option value="">{t('quotes.field.selectTiming', '— Select schedule —')}</option>
              {timingTemplates?.templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
              ))}
            </select>
          </div>
        </div>
        {installmentPreview.length > 0 && (
          <ul className="mt-3 text-sm space-y-1 text-neutral-600 dark:text-neutral-400">
            {installmentPreview.map((inst, i) => (
              <li key={i}>• {inst.percent}% — {inst.label} ({t(`quotes.trigger.${inst.trigger}`, inst.trigger)}{inst.offset_days ? `, ${inst.offset_days}d` : ''})</li>
            ))}
          </ul>
        )}

        {/* Ad-hoc installments panel (commit #6). Overrides the
            timing-template preview above when set. The plan is
            snapshotted onto the quote and spawns N invoices on
            conversion via convertQuoteToInvoices. */}
        <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
          <InstallmentsPanel
            value={form.installments ?? null}
            onChange={(next) => setForm((f) => ({ ...f, installments: next }))}
            onValidityChange={setInstallmentsValid}
            eventDate={form.eventDate || null}
          />
        </div>
      </Card>

      {/* Section: Extras */}
      <Card>
        <h3 className="font-semibold mb-2">5. {t('quotes.section.extras', 'Intro / outro / extras')}</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">{t('quotes.field.introText', 'Intro text')}</label>
            <textarea rows={3} className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
              value={form.introText} onChange={(e) => setForm((f) => ({ ...f, introText: e.target.value }))} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">{t('quotes.field.outroText', 'Outro text')}</label>
            <textarea rows={3} className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
              value={form.outroText} onChange={(e) => setForm((f) => ({ ...f, outroText: e.target.value }))} />
          </div>

          {/* CC PDF — admin email prefilled, with a picker when more
              than one admin exists. Mirrors the admin_email field on
              CreateEventPage so the muscle memory carries over. */}
          <div className="space-y-1">
            <Input
              type="email"
              label={t('quotes.field.ccPdfEmail', 'CC PDF to (extra recipient)') as string}
              placeholder={t('quotes.field.ccPdfEmailPlaceholder', 'name@example.com') as string}
              value={form.ccPdfEmail}
              onChange={(e) => setForm((f) => ({ ...f, ccPdfEmail: e.target.value }))}
            />
            {activeAdmins.length > 1 && (
              <div className="flex items-center gap-2">
                <label htmlFor="cc-pdf-picker" className="text-xs text-neutral-600 dark:text-neutral-400 whitespace-nowrap">
                  {t('quotes.field.ccPdfPickFromAdmins', 'Pick from admins:')}
                </label>
                <select
                  id="cc-pdf-picker"
                  value={activeAdmins.some((a: any) => a.email === form.ccPdfEmail) ? form.ccPdfEmail : ''}
                  onChange={(e) => {
                    const email = e.target.value;
                    if (email) setForm((prev) => ({ ...prev, ccPdfEmail: email }));
                  }}
                  className="text-xs px-2 py-1 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
                >
                  <option value="">{t('quotes.field.ccPdfCustom', 'Custom email')}</option>
                  {activeAdmins.map((a: any) => (
                    <option key={a.id} value={a.email}>{a.email}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">{t('quotes.field.internalNotes', 'Internal notes (not on PDF)')}</label>
            <textarea rows={3} className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
              value={form.internalNotes} onChange={(e) => setForm((f) => ({ ...f, internalNotes: e.target.value }))} />
          </div>
        </div>
      </Card>
    </div>
  );
};
