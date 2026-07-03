/**
 * Admin → System health. Surfaces background failures (v1: stuck/failed
 * outbound emails) so they don't sit unnoticed, with retry/dismiss.
 */
import { api } from '../config/api';

export interface StuckEmail {
  id: number;
  recipientEmail: string;
  emailType: string;
  status: 'pending' | 'failed';
  retryCount: number;
  errorMessage: string | null;
  createdAt: string;
}

export interface SystemHealthFailures {
  stuckEmails: StuckEmail[];
  counts: { stuckEmails: number };
}

export const systemHealthService = {
  async getFailures(): Promise<SystemHealthFailures> {
    const { data } = await api.get('/admin/system-health/failures');
    return data.data || data;
  },

  async retryEmail(id: number): Promise<void> {
    await api.post(`/admin/system-health/failures/email/${id}/retry`);
  },

  async dismissEmail(id: number): Promise<void> {
    await api.delete(`/admin/system-health/failures/email/${id}`);
  },
};
