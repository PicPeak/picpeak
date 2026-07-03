/**
 * CRM → Development sub-page.
 *
 * Houses internal-use dev tools for the CRM area. Hidden behind the
 * `crmDevelopment` feature flag (Settings → Features).
 *
 * Current tools:
 *   - "Test admin payment-check email" — fires the full
 *     payment-check email flow on any sent/overdue invoice,
 *     bypassing the 24h throttle.
 *   - "Send any CRM email to me" — fires any of the seeded CRM
 *     email templates to the currently-logged-in admin's mailbox
 *     with mock data (real PDF attached when a matching record
 *     exists). Lets the maintainer eyeball every template's
 *     rendered output in seconds.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Wrench, MailCheck, AlertTriangle, Mail } from 'lucide-react';
import { Button, Card, Loading } from '../../../components/common';
import { billsService, type InvoiceStatus } from '../../../services/bills.service';
import { devToolsService, type CrmEmailTemplateKey } from '../../../services/devTools.service';
import { toast } from 'react-toastify';

// Translation keys for each template's display title + description.
// The lookup table holds (titleKey, titleFallback, descKey, descFallback)
// so the t() call at render time can do the EN-fallback dance without
// every key being typed out inline. Adding a template means: add the
// key here AND the matching translation pair to en.json/de.json.
const TEMPLATE_LABEL_KEYS: Record<
  CrmEmailTemplateKey,
  { titleKey: string; titleFallback: string; descKey: string; descFallback: string }
> = {
  quote_sent: {
    titleKey: 'crmDev.templates.label.quote_sent.title',
    titleFallback: 'Quote sent (to customer)',
    descKey: 'crmDev.templates.label.quote_sent.description',
    descFallback: 'Fires when a quote is sent — includes the PDF attachment + accept/decline links.',
  },
  quote_accepted_customer: {
    titleKey: 'crmDev.templates.label.quote_accepted_customer.title',
    titleFallback: 'Quote accepted — customer confirmation',
    descKey: 'crmDev.templates.label.quote_accepted_customer.description',
    descFallback: 'Sent to the customer after they (or the admin on their behalf) accept the quote. Includes PDF.',
  },
  quote_accepted_admin: {
    titleKey: 'crmDev.templates.label.quote_accepted_admin.title',
    titleFallback: 'Quote accepted — admin notification',
    descKey: 'crmDev.templates.label.quote_accepted_admin.description',
    descFallback: 'Notifies the admin that a quote was accepted by the customer.',
  },
  quote_declined_admin: {
    titleKey: 'crmDev.templates.label.quote_declined_admin.title',
    titleFallback: 'Quote declined — admin notification',
    descKey: 'crmDev.templates.label.quote_declined_admin.description',
    descFallback: 'Notifies the admin that a quote was declined by the customer.',
  },
  invoice_sent: {
    titleKey: 'crmDev.templates.label.invoice_sent.title',
    titleFallback: 'Invoice sent (to customer)',
    descKey: 'crmDev.templates.label.invoice_sent.description',
    descFallback: 'Fires when an invoice is sent — includes the PDF attachment.',
  },
  invoice_reminder_first: {
    titleKey: 'crmDev.templates.label.invoice_reminder_first.title',
    titleFallback: 'Invoice reminder — first',
    descKey: 'crmDev.templates.label.invoice_reminder_first.description',
    descFallback: 'First reminder to the customer. No late fee yet.',
  },
  invoice_reminder_second: {
    titleKey: 'crmDev.templates.label.invoice_reminder_second.title',
    titleFallback: 'Invoice reminder — second (with Mahngebühr)',
    descKey: 'crmDev.templates.label.invoice_reminder_second.description',
    descFallback: 'Second reminder with the late fee surcharge added.',
  },
  invoice_payment_check_admin: {
    titleKey: 'crmDev.templates.label.invoice_payment_check_admin.title',
    titleFallback: 'Payment-check (admin)',
    descKey: 'crmDev.templates.label.invoice_payment_check_admin.description',
    descFallback: 'Admin email with the three signed-token action buttons.',
  },
  contract_sent: {
    titleKey: 'crmDev.templates.label.contract_sent.title',
    titleFallback: 'Contract sent (to customer)',
    descKey: 'crmDev.templates.label.contract_sent.description',
    descFallback: 'Admin → customer send with the unsigned contract PDF attached.',
  },
  contract_signed_admin_notification: {
    titleKey: 'crmDev.templates.label.contract_signed_admin_notification.title',
    titleFallback: 'Contract signed — admin notification',
    descKey: 'crmDev.templates.label.contract_signed_admin_notification.description',
    descFallback: 'Customer-signed ping back to the admin. No attachment.',
  },
  contract_fully_signed: {
    titleKey: 'crmDev.templates.label.contract_fully_signed.title',
    titleFallback: 'Contract fully signed (dual-party)',
    descKey: 'crmDev.templates.label.contract_fully_signed.description',
    descFallback: 'Dual-party send once both signatures are in. Stamped contract PDF attached.',
  },
  event_reminder_default: {
    titleKey: 'crmDev.templates.label.event_reminder_default.title',
    titleFallback: 'Event reminder — default (catch-all)',
    descKey: 'crmDev.templates.label.event_reminder_default.description',
    descFallback: 'Pre-event nudge used when no per-category template matches.',
  },
  event_reminder_wedding: {
    titleKey: 'crmDev.templates.label.event_reminder_wedding.title',
    titleFallback: 'Event reminder — wedding',
    descKey: 'crmDev.templates.label.event_reminder_wedding.description',
    descFallback: 'Pre-event nudge for events with event_type=wedding.',
  },
  event_reminder_birthday: {
    titleKey: 'crmDev.templates.label.event_reminder_birthday.title',
    titleFallback: 'Event reminder — birthday',
    descKey: 'crmDev.templates.label.event_reminder_birthday.description',
    descFallback: 'Pre-event nudge for events with event_type=birthday.',
  },
  event_reminder_corporate: {
    titleKey: 'crmDev.templates.label.event_reminder_corporate.title',
    titleFallback: 'Event reminder — corporate',
    descKey: 'crmDev.templates.label.event_reminder_corporate.description',
    descFallback: 'Pre-event nudge for events with event_type=corporate.',
  },
  event_reminder_other: {
    titleKey: 'crmDev.templates.label.event_reminder_other.title',
    titleFallback: 'Event reminder — other',
    descKey: 'crmDev.templates.label.event_reminder_other.description',
    descFallback: 'Pre-event nudge for events with event_type=other.',
  },
};

export const CrmDevelopmentPage: React.FC = () => {
  const { t } = useTranslation();

  // ---- Test payment-check email picker -------------------------
  const { data: invoiceList, isLoading: invoiceListLoading } = useQuery({
    queryKey: ['invoices', 'dev-payment-check'],
    queryFn: () => billsService.list({
      status: ['sent', 'overdue'] as InvoiceStatus[],
      sort: 'newest',
      pageSize: 50,
    }),
  });

  // Shared error inspector — the security env-gate added in
  // commit abd50e4 returns 403 with code 'CRM_DEV_ENV_DISABLED'
  // whenever PICPEAK_ENABLE_DEV_TOOLS isn't set. Without surfacing
  // this, the page just rendered an empty templates list and a
  // silent useQuery error — admin couldn't tell why the tools
  // appeared "broken".
  const isEnvDisabled = (err: unknown): boolean => {
    const e = err as { response?: { data?: { code?: string } } } | null;
    return e?.response?.data?.code === 'CRM_DEV_ENV_DISABLED';
  };
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<number | null>(null);
  const [paymentCheckBusy, setPaymentCheckBusy] = useState(false);

  const handleSendPaymentCheck = async () => {
    if (!selectedInvoiceId) return;
    setPaymentCheckBusy(true);
    try {
      await billsService.testPaymentCheck(selectedInvoiceId);
      toast.success(t('crmDev.paymentCheck.sentToast',
        'Test email queued. Check the recipient\'s inbox.'));
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Failed to queue test email');
    } finally {
      setPaymentCheckBusy(false);
    }
  };

  // ---- Email-template self-tester -----------------------------
  const { data: templates, isLoading: templatesLoading, error: templatesError } = useQuery({
    queryKey: ['dev', 'email-templates'],
    queryFn: () => devToolsService.listEmailTemplates(),
    // Don't retry env-disabled — the env var won't appear mid-session.
    retry: (failureCount, err) => !isEnvDisabled(err) && failureCount < 2,
  });
  const [sendingKey, setSendingKey] = useState<CrmEmailTemplateKey | null>(null);

  const handleSendTemplate = async (key: CrmEmailTemplateKey) => {
    setSendingKey(key);
    try {
      const result = await devToolsService.sendTestEmail(key);
      toast.success(t('crmDev.templates.sentToast',
        'Queued to {{to}}.', { to: result.to }));
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Failed to queue test email');
    } finally {
      setSendingKey(null);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
          <Wrench className="w-5 h-5" />
          {t('crmDev.title', 'CRM Development')}
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
          {t('crmDev.subtitle',
            'Internal tools for verifying CRM flows. Hidden by default — enabled via Settings → Features → Development.')}
        </p>
      </div>

      <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-3 mb-5 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-700 dark:text-amber-300 mt-0.5 shrink-0" />
        <p className="text-sm text-amber-800 dark:text-amber-200">
          {t('crmDev.warning',
            'These tools fire real side effects (emails, status changes). Use against test data.')}
        </p>
      </div>

      {/* Env-gate banner. The /admin/dev routes are hard-gated by
          PICPEAK_ENABLE_DEV_TOOLS=1 (security fix abd50e4) — a
          feature-flag flip alone isn't enough. Without this, the
          templates list silently shows up empty and admins assume the
          tools are broken. */}
      {isEnvDisabled(templatesError) && (
        <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 p-3 mb-5 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-red-700 dark:text-red-300 mt-0.5 shrink-0" />
          <div className="text-sm text-red-800 dark:text-red-200">
            <p className="font-semibold mb-1">
              {t('crmDev.envDisabled.title', 'Dev tools blocked by env gate')}
            </p>
            <p>
              {t('crmDev.envDisabled.body',
                'Set PICPEAK_ENABLE_DEV_TOOLS=1 in your backend env file and restart the server. The feature flag alone is not enough — this is a deliberate production-safety guard.')}
            </p>
          </div>
        </div>
      )}

      {/* Tool: payment-check email against a real invoice. */}
      <Card className="mb-5">
        <h3 className="font-semibold mb-1 flex items-center gap-2">
          <MailCheck className="w-4 h-4" />
          {t('crmDev.paymentCheck.title', 'Test payment-check email (real invoice)')}
        </h3>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-4">
          {t('crmDev.paymentCheck.help',
            'Fires the admin payment-check email for a real sent/overdue invoice, bypassing the 24h throttle. The three buttons in the email are real signed tokens — clicking them will affect the invoice status.')}
        </p>

        {invoiceListLoading ? <Loading /> : (
          <>
            <label className="block text-xs uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-1">
              {t('crmDev.paymentCheck.selectInvoice', 'Sent or overdue invoice')}
            </label>
            <select
              value={selectedInvoiceId || ''}
              onChange={(e) => setSelectedInvoiceId(e.target.value ? Number(e.target.value) : null)}
              className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm mb-3"
            >
              <option value="">{t('crmDev.paymentCheck.selectPlaceholder', '— Pick an invoice —')}</option>
              {(invoiceList?.invoices || []).map((inv) => (
                <option key={inv.id} value={inv.id}>
                  {inv.invoiceNumber} · {inv.customer.companyName || inv.customer.displayName || inv.customer.email} · {inv.status}
                </option>
              ))}
            </select>
            {invoiceList && invoiceList.invoices.length === 0 && (
              <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-3">
                {t('crmDev.paymentCheck.noneAvailable',
                  'No sent or overdue invoices in the database.')}
              </p>
            )}
            <div className="flex justify-end">
              <Button onClick={handleSendPaymentCheck} disabled={!selectedInvoiceId || paymentCheckBusy}>
                <MailCheck className="w-4 h-4 mr-1" />
                {paymentCheckBusy
                  ? t('crmDev.paymentCheck.sending', 'Queuing…')
                  : t('crmDev.paymentCheck.send', 'Send test email')}
              </Button>
            </div>
          </>
        )}
      </Card>

      {/* Tool: send any CRM template to the logged-in admin. */}
      <Card>
        <h3 className="font-semibold mb-1 flex items-center gap-2">
          <Mail className="w-4 h-4" />
          {t('crmDev.templates.title', 'Send any CRM email to me (mock data)')}
        </h3>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-4">
          {t('crmDev.templates.help',
            'Queues the chosen template to your own admin email with placeholder values. When the install has a real quote / invoice on file, the appropriate PDF is attached so you can verify the full output.')}
        </p>

        {templatesLoading ? <Loading /> : isEnvDisabled(templatesError) ? (
          // Env gate banner above already explains the situation —
          // keep this card empty rather than rendering a misleading
          // "0 templates" list.
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {t('crmDev.envDisabled.cardHint',
              'Email templates can\'t be listed until the dev-tools env gate is opened.')}
          </p>
        ) : (templates && templates.length === 0) ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {t('crmDev.templates.empty',
              'No CRM email templates found — run migrations to seed them.')}
          </p>
        ) : (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
            {(templates || []).map((tpl) => {
              const meta = TEMPLATE_LABEL_KEYS[tpl.key];
              const busy = sendingKey === tpl.key;
              const title = meta ? t(meta.titleKey, meta.titleFallback) : tpl.key;
              const description = meta ? t(meta.descKey, meta.descFallback) : '';
              return (
                <li key={tpl.key} className="py-3 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-neutral-500">{tpl.key}</span>
                      {!tpl.present && (
                        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                          {t('crmDev.templates.notSeeded', 'Not seeded')}
                        </span>
                      )}
                    </div>
                    <div className="text-sm font-medium mt-0.5">{title}</div>
                    {description && (
                      <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{description}</div>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleSendTemplate(tpl.key)}
                    disabled={!tpl.present || busy}
                  >
                    {busy
                      ? t('crmDev.templates.sending', 'Queuing…')
                      : t('crmDev.templates.send', 'Send to me')}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
};

export default CrmDevelopmentPage;
