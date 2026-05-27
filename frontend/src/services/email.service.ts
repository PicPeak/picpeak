import { api } from '../config/api';

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

  // Test email configuration
  async testEmail(testEmail: string): Promise<void> {
    await api.post('/admin/email/test', { test_email: testEmail });
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

  // Preview email template
  async previewTemplate(key: string, previewData: Record<string, string>, language: string = 'en'): Promise<EmailPreview> {
    const response = await api.post<EmailPreview>(
      `/admin/email/templates/${key}/preview`,
      { preview_data: previewData, language }
    );
    return response.data;
  }
};
