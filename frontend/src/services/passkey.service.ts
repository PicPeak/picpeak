import { api } from '../config/api';
import type { LoginResponse } from '../types';
import { createPasskey, getPasskey } from '../utils/webauthn';

// Passkeys for the admin's own account (issue 1733). Management acts on the
// currently authenticated admin; login is the public pair of routes.

export interface Passkey {
  id: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export type PasskeyUnavailableReason =
  | 'not_configured'
  | 'ip_address'
  | 'insecure_origin'
  | 'origin_mismatch'
  | 'sso_only'
  | 'sso_account';

export interface PasskeyStatus {
  available: boolean;
  reason: PasskeyUnavailableReason | null;
  rpId: string | null;
  origin: string | null;
  max: number;
  // The account has two-factor authentication: adding a passkey needs a code.
  mfaEnabled: boolean;
  passkeys: Passkey[];
}

export const passkeyService = {
  async getStatus(): Promise<PasskeyStatus> {
    const response = await api.get<PasskeyStatus>('/admin/auth/passkeys');
    return response.data;
  },

  // Options, the browser prompt, then verification. Rejects with the
  // browser's DOMException when the prompt is dismissed (see passkeyErrorKind).
  // `code` is the authenticator (or recovery) code an account with two-factor
  // authentication has to give as well.
  async register(name: string, currentPassword: string, code?: string): Promise<Passkey> {
    const { data } = await api.post<{ options: Record<string, any> }>(
      '/admin/auth/passkeys/register/options', code ? { currentPassword, code } : { currentPassword });
    const response = await createPasskey(data.options);
    const verified = await api.post<{ passkey: Passkey }>(
      '/admin/auth/passkeys/register/verify', { response, name });
    return verified.data.passkey;
  },

  async rename(id: number, name: string): Promise<void> {
    await api.patch(`/admin/auth/passkeys/${id}`, { name });
  },

  async remove(id: number, currentPassword: string): Promise<void> {
    await api.post(`/admin/auth/passkeys/${id}/delete`, { currentPassword });
  },

  // Without mfaToken: passwordless sign-in. With it: the second step of a
  // password login, in place of the authenticator code.
  async login({ mfaToken, rememberMe }: { mfaToken?: string | null; rememberMe?: boolean } = {}): Promise<LoginResponse> {
    const body = mfaToken ? { mfaToken } : { remember_me: rememberMe === true };
    const { data } = await api.post<{ options: Record<string, any> }>('/auth/admin/passkey/options', body);
    const response = await getPasskey(data.options);
    const verified = await api.post<LoginResponse>(
      '/auth/admin/passkey/verify', mfaToken ? { response, mfaToken } : { response });
    return verified.data;
  },
};
