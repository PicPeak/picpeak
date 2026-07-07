/**
 * Admin → Dev tools API client. Gated server-side by the
 * `crmDevelopment` feature flag; the frontend additionally hides
 * the page when the flag is off, but the API check is what
 * actually enforces the gate.
 */
import { api } from '../config/api';

export type CrmEmailTemplateKey =
  | 'quote_sent'
  | 'quote_accepted_customer'
  | 'quote_accepted_admin'
  | 'quote_declined_admin'
  | 'invoice_sent'
  | 'invoice_reminder_first'
  | 'invoice_reminder_second'
  | 'invoice_payment_check_admin'
  // Contracts (migration 130). Backend exposes all three flows via the
  // dev tester (admin → customer send, customer-signed ping, dual-party
  // fully-signed). Without these in the union, useQuery returns rows
  // whose `key` doesn't resolve to a label and they render as raw
  // template_key strings.
  | 'contract_sent'
  | 'contract_signed_admin_notification'
  | 'contract_fully_signed'
  // Pre-event reminder emails (migration 143). One template per
  // event_type with a catch-all default. Backend resolves
  // `event_reminder_<event_type>` then falls back to
  // `event_reminder_default`.
  | 'event_reminder_default'
  | 'event_reminder_wedding'
  | 'event_reminder_birthday'
  | 'event_reminder_corporate'
  | 'event_reminder_other';

export interface DevEmailTemplateStatus {
  key: CrmEmailTemplateKey;
  present: boolean;
}

export const devToolsService = {
  async listEmailTemplates(): Promise<DevEmailTemplateStatus[]> {
    const { data } = await api.get('/admin/dev/email-templates');
    return (data.data || data).templates;
  },

  async sendTestEmail(templateKey: CrmEmailTemplateKey): Promise<{
    sent: true;
    to: string;
    template: CrmEmailTemplateKey;
  }> {
    const { data } = await api.post('/admin/dev/send-test-email', { templateKey });
    return data.data || data;
  },
};
