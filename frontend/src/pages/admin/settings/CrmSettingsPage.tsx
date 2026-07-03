/**
 * Settings → CRM tab.
 *
 * Per-feature toggles that fine-tune the CRM behaviour without turning
 * off the whole `quotes` / `bills` global flag.  Backed by the
 * crm_* settings seeded by migration 102.  Reads via the generic
 * settings.service; writes one key at a time to keep blast radius small.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save as SaveIcon, Workflow as WorkflowIcon } from 'lucide-react';
import { Button, Card, Loading, Input } from '../../../components/common';
import { settingsService } from '../../../services/settings.service';
import { quotesService } from '../../../services/quotes.service';
import { useFeatureFlags } from '../../../contexts/FeatureFlagsContext';
import { toast } from 'react-toastify';

const SETTING_KEYS = [
  'crm_quotes_pdf_attachment_enabled',
  'crm_quotes_skonto_enabled',
  'crm_quotes_accept_window_minutes',
  'crm_quotes_default_valid_days',
  'crm_quotes_number_format',
  // Terms of Service step on quote acceptance (migration 104).
  'crm_quotes_tos_required',
  'crm_quotes_tos_text',
  'crm_quotes_tos_url',
  'crm_invoices_qr_enabled',
  'crm_invoice_round_total',
  'crm_invoices_reminders_enabled',
  'crm_invoices_reminder_first_days',
  'crm_invoices_reminder_second_days',
  'crm_invoices_late_fee_enabled',
  'crm_invoices_late_fee_type',
  'crm_invoices_late_fee_minor',
  'crm_invoices_late_fee_percent',
  'crm_invoices_late_fee_vat_enabled',
  'crm_invoices_late_fee_label',
  'crm_invoices_skonto_business_days',
  'crm_invoices_skonto_percent_default',
  // Installment defaults (migration 141) — pre-populate fresh ad-hoc
  // rows in the Quote / Invoice editors' Installments panel.
  'crm_invoices_installment_trigger_first',
  'crm_invoices_installment_days_before_event',
  'crm_invoices_installment_days_after_event',
  // Pre-event customer reminders (migration 143) — toggles managed
  // on Settings → Reminder emails (their own dedicated tab) so the
  // template editor and the global enable/days-before settings live
  // in one place.
  'crm_invoices_number_format',
  // Default Net days + Payment timing pickers (migration 124+125).
  // The per-quote/per-invoice picker becomes a true override over
  // these global defaults — the editor reads these on new documents.
  'crm_invoices_default_payment_net_days_template_id',
  'crm_invoices_default_payment_timing_template_id',
  // Contracts (migration 130). Number format token convention matches
  // quotes/invoices: {YEAR} {MONTH} {SEQ:04d}. Default 'C-{YEAR}-{SEQ:04d}'.
  'crm_contracts_number_format',
  'crm_contracts_default_valid_days',
  'crm_contracts_pdf_attachment_enabled',
  'crm_contracts_require_drawn_signature',
  'crm_contracts_allow_pdf_upload',
  'crm_contracts_store_ip',
  // Dashboard CRM-overview tile visibility (per-tile). Default ON;
  // explicit false hides the tile. Stored as one boolean per tile so
  // admins can mix-and-match — e.g. someone who only bills hourly
  // hides the quotes pipeline + the per-status invoice breakdown
  // but keeps the revenue / outstanding tiles.
  'crm_overview_show_revenue',
  'crm_overview_show_outstanding',
  'crm_overview_show_quotes',
  'crm_overview_show_invoices',
];

export const CrmSettingsPage: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { flags } = useFeatureFlags();
  // Show each section only when the corresponding master flag is on —
  // configuring Skonto on quotes is pointless when quotes itself is
  // disabled. The dashboard-overview tile section depends on quotes
  // OR bills (the per-tile checkboxes inside govern quote-pipeline +
  // invoice-pipeline + revenue tiles, all of which are CRM-money).
  const showQuotes = !!flags.quotes;
  const showInvoices = !!flags.bills;
  // When the workflow engine is live, reminder TIMING is owned by the Invoice
  // dunning flow — show a pointer instead of the legacy schedule controls. When
  // it's off, the legacy reminder ladder still runs, so keep its controls.
  const workflowsLive = !!flags.workflows;
  const showContracts = !!flags.contracts;
  const showDashboardOverview = !!(flags.quotes || flags.bills);
  const anySection = showQuotes || showInvoices || showContracts || showDashboardOverview;
  const { data, isLoading } = useQuery({
    queryKey: ['settings', 'crm'],
    queryFn: async () => {
      const all = await settingsService.getAllSettings();
      const out: Record<string, any> = {};
      for (const key of SETTING_KEYS) out[key] = all[key];
      return out;
    },
  });

  // Migration 124 — list the split-picker templates so the new
  // dropdowns can render labels. Same endpoints the editors use.
  const { data: netDaysTemplates } = useQuery({
    queryKey: ['payment-net-days-templates'],
    queryFn: () => quotesService.listPaymentNetDaysTemplates(),
  });
  const { data: timingTemplates } = useQuery({
    queryKey: ['payment-timing-templates'],
    queryFn: () => quotesService.listPaymentTimingTemplates(),
  });

  const [values, setValues] = useState<Record<string, any>>({});
  useEffect(() => { if (data) setValues(data); }, [data]);

  const saveAll = useMutation({
    mutationFn: async () => {
      const changed: Record<string, any> = {};
      for (const key of SETTING_KEYS) {
        if (values[key] !== data?.[key]) changed[key] = values[key];
      }
      if (Object.keys(changed).length > 0) {
        await settingsService.updateSettings(changed);
      }
    },
    onSuccess: () => {
      toast.success(t('crmSettings.savedToast', 'CRM settings saved.'));
      qc.invalidateQueries({ queryKey: ['settings', 'crm'] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || 'Save failed'),
  });

  if (isLoading) return <Loading />;

  const setVal = (k: string, v: any) => setValues((s) => ({ ...s, [k]: v }));
  const checkbox = (k: string, label: string) => (
    <label className="flex items-center gap-2 text-sm py-1">
      <input type="checkbox" checked={!!values[k]} onChange={(e) => setVal(k, e.target.checked)} />
      <span>{t(`crmSettings.${k}.label`, label)}</span>
    </label>
  );
  /**
   * Checkbox variant for settings whose backend semantics treat
   * `undefined` (row missing from app_settings) as ON — e.g.
   * `crm_contracts_allow_pdf_upload` reads `getAppSetting(...) !== false`,
   * so a missing row behaves as if checked. Without this variant the
   * UI would render an unchecked box while the feature is actually
   * running, which misleads admins on installs whose DB ran an earlier
   * version of migration 130 (before these settings were added to the
   * seed list).
   *
   * Stored booleans (true / false) always win; the default only fills
   * in when the value is null/undefined.
   */
  const checkboxDefaultOn = (k: string, label: string) => {
    const stored = values[k];
    const effective = stored === undefined || stored === null ? true : !!stored;
    return (
      <label className="flex items-center gap-2 text-sm py-1">
        <input
          type="checkbox"
          checked={effective}
          onChange={(e) => setVal(k, e.target.checked)}
        />
        <span>{t(`crmSettings.${k}.label`, label)}</span>
      </label>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">{t('crmSettings.title', 'CRM settings')}</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t('crmSettings.subtitle', 'Fine-tune quote and invoice behaviour.')}
          </p>
        </div>
        <Button onClick={() => saveAll.mutate()} disabled={saveAll.isPending || !anySection}>
          <SaveIcon className="w-4 h-4 mr-1" />{t('common.save', 'Save')}
        </Button>
      </div>

      {!anySection && (
        <Card>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {t('crmSettings.emptyState',
              'No CRM features are currently enabled. Turn on Quotes, Invoices, or Contracts in Settings → Features to see the matching configuration here.')}
          </p>
        </Card>
      )}

      {showQuotes && (
      <Card>
        <h3 className="font-semibold mb-3">{t('crmSettings.section.quotes', 'Quotes')}</h3>
        {checkbox('crm_quotes_pdf_attachment_enabled', 'Attach quote PDF to email')}
        {checkbox('crm_quotes_skonto_enabled', 'Allow early-payment discount (Skonto) on quotes')}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
          <Input type="number" min={1} max={120}
            label={t('crmSettings.crm_quotes_accept_window_minutes.label', 'Accept window (minutes)') as string}
            value={values.crm_quotes_accept_window_minutes ?? 15}
            onChange={(e) => setVal('crm_quotes_accept_window_minutes', Number(e.target.value))} />
          <Input type="number" min={1} max={365}
            label={t('crmSettings.crm_quotes_default_valid_days.label', 'Default validity (days)') as string}
            value={values.crm_quotes_default_valid_days ?? 30}
            onChange={(e) => setVal('crm_quotes_default_valid_days', Number(e.target.value))} />
          <Input
            label={t('crmSettings.crm_quotes_number_format.label', 'Quote number format') as string}
            value={values.crm_quotes_number_format ?? ''}
            onChange={(e) => setVal('crm_quotes_number_format', e.target.value)} />
        </div>

        {/* Terms of Service step (migration 104). When required, the
            public quote response page shows a checkbox the customer
            must tick before Accept fires. The text snapshot is
            recorded on the quote at acceptance time for audit. */}
        <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
          <h4 className="font-semibold mb-2 text-sm">
            {t('crmSettings.section.quotesTos', 'Terms of Service / AGB step')}
          </h4>
          {checkbox('crm_quotes_tos_required', 'Require customers to tick "I accept the Terms of Service" before accepting')}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
            <Input
              label={t('crmSettings.crm_quotes_tos_url.label', 'Terms of Service URL (optional)') as string}
              placeholder="https://example.com/terms"
              value={values.crm_quotes_tos_url ?? ''}
              onChange={(e) => setVal('crm_quotes_tos_url', e.target.value)} />
          </div>
          <div className="mt-3">
            <label className="block text-sm font-medium mb-1">
              {t('crmSettings.crm_quotes_tos_text.label', 'Inline Terms text shown on the quote page')}
            </label>
            <textarea
              rows={6}
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
              value={values.crm_quotes_tos_text ?? ''}
              onChange={(e) => setVal('crm_quotes_tos_text', e.target.value)}
              placeholder={t('crmSettings.crm_quotes_tos_text.placeholder',
                'Paste the contract terms here. Plain text. Leave empty to only show the checkbox + URL.') as string}
            />
          </div>
        </div>
      </Card>
      )}

      {showInvoices && (
      <Card>
        <h3 className="font-semibold mb-3">{t('crmSettings.section.invoices', 'Invoices')}</h3>
        {checkbox('crm_invoices_qr_enabled', 'Render payment QR on invoice PDFs')}
        {checkbox('crm_invoice_round_total', 'Reconcile sub-cent rounding to a clean total (adds a "Rundung" row when per-line rounding drifts from qty × rate)')}

        {/* Reminder TIMING: owned by the Invoice dunning workflow when the
            engine is live (callout); otherwise the legacy schedule controls. The
            late-fee math below is configured here in both cases — it's the fee
            the dunning path applies, not part of the schedule. */}
        {workflowsLive ? (
          <div className="mt-2 rounded-lg border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 p-3 text-sm text-blue-800 dark:text-blue-200 flex items-start gap-2">
            <WorkflowIcon className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">{t('crmSettings.dunningMoved.title', 'Reminder schedule is now in Workflows')}</p>
              <p className="mt-1">
                {t('crmSettings.dunningMoved.body', 'When and how often overdue reminders go out is configured in the “Invoice dunning” workflow. Late-fee amounts below still apply.')}{' '}
                <Link to="/admin/workflows" className="underline font-medium">{t('crmSettings.dunningMoved.link', 'Open Workflows')}</Link>
              </p>
            </div>
          </div>
        ) : (
          checkbox('crm_invoices_reminders_enabled', 'Send automatic reminders for overdue invoices')
        )}

        {checkbox('crm_invoices_late_fee_enabled', 'Add a late fee (Mahngebühr) on every reminder after the first')}
        <div className="mt-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-200">
          <p className="font-medium">{t('crmSettings.lateFeeAgb.title', 'Late fees must be itemised in your terms (AGB)')}</p>
          <p className="mt-1">{t('crmSettings.lateFeeAgb.body', 'Vertragliche Pflicht: Sätze wie „Es werden Mahnspesen erhoben“ reichen nicht aus. In den AGB muss die konkrete Gebühr klar beziffert sein (z.B. „CHF 20 ab der 2. Mahnung“). Mit dem Treuhänder prüfen.')}</p>
        </div>
        {checkbox('crm_invoices_late_fee_vat_enabled', 'Charge VAT on late fees (Switzerland — leave off for DE/AT; no effect if your organisation has no VAT rate)')}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
          {!workflowsLive && (
            <>
              <Input type="number" min={1} max={365}
                label={t('crmSettings.crm_invoices_reminder_first_days.label', 'First reminder after (days past due)') as string}
                value={values.crm_invoices_reminder_first_days ?? 14}
                onChange={(e) => setVal('crm_invoices_reminder_first_days', Number(e.target.value))} />
              <Input type="number" min={1} max={365}
                label={t('crmSettings.crm_invoices_reminder_second_days.label', 'Second reminder after (days past due)') as string}
                value={values.crm_invoices_reminder_second_days ?? 30}
                onChange={(e) => setVal('crm_invoices_reminder_second_days', Number(e.target.value))} />
            </>
          )}
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('crmSettings.crm_invoices_late_fee_type.label', 'Late fee type')}
            </label>
            <select
              value={values.crm_invoices_late_fee_type ?? 'flat'}
              onChange={(e) => setVal('crm_invoices_late_fee_type', e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100"
            >
              <option value="flat">{t('crmSettings.lateFeeType.flat', 'Flat amount (Rappen)')}</option>
              <option value="percent">{t('crmSettings.lateFeeType.percent', 'Percentage of invoice')}</option>
            </select>
          </div>
          {(values.crm_invoices_late_fee_type ?? 'flat') === 'percent' ? (
            <Input type="number" min={0} step="0.01" max={100}
              label={t('crmSettings.crm_invoices_late_fee_percent.label', 'Late fee (% of invoice)') as string}
              value={values.crm_invoices_late_fee_percent ?? 0}
              onChange={(e) => setVal('crm_invoices_late_fee_percent', Number(e.target.value))} />
          ) : (
            <Input type="number" min={0}
              label={t('crmSettings.crm_invoices_late_fee_minor.label', 'Late fee (minor units / Rappen)') as string}
              value={values.crm_invoices_late_fee_minor ?? 0}
              onChange={(e) => setVal('crm_invoices_late_fee_minor', Number(e.target.value))} />
          )}
          <Input
            label={t('crmSettings.crm_invoices_late_fee_label.label', 'Late fee label') as string}
            value={values.crm_invoices_late_fee_label ?? 'Mahngebühr'}
            onChange={(e) => setVal('crm_invoices_late_fee_label', e.target.value)} />
          <Input type="number" min={0} step="0.01" max="100"
            label={t('crmSettings.crm_invoices_skonto_percent_default.label', 'Skonto rate (default %)') as string}
            value={values.crm_invoices_skonto_percent_default ?? 2}
            onChange={(e) => setVal('crm_invoices_skonto_percent_default', Number(e.target.value))} />
          <Input type="number" min={0}
            label={t('crmSettings.crm_invoices_skonto_business_days.label', 'Skonto window (business days)') as string}
            value={values.crm_invoices_skonto_business_days ?? 5}
            onChange={(e) => setVal('crm_invoices_skonto_business_days', Number(e.target.value))} />
          <Input
            label={t('crmSettings.crm_invoices_number_format.label', 'Invoice number format') as string}
            value={values.crm_invoices_number_format ?? ''}
            onChange={(e) => setVal('crm_invoices_number_format', e.target.value)} />
        </div>

        {/* Installment defaults (migration 141). Pre-populate fresh
            ad-hoc rows in the Quote / Invoice editors' Installments
            panel — admins type these defaults exactly once instead of
            on every new multi-installment plan. Per-document edits
            still override. */}
        <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
          <h4 className="font-semibold mb-2 text-sm">
            {t('crmSettings.section.installmentDefaults', 'Default installment triggers')}
          </h4>
          <p className="text-xs text-neutral-500 mb-3">
            {t('crmSettings.installmentDefaults.help',
              'Pre-fill the trigger for fresh rows in the Installments panel. Per-document edits override; existing documents keep their snapshotted plan.')}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">
                {t('crmSettings.crm_invoices_installment_trigger_first.label', 'First installment trigger')}
              </label>
              <select
                value={values.crm_invoices_installment_trigger_first ?? 'quote_accepted'}
                onChange={(e) => setVal('crm_invoices_installment_trigger_first', e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
              >
                <option value="quote_accepted">{t('crmSettings.installmentDefaults.trigger.quote_accepted', 'At signing / creation')}</option>
                <option value="before_event">{t('crmSettings.installmentDefaults.trigger.before_event', 'Before event')}</option>
                <option value="after_event">{t('crmSettings.installmentDefaults.trigger.after_event', 'After event')}</option>
                <option value="after_delivery">{t('crmSettings.installmentDefaults.trigger.after_delivery', 'On delivery (manual release)')}</option>
                <option value="fixed_date">{t('crmSettings.installmentDefaults.trigger.fixed_date', 'Fixed date')}</option>
              </select>
            </div>
            <Input type="number" min={0}
              label={t('crmSettings.crm_invoices_installment_days_before_event.label', 'Days before event (middle installment)') as string}
              value={values.crm_invoices_installment_days_before_event ?? 14}
              onChange={(e) => setVal('crm_invoices_installment_days_before_event', Number(e.target.value))} />
            <Input type="number" min={0}
              label={t('crmSettings.crm_invoices_installment_days_after_event.label', 'Days after event (final installment)') as string}
              value={values.crm_invoices_installment_days_after_event ?? 14}
              onChange={(e) => setVal('crm_invoices_installment_days_after_event', Number(e.target.value))} />
          </div>
        </div>

        {/* Pre-event customer reminders moved to their own dedicated
            tab — Settings → Reminder emails — modelled on the
            BlockLibrary two-column layout. Toggles + per-type
            templates live there in one place. */}

        {/* Default payment-term pickers (migration 124+125). The
            per-quote / per-invoice editor still always shows the
            pickers — admin can override per document — but new
            drafts auto-prefill from these two settings. */}
        <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
          <h4 className="font-semibold mb-2 text-sm">
            {t('crmSettings.section.paymentDefaults', 'Default payment conditions')}
          </h4>
          <p className="text-xs text-neutral-500 mb-3">
            {t('crmSettings.paymentDefaults.help',
              'Pre-filled on every new quote and invoice. The editor still lets you pick a different combination per document.')}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">
                {t('crmSettings.crm_invoices_default_payment_net_days_template_id.label', 'Default net days')}
              </label>
              <select
                className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
                value={values.crm_invoices_default_payment_net_days_template_id ?? ''}
                onChange={(e) => setVal('crm_invoices_default_payment_net_days_template_id', e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">{t('crmSettings.paymentDefaults.none', '— No default —')}</option>
                {netDaysTemplates?.templates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                {t('crmSettings.crm_invoices_default_payment_timing_template_id.label', 'Default payment schedule')}
              </label>
              <select
                className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
                value={values.crm_invoices_default_payment_timing_template_id ?? ''}
                onChange={(e) => setVal('crm_invoices_default_payment_timing_template_id', e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">{t('crmSettings.paymentDefaults.none', '— No default —')}</option>
                {timingTemplates?.templates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

      </Card>
      )}

      {showContracts && (
      /* Contracts (migration 130). Mirrors the Quotes / Invoices block
         shape: 3 behaviour toggles, then a 2-column input grid, then
         the number-format input with helper text. */
      <Card>
        <h3 className="font-semibold mb-3">{t('crmSettings.section.contracts', 'Contracts')}</h3>
        {/* Three of these four toggles use `!== false` semantics on
            the backend — a missing app_settings row behaves as if
            checked. `checkboxDefaultOn` mirrors that so the UI tells
            the truth on installs whose DB never received the seed
            rows. `require_drawn_signature` uses `=== true` (default
            off) so it stays on the plain `checkbox`. */}
        {checkboxDefaultOn('crm_contracts_pdf_attachment_enabled', 'Attach contract PDF to email')}
        {checkbox('crm_contracts_require_drawn_signature', 'Require drawn signature (typed name alone is not enough)')}
        {checkboxDefaultOn('crm_contracts_allow_pdf_upload', 'Allow customer to upload a wet-signed PDF')}
        {checkboxDefaultOn('crm_contracts_store_ip', "Store signer's IP address (recommended — corroborating evidence in civil disputes)")}
        <p className="text-xs text-neutral-500 mt-1 ml-6">
          {t('crmSettings.crm_contracts_store_ip.help',
            "When off, the customer's and admin's IP at signing time is NOT recorded into the contract row or the public sign-page audit confirmation. Per GDPR data-minimisation principle some operators prefer this — but IP is corroborating identity evidence if the contract is challenged, so we recommend keeping it on.")}
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
          <Input type="number" min={1} max={365}
            label={t('crmSettings.crm_contracts_default_valid_days.label', 'Signing window (days)') as string}
            value={values.crm_contracts_default_valid_days ?? 30}
            onChange={(e) => setVal('crm_contracts_default_valid_days', Number(e.target.value))} />
          <Input
            label={t('crmSettings.crm_contracts_number_format.label', 'Contract number format') as string}
            value={values.crm_contracts_number_format ?? ''}
            onChange={(e) => setVal('crm_contracts_number_format', e.target.value)}
            placeholder="C-{YEAR}-{SEQ:04d}"
          />
        </div>
        <p className="text-xs text-neutral-500 mt-2">
          {t('crmSettings.crm_contracts_number_format.help',
            'Supported tokens: {YEAR}, {MONTH}, {SEQ:04d}. Example: LBM-C-{YEAR}-{SEQ:04d} → LBM-C-2026-0001.')}
        </p>
      </Card>
      )}

      {showDashboardOverview && (
      /* Dashboard CRM overview — per-tile visibility. All settings
         default ON; the checkbox shows checked when the value is
         unset, matching the contracts card's pattern. The dashboard
         component reads these via /public/settings and hides the
         matching tile when the value is explicit false. */
      <Card>
        <h3 className="font-semibold mb-1">
          {t('crmSettings.section.dashboardOverview', 'Dashboard CRM overview')}
        </h3>
        <p className="text-xs text-neutral-500 mb-3">
          {t('crmSettings.section.dashboardOverviewHint',
            'Hide CRM overview tiles on the admin dashboard. All tiles render by default; uncheck to hide.')}
        </p>
        {checkboxDefaultOn('crm_overview_show_revenue', 'Revenue tiles (30 / 90 / 365 days)')}
        {checkboxDefaultOn('crm_overview_show_outstanding', 'Outstanding payments tile')}
        {checkboxDefaultOn('crm_overview_show_quotes', 'Quotes pipeline (per-status)')}
        {checkboxDefaultOn('crm_overview_show_invoices', 'Invoices pipeline (per-status)')}
      </Card>
      )}
    </div>
  );
};
