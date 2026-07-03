import { api } from '../config/api';

// Per-user admin TOTP MFA (issue #738). All endpoints operate on the
// currently authenticated admin's own account.

export interface MfaStatus {
  enabled: boolean;
  enrolledAt: string | null;
  recoveryCodesRemaining: number;
}

export interface MfaSetupResponse {
  secret: string;
  otpauthUri: string;
  qr: string; // PNG data URL
  issuer: string;
  account: string;
}

export interface MfaRecoveryCodesResponse {
  message: string;
  recoveryCodes: string[];
}

export const mfaService = {
  async getStatus(): Promise<MfaStatus> {
    const response = await api.get<MfaStatus>('/admin/auth/mfa/status');
    return response.data;
  },

  async setup(): Promise<MfaSetupResponse> {
    const response = await api.post<MfaSetupResponse>('/admin/auth/mfa/setup');
    return response.data;
  },

  async enable(code: string): Promise<MfaRecoveryCodesResponse> {
    const response = await api.post<MfaRecoveryCodesResponse>('/admin/auth/mfa/enable', { code });
    return response.data;
  },

  async disable(code: string): Promise<{ message: string }> {
    const response = await api.post<{ message: string }>('/admin/auth/mfa/disable', { code });
    return response.data;
  },

  async regenerateRecoveryCodes(code: string): Promise<MfaRecoveryCodesResponse> {
    const response = await api.post<MfaRecoveryCodesResponse>('/admin/auth/mfa/recovery-codes', { code });
    return response.data;
  },
};
