/**
 * Admin → Projects API client. Hits /api/admin/projects/*.
 *
 * Projects are the admin-only grouping layer above events (Model A). The
 * cockpit "overview" rolls up the per-event/per-customer documents. Mirrors
 * the contracts/bills service shape: `data.data || data` unwrap.
 */
import { api } from '../config/api';
import type { CustomerGroup } from './customerAdmin.service';

/** `inquiry` → `active` → `completed`, plus `cancelled` (no job came of it).
 *  `archived` is what older versions could set. */
export type ProjectStatus = 'inquiry' | 'active' | 'completed' | 'cancelled' | 'archived';

/** Where an inquiry came from. Keys only; the UI translates them. */
export const INQUIRY_SOURCES = ['referral', 'website', 'social', 'returning', 'fair', 'other'] as const;
export type InquirySource = typeof INQUIRY_SOURCES[number];

export type ProjectStageKey = 'inquiry' | 'quote' | 'contract' | 'gallery' | 'invoice' | 'done';

/** Which stages a job has (projectService.PROJECT_FLOWS): the stages a flow
 *  leaves out read "skipped". */
export const PROJECT_FLOWS = {
  full: [] as ProjectStageKey[],
  no_contract: ['contract'] as ProjectStageKey[],
  no_quote: ['quote', 'contract'] as ProjectStageKey[],
};
export type ProjectFlow = keyof typeof PROJECT_FLOWS;
/** Stages a project can skip by hand. */
export const SKIPPABLE_STAGES: ProjectStageKey[] = ['quote', 'contract', 'gallery', 'invoice'];
/** Derived on the server from what the project holds (projectService.deriveStages). */
/** `cancelled`: where a cancelled project stopped. */
export type ProjectStageState = 'done' | 'current' | 'skipped' | 'cancelled' | 'todo' | 'hidden';
export interface ProjectStage {
  stages: Array<{ key: ProjectStageKey; state: ProjectStageState }>;
  current: ProjectStageKey | null;
}

/** The inquiry a project starts from (migration 315). Dates are YYYY-MM-DD. */
export interface ProjectInquiryFields {
  eventType: string | null;
  eventDate: string | null;
  eventEndDate: string | null;
  location: string | null;
  guestCount: number | null;
  budgetMinor: number | null;
  currency: string | null;
  source: InquirySource | null;
  notes: string | null;
  flow: ProjectFlow | null;
}

/** Rolled-up project value: newest stage wins per deal (invoice > quote;
 *  contracts carry no total), cumulative across events, split by currency. */
export interface ProjectValuation {
  byCurrency: Array<{ currency: string; totalMinor: number; paidMinor: number }>;
}

export interface ProjectSummary extends Partial<ProjectInquiryFields> {
  id: number;
  name: string;
  customerAccountId: number | null;
  customerEmail: string | null;
  /** per_event / monthly / quarterly / manual; absent without customers.view. */
  customerBillingCadence?: string | null;
  /** The customer's groups (#1443); only on the cockpit, with customers.view. */
  customerGroups?: CustomerGroup[];
  status: ProjectStatus;
  eventCount?: number;
  valuation?: ProjectValuation;
  /** Only on the list with `withStages`. */
  stage?: ProjectStage;
  /** Stages skipped by hand on this project. */
  skippedStages?: ProjectStageKey[];
  /** Cockpit only: new quotes, contracts and invoices may join this project
   *  (its creator or a super admin; not a legacy ownerless project). */
  documentsLinkable?: boolean;
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
  /** null for mail matched by the customer's address when the caller lacks customers.view. */
  recipient: string | null;
  type: string;
  status: string;
  queuedAt: string | null;
  sentAt: string | null;
  error: string | null;
  eventId: number | null;
  /** true = exact HTML stored at send time; false = preview re-rendered. */
  stored: boolean;
  /** Authoritative: would the queued-mail routes accept an action on this row?
   *  False for CRM document mail (no event to own) and for event mail the
   *  caller does not own. Absent on older backends → treated as false. */
  canAct?: boolean;
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
  /** Tied by its own project_id, so it can be taken out of the project. */
  direct?: boolean;
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
  source_template_id?: number | null;
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

export interface ProjectOverview {
  project: ProjectSummary;
  events: ProjectEvent[];
  emails: ProjectEmail[];
  quotes: ProjectQuote[];
  contracts: ProjectContract[];
  invoices: ProjectInvoice[];
  hours: { entries: ProjectHourEntry[]; totalMinutes: number };
  valuation: ProjectValuation;
  stage: ProjectStage;
}

export type ProjectWritePayload = Partial<ProjectInquiryFields> & {
  skippedStages?: ProjectStageKey[];
  name?: string;
  customerAccountId?: number | null;
  /** `reopen` (update only): the server picks inquiry or active. */
  status?: ProjectStatus | 'reopen';
};

export interface EmailPreview {
  id: number;
  /** null when the caller lacks customers.view. */
  recipient: string | null;
  type: string;
  status: string;
  available: boolean;
  /** true = exact bytes stored at send time; false = re-rendered from the
   *  current template (approximation for emails sent before capture). */
  exact: boolean;
  html: string | null;
}

export const projectsService = {
  /** `status` takes a comma list (`inquiry,active`); `withStages` adds each
   *  project's stage (the dashboard). */
  async list({ withStages, ...rest }: { q?: string; status?: string; withStages?: boolean } = {}): Promise<ProjectSummary[]> {
    const params: Record<string, string> = { ...rest };
    if (withStages) params.withStages = '1';
    const { data } = await api.get('/admin/projects', { params });
    const body = data.data || data;
    return body.projects || [];
  },

  async get(id: number): Promise<ProjectSummary> {
    const { data } = await api.get(`/admin/projects/${id}`);
    const body = data.data || data;
    return body.project;
  },

  async create(payload: ProjectWritePayload & { name: string }): Promise<ProjectSummary> {
    const { data } = await api.post('/admin/projects', payload);
    const body = data.data || data;
    return body.project;
  },

  async update(id: number, payload: ProjectWritePayload): Promise<ProjectSummary> {
    const { data } = await api.put(`/admin/projects/${id}`, payload);
    const body = data.data || data;
    return body.project;
  },

  /** Galleries, documents and hours stay; they only lose the link. */
  async remove(id: number): Promise<void> {
    await api.delete(`/admin/projects/${id}`);
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

  async assignInvoice(projectId: number, invoiceId: number): Promise<void> {
    await api.post(`/admin/projects/${projectId}/invoices`, { invoiceId });
  },

  async unassignInvoice(projectId: number, invoiceId: number): Promise<void> {
    await api.delete(`/admin/projects/${projectId}/invoices/${invoiceId}`);
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
