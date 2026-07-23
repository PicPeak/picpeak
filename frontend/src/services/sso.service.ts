/**
 * SSO (OIDC) Settings Service (#798)
 * API client for the dedicated /admin/settings/sso endpoints — the client
 * secret is write-only (never returned; `oidc_client_secret_set` flags it).
 */

import { api } from '../config/api';

export interface SsoSettings {
  oidc_enabled: boolean;
  oidc_issuer_url: string;
  oidc_client_id: string;
  oidc_client_secret_set: boolean;
  oidc_autoprovision: boolean;
  oidc_default_role: string;
  oidc_button_label: string;
  oidc_scopes: string;
  oidc_role_mapping_enabled: boolean;
  oidc_roles_claim: string;
  /** IdP role/group value → PicPeak role name. */
  oidc_role_mappings: Record<string, string>;
  oidc_require_mapped_role: boolean;
  oidc_disable_local_login: boolean;
  oidc_logout_from_idp: boolean;
  redirect_uri: string;
  /** Register this at the IdP (e.g. Keycloak "Valid post logout redirect URIs"). */
  post_logout_redirect_uri: string;
}

export interface UpdateSsoSettings {
  oidc_enabled?: boolean;
  oidc_issuer_url?: string;
  oidc_client_id?: string;
  /** Only sent when the admin typed a new one; empty keeps the stored secret. */
  oidc_client_secret?: string;
  oidc_autoprovision?: boolean;
  oidc_default_role?: string;
  oidc_button_label?: string;
  oidc_scopes?: string;
  oidc_role_mapping_enabled?: boolean;
  oidc_roles_claim?: string;
  oidc_role_mappings?: Record<string, string>;
  oidc_require_mapped_role?: boolean;
  oidc_disable_local_login?: boolean;
  oidc_logout_from_idp?: boolean;
}

export interface SsoTestResult {
  ok: boolean;
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  error?: string;
}

export const ssoService = {
  async getSettings(): Promise<SsoSettings> {
    const response = await api.get<SsoSettings>('/admin/settings/sso');
    return response.data;
  },

  async updateSettings(data: UpdateSsoSettings): Promise<void> {
    await api.put('/admin/settings/sso', data);
  },

  // Server-side discovery probe against the SAVED config.
  async testConnection(): Promise<SsoTestResult> {
    const response = await api.post<SsoTestResult>('/admin/settings/sso/test');
    return response.data;
  },
};
