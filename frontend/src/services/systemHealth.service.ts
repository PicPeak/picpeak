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
  /** Customer documents (#1444): uploads waiting for a review, and rejected ones. */
  customerDocuments?: {
    pending: number;
    rejected: number;
    /** Last 24 hours (#1444). */
    abuse?: { forbiddenAccess: number; quotaExceeded: number; rateLimited: number; customersOverThreshold: number };
    /** clamd (#1444). lastError is a category (timeout, refused, …), never the host. */
    scanner?: {
      configured: boolean; reachable: boolean; lastSuccessAt: string | null;
      lastError: string | null; lastErrorAt?: string | null;
    };
  };
  /** Where the key for signing evidence comes from (#1446) — never the key itself. */
  evidenceKey?: {
    source: 'env' | 'file' | 'none' | 'unreadable';
    keyId: string | null;
    /** A key OTHER than the current one that stored evidence was written under. */
    storedKeyId?: string | null;
    /** null when nothing is stored yet; false when any value is under another key. */
    matchesStored?: boolean | null;
    /** Encrypted values counted, across every evidence column. */
    storedValues?: number;
    /** How many of them the current key can still read. */
    storedValuesUnderCurrentKey?: number;
    /** Key ids the server can still open (#1446 key ring), the current one first. */
    readableKeyIds?: string[];
    /** Values under a key the server no longer has. */
    unreadableValues?: number;
    /** Values under an older key that can still be read — rotation pending. */
    valuesUnderOlderKeys?: number;
    /** Values per key id, including `unreadable` for anything unparseable. */
    storedKeyIds?: Record<string, number>;
    /** True when there was more evidence than this endpoint reads. */
    scanTruncated?: boolean;
  };
  /** Enumeration / replay signals on the signing links, last 24 h (#1446). */
  signingSignals?: {
    since: string;
    byKind: Record<string, number>;
    alerts: Array<{ hour: string; kind: string; count: number }>;
  } | null;
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
