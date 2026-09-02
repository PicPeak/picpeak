/**
 * Admin → System health. Surfaces background failures (v1: stuck/failed
 * outbound emails) so they don't sit unnoticed, with retry/dismiss.
 *
 * #1262 added `waitingEmails` and `processor`: a queue nobody is working
 * produces no failures at all, so "no failures" was not the same claim as
 * "everything went out".
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

/** What the queue processor last did — the difference between "idle" and "dead". */
export interface EmailProcessorStatus {
  started: boolean;
  lastRunAt: string | null;
  lastResult: { processed: number; sent: number; failed: number } | null;
  lastError: string | null;
}

export interface SystemHealthFailures {
  stuckEmails: StuckEmail[];
  /** Due, under the retry cap, and still unsent — nobody picked them up. */
  waitingEmails: StuckEmail[];
  processor: EmailProcessorStatus;
  /** The pending queue was larger than the endpoint reads — an empty
   *  `waitingEmails` then means "nothing found yet", not "nothing". */
  scanTruncated?: boolean;
  counts: { stuckEmails: number; waitingEmails: number; pendingScanned?: number };
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
