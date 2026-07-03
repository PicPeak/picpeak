import { api } from '../config/api';

export interface SetupStatus {
  needsAdmin: boolean;
  complete: boolean;
}

export interface SetupAdminUser {
  id: number;
  username: string;
  email: string;
  role: { name: string; displayName?: string };
}

export interface CreateInitialAdminInput {
  token: string;
  email: string;
  password: string;
}

// First-run bootstrap. Public endpoints that self-close once an admin exists.
export const setupService = {
  async getSetupStatus(): Promise<SetupStatus> {
    const response = await api.get<SetupStatus>('/setup/status');
    return response.data;
  },

  // Step-1 pre-flight: confirm the token is valid before advancing to the
  // account step. Rejects (400, field: 'token') on a wrong token without
  // burning it. Throws on non-2xx so the caller can branch on the status.
  async verifyToken(token: string): Promise<{ valid: boolean }> {
    const response = await api.post<{ valid: boolean }>('/setup/verify-token', { token });
    return response.data;
  },

  async createInitialAdmin(input: CreateInitialAdminInput): Promise<{ user: SetupAdminUser }> {
    // Admin JWT is returned as an HttpOnly cookie (mirrors login); body carries the user.
    const response = await api.post<{ user: SetupAdminUser }>('/setup/admin', input);
    return response.data;
  },
};
