import { api } from '../config/api';

export interface PaymentSettings {
  source: 'none' | 'settings' | 'environment';
  revision: string;
  checkout_configured: boolean;
  webhook_configured: boolean;
  test_mode: boolean;
  unreadable: boolean;
  account_id: string | null;
  api_verified_at: string | null;
  webhook_verified_at: string | null;
  site_url: string;
  site_url_ready: boolean;
  webhook_url: string;
  api_version: string;
  webhook_events: string[];
}
export interface PaymentSettingsUpdate {
  revision: string;
  secret_key?: string;
  webhook_secret?: string;
}
export interface PaymentApiCheck {
  account_id: string;
  test_mode: boolean;
  checked_at: string;
}
export const paymentsService = {
  get: () => api.get<PaymentSettings>('/admin/settings/payments').then((r) => r.data),
  save: (data: PaymentSettingsUpdate) => api.put<PaymentSettings>('/admin/settings/payments', data).then((r) => r.data),
  test: () => api.post<PaymentApiCheck>('/admin/settings/payments/test').then((r) => r.data),
};
