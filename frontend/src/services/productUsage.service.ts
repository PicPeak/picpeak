import { api } from '../config/api';

export interface UsageStatus {
  status:
    | 'disabled'
    | 'activation_pending'
    | 'active'
    | 'deletion_pending'
    | 'identity_conflict';
  notice_dismissed: boolean;
  installation_id: string | null;
  collector_url: string | null;
  collector_error?: 'INVALID_COLLECTOR_URL' | null;
  schema_version: string;
  available_schema_version?: string;
  consent_version?: string;
  consent_update_available?: boolean;
  last_report_date: string | null;
  last_error: string | null;
  /** Epoch ms the paced sender is waiting for, or null when nothing is paced. */
  retry_after?: number | null;
  /** True only for a withdrawal whose delete packet can never be signed. */
  can_abandon?: boolean;
  pending_action: string | null;
  last_packet: unknown;
  privacy_receipts?: Record<string, unknown>;
  feedback_preferences: { name: string };
}
export interface ProductFeedback {
  kind: 'feedback' | 'feature_request' | 'testimonial';
  title: string;
  body: string;
  name: string;
  allow_public: boolean;
  allow_marketing: boolean;
}
export const productUsageService = {
  async status(): Promise<UsageStatus> {
    return (await api.get('/admin/usage')).data;
  },
  async activity(): Promise<void> {
    await api.post('/admin/usage/activity');
  },
  async dismiss(): Promise<UsageStatus> {
    return (await api.post('/admin/usage/dismiss')).data;
  },
  async enable(): Promise<UsageStatus> {
    return (
      await api.post('/admin/usage/enable', {
        consent_version: 'usage-consent.v2'
      })
    ).data;
  },
  async upgradeConsent(): Promise<{ delivered: boolean; queued: boolean; state: UsageStatus }> {
    return (await api.post('/admin/usage/consent', { consent_version: 'usage-consent.v2' })).data;
  },
  async disable(): Promise<UsageStatus> {
    return (await api.post('/admin/usage/disable')).data;
  },
  async retry(): Promise<UsageStatus> {
    return (await api.post('/admin/usage/retry')).data;
  },
  async abandon(): Promise<UsageStatus> {
    return (await api.post('/admin/usage/abandon')).data;
  },
  async preview(): Promise<unknown> {
    return (await api.get('/admin/usage/preview')).data;
  },
  async export(): Promise<unknown> {
    return (await api.get('/admin/usage/export')).data;
  },
  async preferences(name: string): Promise<UsageStatus> {
    return (await api.put('/admin/usage/feedback-preferences', { name })).data;
  },
  async feedback(
    value: ProductFeedback
  ): Promise<{ delivered: boolean; queued?: boolean; state: UsageStatus }> {
    return (await api.post('/admin/usage/feedback', value)).data;
  },
  async portalSession(): Promise<{ delivered: boolean; url: string | null }> {
    return (await api.post('/admin/usage/portal-session')).data;
  }
};
