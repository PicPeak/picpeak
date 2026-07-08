/**
 * Admin → Projects API client. Hits /api/admin/projects/*.
 *
 * Projects are the admin-only grouping layer above events (Model A). The
 * cockpit "overview" rolls up the per-event/per-customer documents. Mirrors
 * the contracts/bills service shape: `data.data || data` unwrap.
 */
import { api } from '../config/api';

export type ProjectStatus = 'active' | 'archived' | string;

/** Rolled-up project value: newest stage wins per deal (invoice > quote;
 *  contracts carry no total), cumulative across events, split by currency. */
export interface ProjectValuation {
  byCurrency: Array<{ currency: string; totalMinor: number; paidMinor: number }>;
}

export interface ProjectSummary {
  id: number;
  name: string;
  customerAccountId: number | null;
  customerEmail: string | null;
  status: ProjectStatus;
  eventCount?: number;
  valuation?: ProjectValuation;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ProjectEvent {
  id: number;
  event_name: string;
  event_date: string | null;
  slug: string;
  is_active: boolean | number;
  is_draft: boolean | number;
  expires_at: string | null;
  is_archived: boolean | number;
}

export interface ProjectEmail {
  id: number;
  recipient: string;
  type: string;
  status: string;
  queuedAt: string | null;
  sentAt: string | null;
  error: string | null;
  eventId: number | null;
  /** true = exact HTML stored at send time; false = preview re-rendered. */
  stored: boolean;
}

export interface ProjectInvoice {
  id: number;
  invoice_number: string;
  status: string;
  kind: string | null;
  issue_date: string | null;
  due_date: string | null;
  total_amount_minor: number;
  paid_amount_minor: number | null;
  paid_at: string | null;
  currency: string;
  event_id: number | null;
  deal_uuid: string | null;
}

export interface ProjectQuote {
  id: number;
  quote_number: string;
  status: string;
  issue_date: string | null;
  valid_until: string | null;
  total_amount_minor: number;
  currency: string;
  deal_uuid: string | null;
}

export interface ProjectContract {
  id: number;
  contract_number: string;
  status: string;
  issue_date: string | null;
  signed_by_customer_at: string | null;
  deal_uuid: string | null;
}

export interface ProjectHourEntry {
  id: number;
  entry_date: string | null;
  duration_minutes: number;
  description: string | null;
  status: string | null;
  invoice_id: number | null;
}

export interface ProjectMilestone {
  kind: 'quote' | 'contract' | 'gallery' | 'invoice';
  id?: number;
  label: string;
  date: string | null;
}

export interface ProjectOverview {
  project: ProjectSummary;
  events: ProjectEvent[];
  emails: ProjectEmail[];
  quotes: ProjectQuote[];
  contracts: ProjectContract[];
  invoices: ProjectInvoice[];
  hours: { entries: ProjectHourEntry[]; totalMinutes: number };
  milestones: ProjectMilestone[];
  valuation: ProjectValuation;
}

export interface EmailPreview {
  id: number;
  recipient: string;
  type: string;
  status: string;
  available: boolean;
  /** true = exact bytes stored at send time; false = re-rendered from the
   *  current template (approximation for emails sent before capture). */
  exact: boolean;
  html: string | null;
}

export const projectsService = {
  async list(params: { q?: string; status?: string } = {}): Promise<ProjectSummary[]> {
    const { data } = await api.get('/admin/projects', { params });
    const body = data.data || data;
    return body.projects || [];
  },

  async get(id: number): Promise<ProjectSummary> {
    const { data } = await api.get(`/admin/projects/${id}`);
    const body = data.data || data;
    return body.project;
  },

  async create(payload: { name: string; customerAccountId?: number | null }): Promise<ProjectSummary> {
    const { data } = await api.post('/admin/projects', payload);
    const body = data.data || data;
    return body.project;
  },

  async update(
    id: number,
    payload: { name?: string; customerAccountId?: number | null; status?: string },
  ): Promise<ProjectSummary> {
    const { data } = await api.put(`/admin/projects/${id}`, payload);
    const body = data.data || data;
    return body.project;
  },

  async overview(id: number): Promise<ProjectOverview> {
    const { data } = await api.get(`/admin/projects/${id}/overview`);
    return (data.data || data) as ProjectOverview;
  },

  async assignEvent(projectId: number, eventId: number): Promise<void> {
    await api.post(`/admin/projects/${projectId}/events`, { eventId });
  },

  async assignQuote(projectId: number, quoteId: number): Promise<void> {
    await api.post(`/admin/projects/${projectId}/quotes`, { quoteId });
  },

  async assignContract(projectId: number, contractId: number): Promise<void> {
    await api.post(`/admin/projects/${projectId}/contracts`, { contractId });
  },

  async emailPreview(emailId: number): Promise<EmailPreview> {
    const { data } = await api.get(`/admin/projects/email/${emailId}/preview`);
    return (data.data || data) as EmailPreview;
  },

  async resendEmail(emailId: number): Promise<void> {
    await api.post(`/admin/projects/email/${emailId}/resend`);
  },

  async cancelEmail(emailId: number): Promise<void> {
    await api.post(`/admin/projects/email/${emailId}/cancel`);
  },

  async retryEmail(emailId: number): Promise<void> {
    await api.post(`/admin/projects/email/${emailId}/retry`);
  },

  async sendEmailNow(emailId: number): Promise<void> {
    await api.post(`/admin/projects/email/${emailId}/send-now`);
  },
};
