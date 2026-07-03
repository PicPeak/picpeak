import { api } from '../config/api';

export type EmailQueueStatus = 'pending' | 'sent' | 'failed';

export interface EmailQueueItem {
  id: number;
  recipientEmail: string;
  emailType: string;
  status: EmailQueueStatus;
  createdAt: string;
  scheduledAt: string | null;
  sentAt: string | null;
  errorMessage: string | null;
  retryCount: number;
  eventId: number | null;
  eventName: string | null;
  eventSlug: string | null;
}

export interface EmailQueueListResponse {
  items: EmailQueueItem[];
  pagination: { total: number; page: number; pageSize: number; totalPages: number };
}

export interface EmailConfig {
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  smtp_user: string;
  smtp_pass: string;
  from_email: string;
  from_name: string;
  tls_reject_unauthorized: boolean;
}

export interface EmailTemplateTranslation {
  subject: string;
  body_html: string;
  body_text?: string;
}

/**
 * Top-level grouping in the admin Templates UI. Forward-compatible:
 * unknown values fall back to the 'core' section.
 */
export type EmailTemplateCategory = 'core' | 'customers' | 'billing' | 'quotes' | 'calendar' | string;

/**
 * Second-level grouping inside 'core' (which is busy enough to deserve
 * its own sub-headers). Other categories ignore this field.
 */
export type EmailTemplateSubcategory = 'gallery' | 'admin' | 'backup' | 'system' | string;

export interface EmailTemplate {
  id: number;
  template_key: string;
  variables: string[];
  translations: Record<string, EmailTemplateTranslation>;
  /** Display group (migration 098). Defaults to 'core' if absent. */
  category?: EmailTemplateCategory;
  /**
   * Second-level group inside `core`. Migration 098 backfill assigns
   * one of 'gallery' | 'admin' | 'backup' | 'system'; NULL for
   * templates outside `core`.
   */
  subcategory?: EmailTemplateSubcategory | null;
  /**
   * Name of the feature flag whose `false` state should mark this
   * template as "Feature off" in the admin UI. `null` = always
   * active. Migration 098 backfills these.
   */
  feature_flag?: string | null;
  updated_at: string;
}

export interface EmailPreview {
  subject: string;
  body_html: string;
  body_text: string;
}

export interface IncomingMailConfig {
  imap_host: string;
  imap_port: number;
  imap_secure: boolean;
  imap_user: string;
  imap_pass: string;
  imap_folder: string;
}

export interface ImapFolder {
  path: string;
  name: string;
  /** IMAP special-use flag, e.g. '\\Inbox', '\\Sent' — used to auto-select. */
  specialUse: string | null;
}

export interface ImapTestResult {
  ok: boolean;
  folder: string;
  messages: number;
  unseen: number;
}

export interface ImapRoundTripResult {
  ok: boolean;
  seconds?: number;
  recipient?: string;
}

export interface ImapPollResult {
  processed?: number;
  skipped?: 'disabled' | 'unconfigured' | 'busy';
}

export interface ReceivedEmail {
  id: number;
  message_id: string | null;
  from_address: string | null;
  subject: string | null;
  received_at: string | null;
  attachment_count: number;
  status: string;
  inbound_document_id: number | null;
  error: string | null;
}

