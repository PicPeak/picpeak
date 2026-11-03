import { api } from '../config/api';

export interface PaymentSettings {
  checkout_enabled: { stripe: boolean; snipcart: boolean; revision: string };
  snipcart: { source: 'none' | 'settings' | 'environment'; revision: string; public_key: string; checkout_configured: boolean; webhook_configured: boolean; unreadable: boolean; api_verified_at: string | null; webhook_url: string };
  providers: { available: Array<'stripe' | 'snipcart'>; preferred: 'stripe' | 'snipcart' | null };
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
  provider?: 'stripe' | 'snipcart' | 'availability';
  stripe?: boolean;
  snipcart?: boolean;
  public_key?: string;
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
  orders: (page: number) => api.get<{ orders: Array<{ id: number; order_id: string; provider_order_id: string | null; payment_provider: 'stripe' | 'snipcart'; buyer_email: string; total_cents: number; currency: string; status: string; orphaned: boolean; needs_attention: boolean; recovery_next_at: string | null }>; has_more: boolean }>('/admin/settings/payments/orders', { params: { page } }).then((r) => r.data),
  test: () => api.post<PaymentApiCheck>('/admin/settings/payments/test').then((r) => r.data),
};
