/**
 * Admin → Newsletter campaigns API client (#1264).
 *
 * Every route behind this client is gated server-side by the `newsletters`
 * feature flag AND a `newsletters.view` / `newsletters.send` permission, so a
 * 403 here is a legitimate answer rather than a bug — the UI hides the
 * surface, and the API refuses it independently.
 */
import { api } from '../config/api';

export type CampaignStatus =
  | 'draft' | 'queued' | 'sending' | 'sent' | 'cancelled' | 'failed';

export type RecipientMode = 'all_active' | 'manual';

export type RecipientStatus =
  | 'queued' | 'sent' | 'failed' | 'cancelled' | 'skipped_opt_out';

export interface Campaign {
  id: number;
  name: string;
  subject: string;
  /** Stored already-sanitized by the server. Never render outside the
   *  sandboxed preview iframe. */
  bodyHtml: string;
  bodyCss: string;
  language: string;
  status: CampaignStatus;
  recipientMode: RecipientMode;
  /** Only meaningful when recipientMode is 'manual'. */
  customerIds: number[];
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  /** Recipients per minute. Server clamps to 1..120. */
  sendRatePerMinute: number;
  createdByAdminId: number | null;
  testSentAt: string | null;
  queuedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignRecipient {
  id: number;
  customerAccountId: number | null;
  email: string;
  status: RecipientStatus;
  errorMessage: string | null;
  sentAt: string | null;
  createdAt: string;
}

/** Counts only — the composer never pulls 2 000 addresses to show a number. */
export interface RecipientResolution {
  recipientCount: number;
  skippedOptOut: number;
  skippedNoEmail: number;
  sendRatePerMinute: number;
  estimatedMinutes: number;
}

export interface CampaignPayload {
  name?: string;
  subject?: string;
  bodyHtml?: string;
  bodyCss?: string;
  language?: string;
  recipientMode?: RecipientMode;
  customerIds?: number[];
  sendRatePerMinute?: number;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

const BASE = '/admin/newsletters';

export const newslettersService = {
  async list(status?: CampaignStatus): Promise<Campaign[]> {
    const { data } = await api.get(BASE, { params: status ? { status } : undefined });
    return data.campaigns || [];
  },

  async get(id: number): Promise<{ campaign: Campaign; recipientSummary: Record<string, number> }> {
    const { data } = await api.get(`${BASE}/${id}`);
    return data;
  },

  async create(payload: CampaignPayload): Promise<Campaign> {
    const { data } = await api.post(BASE, payload);
    return data.campaign;
  },

  async update(id: number, payload: CampaignPayload): Promise<Campaign> {
    const { data } = await api.put(`${BASE}/${id}`, payload);
    return data.campaign;
  },

  async remove(id: number): Promise<void> {
    await api.delete(`${BASE}/${id}`);
  },

  /** Rendered HTML for the sandboxed preview iframe. */
  async preview(id: number, opts: { customerId?: number; language?: string } = {}):
  Promise<{ subject: string; html: string; language: string; isSample: boolean }> {
    const { data } = await api.post(`${BASE}/${id}/preview`, opts);
    return data;
  },

  /** Dry run: how many people this would reach, and how many said no. */
  async resolveRecipients(id: number): Promise<RecipientResolution> {
    const { data } = await api.post(`${BASE}/${id}/recipients/resolve`);
    return data;
  },

  async sendTest(id: number, to: string): Promise<void> {
    await api.post(`${BASE}/${id}/test`, { to });
  },

  async queue(id: number): Promise<{ queued: number; skippedOptOut: number; sendRatePerMinute: number }> {
    const { data } = await api.post(`${BASE}/${id}/queue`);
    return data;
  },

  async cancel(id: number): Promise<{ cancelled: number }> {
    const { data } = await api.post(`${BASE}/${id}/cancel`);
    return data;
  },

  async recipients(id: number, opts: { page?: number; limit?: number; status?: RecipientStatus } = {}):
  Promise<{ data: CampaignRecipient[]; pagination: Pagination }> {
    const { data } = await api.get(`${BASE}/${id}/recipients`, { params: opts });
    return data;
  },
};