export interface ReceivedEmailsResponse {
  items: ReceivedEmail[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export const emailService = {
  // Get email configuration
  async getConfig(): Promise<EmailConfig> {
    const response = await api.get<EmailConfig>('/admin/email/config');
    return response.data;
  },

  // Update email configuration
  async updateConfig(config: EmailConfig): Promise<void> {
    await api.post('/admin/email/config', config);
  },

  // Incoming mail (IMAP) configuration
  async getIncomingConfig(): Promise<IncomingMailConfig> {
    const response = await api.get<IncomingMailConfig>('/admin/email/incoming-config');
    return response.data;
  },
  async updateIncomingConfig(config: IncomingMailConfig): Promise<void> {
    await api.post('/admin/email/incoming-config', config);
  },
  // Auto-detect mailbox folders. Sends the current form values so detection
  // works before the config is saved (masked password falls back server-side).
  async listIncomingFolders(config?: Partial<IncomingMailConfig>): Promise<ImapFolder[]> {
    const response = await api.post<{ folders: ImapFolder[] }>('/admin/email/incoming-config/folders', config || {});
    return response.data.folders;
  },
  // Test the IMAP connection: opens the configured folder, reports counts.
  async testIncoming(config?: Partial<IncomingMailConfig>): Promise<ImapTestResult> {
    const response = await api.post<ImapTestResult>('/admin/email/incoming-config/test', config || {});
    return response.data;
  },
  // End-to-end: send via SMTP to the IMAP mailbox and confirm it arrives.
  // Uses saved config for both sides — no body. May take up to ~30s.
  async roundTripIncoming(): Promise<ImapRoundTripResult> {
    const response = await api.post<ImapRoundTripResult>('/admin/email/incoming-config/roundtrip', {});
    return response.data;
  },
  // Run the poller on demand. Returns { processed } or { skipped: '…' }.
  async pollIncoming(): Promise<ImapPollResult> {
    const response = await api.post<ImapPollResult>('/admin/email/incoming-config/poll', {});
    return response.data;
  },
  async listReceived(params: { page?: number; pageSize?: number } = {}): Promise<ReceivedEmailsResponse> {
    const response = await api.get<ReceivedEmailsResponse>('/admin/email/received', { params });
    return response.data;
  },

  // Test email configuration
  async testEmail(testEmail: string): Promise<void> {
    await api.post('/admin/email/test', { test_email: testEmail });
  },

  /** Flush the email queue immediately. Sends every pending email now,
   *  bypassing the business-hours floor — the escape hatch for draining
   *  the queue before maintenance/updates. */
  async flushQueue(): Promise<{ processed: number; sent: number; failed: number }> {
    const response = await api.post<{ processed: number; sent: number; failed: number }>(
      '/admin/email/flush-queue'
    );
    return response.data;
  },

  /** Read-only "Sent emails" feed — paginated view of the email_queue
   *  table with filters. email_data is never returned. */
  async listQueue(params: {
    status?: EmailQueueStatus;
    emailType?: string;
    q?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
  } = {}): Promise<EmailQueueListResponse> {
    const response = await api.get<EmailQueueListResponse>('/admin/email/queue', { params });
    return response.data;
  },

  // Get all email templates
  async getTemplates(): Promise<EmailTemplate[]> {
    const response = await api.get<EmailTemplate[]>('/admin/email/templates');
    return response.data;
  },

  // Get single template
  async getTemplate(key: string): Promise<EmailTemplate> {
    const response = await api.get<EmailTemplate>(`/admin/email/templates/${key}`);
    return response.data;
  },

  // Update email template
  async updateTemplate(key: string, data: { translations: Record<string, EmailTemplateTranslation> }): Promise<void> {
    await api.put(`/admin/email/templates/${key}`, data);
  },

  /** Create a new email template. Used by ReminderTemplatesPage to
   *  spawn a per-event-type reminder (e.g. `event_reminder_wedding`)
   *  initialised with the default catch-all's content. Returns 409 if
   *  the key already exists. */
  async createTemplate(payload: {
    template_key: string;
    translations: Record<string, EmailTemplateTranslation>;
    category?: string;
    subcategory?: string;
    feature_flag?: string;
    variables?: string[];
  }): Promise<{ template_key: string; id: number }> {
    const response = await api.post<{ template_key: string; id: number }>('/admin/email/templates', payload);
    return response.data;
  },

  // Preview email template
  async previewTemplate(key: string, previewData: Record<string, string>, language: string = 'en'): Promise<EmailPreview> {
    const response = await api.post<EmailPreview>(
      `/admin/email/templates/${key}/preview`,
      { preview_data: previewData, language }
    );
    return response.data;
  }
};
