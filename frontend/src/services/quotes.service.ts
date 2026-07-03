/**
 * Admin → Quotes API client. Hits /api/admin/quotes/* (admin auth) and
 * /api/public/quotes/:token for the customer-facing accept/decline page.
 */
import { api } from '../config/api';

export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired' | 'converted';
export type QuoteSort =
  | 'newest' | 'oldest'
  | 'issue_asc' | 'issue_desc'
  | 'customer_asc' | 'customer_desc'
  | 'value_asc' | 'value_desc';

export interface QuoteLineItem {
  id?: number;
  position: number;
  quantity: number;
  description: string;
  unitPriceMinor: number;
  discountPercent: number;
  lineTotalMinor?: number;
  /**
   * Hierarchy (migration 119). Sub-items reference their parent by
   * position within the same payload. NULL = top-level item, summed
   * into the document net. NON-NULL = sub-item, display-only
   * itemisation under the parent. Max one level deep.
   */
  parentPosition?: number | null;
  /** Persisted DB id of the parent, populated by the server on read. */
  parentLineItemId?: number | null;
  /**
   * Optional free-form notes rendered below the description on the
   * PDF and customer view. Smaller, italic. Max 2000 chars.
   */
  detailsText?: string | null;
}

export interface QuoteSummary {
  id: number;
  quoteNumber: string;
  /** Cross-document lineage UUID (migration 140). Used by the
   *  DocumentLineageCard on the detail page to fetch every other
   *  doc — contract, invoices, Storni — that shares this deal. */
  dealUuid: string | null;
  customerAccountId: number;
  /** Migration 121 — Project Overview link (null when unlinked). */
  projectId: number | null;
  customer: {
    email: string | null;
    displayName: string | null;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
    /** Computed server-side from password_hash. true = admin-only
     *  customer (no portal access). Drives the Passive badge in the
     *  editor pill + the quotes list. */
    isPassive?: boolean;
  };
  status: QuoteStatus;
  language: string;
  currency: string;
  issueDate: string;
  validUntil: string | null;
  eventName: string | null;
  eventDate: string | null;
  eventType: string | null;
  bookingWorkflowId: number | null;
  totalAmountMinor: number;
  sentAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  convertedEventId: number | null;
  /** Migration 130 — set by contractService.createFromQuote so the
   *  QuoteDetailPage can render a "Linked contract" badge alongside
   *  the existing resulting-invoices list. Null when no contract was
   *  drafted from the quote. */
  convertedContractId?: number | null;
  /** Human contract_number of the converted contract (joined-in on
   *  read). Surfaced so the QuoteDetailPage's Linked-documents card
   *  shows "Linked contract LBM-C-2026-0010" instead of "#10". */
  convertedContractNumber?: string | null;
  createdAt: string;
}

export interface QuoteDetail extends QuoteSummary {
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  expectedDurationHours: number | null;
  paymentTermTemplateId: number | null;
  /** Migration 124 — split payment-term picker. Two new FKs preferred
   *  by the editor; legacy `paymentTermTemplateId` stays for sent
   *  quotes authored before the split. */
  paymentNetDaysTemplateId: number | null;
  paymentTimingTemplateId: number | null;
  netAmountMinor: number;
  vatRate: number | null;
  vatAmountMinor: number;
  shippingAmountMinor: number;
  introText: string | null;
  outroText: string | null;
  internalNotes: string | null;
  ccPdfEmail: string | null;
  respondedAt: string | null;
  responseLockedAt: string | null;
  /** Free-text reason captured when an admin declines on the customer's
   *  behalf (migration 115). Null for customer-side declines + non-declined
   *  quotes. */
  declineReason: string | null;
  pdfPath: string | null;
  businessBankAccountId: number | null;
}

export interface QuoteWithLineItems {
  quote: QuoteDetail;
  lineItems: QuoteLineItem[];
}

export interface PaymentTermInstallment {
  label: string;
  percent: number;
  trigger: 'quote_accepted' | 'before_event' | 'after_event' | 'after_delivery' | 'fixed_date';
  offset_days: number;
}

export interface PaymentTermTemplate {
  id: number;
  name: string;
  description: string;
  netDays: number;
  skontoPercent: number | null;
  skontoWithinDays: number | null;
  installments: PaymentTermInstallment[];
  isSystem: boolean;
  isActive: boolean;
  displayOrder: number;
}

// Migration 124 — split payment-term picker. Two new template tables
// replace the conflated PaymentTermTemplate for new quotes/invoices.
// The old type stays for back-compat with sent documents whose
// snapshot still references the legacy table.
export interface PaymentNetDaysTemplate {
  id: number;
  name: string;
  description: string | null;
  netDays: number;
  skontoPercent: number | null;
  skontoWithinDays: number | null;
  isSystem: boolean;
  isActive: boolean;
  displayOrder: number;
}

export interface PaymentTimingTemplate {
  id: number;
  name: string;
  description: string | null;
  installments: PaymentTermInstallment[];
  isSystem: boolean;
  isActive: boolean;
  displayOrder: number;
}

export interface LineItemPreset {
  id: number;
  name: string;
  description: string;
  unitPriceMinor: number;
  currency: string;
  quantityDefault: number;
  displayOrder: number;
  isActive: boolean;
}

export interface QuoteCreatePayload {
  customerAccountId: number;
  language?: string;
  currency?: string;
  issueDate?: string;
  validUntil?: string;
  eventName?: string;
  eventDate?: string;
  eventType?: string | null;
  bookingWorkflowId?: number | null;
  eventTimeStart?: string;
  eventTimeEnd?: string;
  expectedDurationHours?: number;
  paymentTermTemplateId?: number;
  /** Migration 124 — split payment-term picker. Both must be set
   *  together for the new path to engage on the backend. */
  paymentNetDaysTemplateId?: number;
  paymentTimingTemplateId?: number;
  /** Ad-hoc installments (commit #6). Overrides the picked timing
   *  template's installments on the snapshot. Empty/missing = use
   *  the template's value as-is. */
  installments?: PaymentTermInstallment[];
  vatRate?: number;
  /** Migration 130 — snapshot of the chosen output VAT code (null = custom rate). */
  vatCode?: string | null;
  shippingAmountMinor?: number;
  introText?: string;
  outroText?: string;
  internalNotes?: string;
  ccPdfEmail?: string;
  businessBankAccountId?: number;
  /** Migration 121 — optional link to a Project Overview project.
   *  null clears the link; undefined leaves it unchanged. */
  projectId?: number | null;
  lineItems: QuoteLineItem[];
}

export interface QuoteListResponse {
  quotes: QuoteSummary[];
  pagination: { total: number; page: number; pageSize: number; totalPages: number };
}

export const quotesService = {
  async list(params: {
    status?: QuoteStatus[];
    customerAccountId?: number;
    q?: string;
    from?: string;
    to?: string;
    sort?: QuoteSort;
    page?: number;
    pageSize?: number;
  } = {}): Promise<QuoteListResponse> {
    const { data } = await api.get('/admin/quotes', {
      params: {
        ...params,
        status: params.status?.join(','),
      },
    });
    return data.data || data;
  },

  async get(id: number): Promise<QuoteWithLineItems> {
    const { data } = await api.get(`/admin/quotes/${id}`);
    return data.data || data;
  },

  async create(payload: QuoteCreatePayload): Promise<QuoteWithLineItems> {
    const { data } = await api.post('/admin/quotes', payload);
    return data.data || data;
  },

  async update(id: number, payload: Partial<QuoteCreatePayload>): Promise<QuoteWithLineItems> {
    const { data } = await api.put(`/admin/quotes/${id}`, payload);
    return data.data || data;
  },

  async send(id: number): Promise<{ sent: true; token: string }> {
    const { data } = await api.post(`/admin/quotes/${id}/send`);
    return data.data || data;
  },

  async duplicate(id: number): Promise<{ id: number }> {
    const { data } = await api.post(`/admin/quotes/${id}/duplicate`);
    return data.data || data;
  },

  /** Admin accept-on-behalf — flips the quote to `accepted` without
   *  going through the customer's public response page. Used for
   *  phone-call workflows where the customer verbally agrees. */
  async acceptOnBehalf(id: number): Promise<{ status: string; lockedAt: string }> {
    const { data } = await api.post(`/admin/quotes/${id}/accept`);
    return data.data || data;
  },

  /** Admin decline-on-behalf — flips the quote to `declined` without the
   *  customer's public response page. Optional free-text reason. Used
   *  when the customer says no by phone/email. */
  async declineOnBehalf(id: number, reason?: string): Promise<{ status: string; declinedAt: string }> {
    const { data } = await api.post(`/admin/quotes/${id}/decline`, reason ? { reason } : {});
    return data.data || data;
  },

  async convert(id: number): Promise<{ eventId: number; alreadyConverted: boolean }> {
    const { data } = await api.post(`/admin/quotes/${id}/convert`);
    return data.data || data;
  },

  /** Convert the quote directly into invoice(s) without creating an event. */
  async convertToInvoice(id: number): Promise<{ installmentsCreated: number }> {
    const { data } = await api.post(`/admin/quotes/${id}/convert-to-invoice`);
    return data.data || data;
  },

  /** Convert the quote into a fresh draft contract (#contracts feature).
   *  Leaves the quote in 'accepted' status; the contract becomes the
   *  active deliverable. After the customer + admin both sign, the
   *  contract detail page exposes its own convert-to-event /
   *  convert-to-invoice buttons that re-enter the quote conversion
   *  path via the contract's source_quote_id. */
  async convertToContract(id: number): Promise<{ contractId: number; alreadyConverted: boolean }> {
    const { data } = await api.post(`/admin/quotes/${id}/convert-to-contract`);
    return data.data || data;
  },

  /** Returns a blob URL the editor can `window.open()` straight into a tab. */
  async pdfUrl(id: number): Promise<string> {
    const res = await api.get(`/admin/quotes/${id}/pdf`, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },

  async previewPdfUrl(payload: QuoteCreatePayload): Promise<string> {
    const res = await api.post('/admin/quotes/preview', payload, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },

  async listLineItemPresets(): Promise<{ presets: LineItemPreset[] }> {
    const { data } = await api.get('/admin/quotes/presets/line-items');
    return data.data || data;
  },

  async createLineItemPreset(payload: Partial<LineItemPreset> & { name: string }): Promise<{ preset: LineItemPreset }> {
    const { data } = await api.post('/admin/quotes/presets/line-items', payload);
    return data.data || data;
  },

  async listPaymentTermTemplates(): Promise<{ templates: PaymentTermTemplate[] }> {
    const { data } = await api.get('/admin/quotes/presets/payment-terms');
    return data.data || data;
  },

  async createPaymentTermTemplate(payload: Omit<PaymentTermTemplate, 'id' | 'isSystem'>): Promise<{ template: PaymentTermTemplate }> {
    const { data } = await api.post('/admin/quotes/presets/payment-terms', payload);
    return data.data || data;
  },

  async updatePaymentTermTemplate(id: number, payload: Partial<PaymentTermTemplate>): Promise<{ template: PaymentTermTemplate }> {
    const { data } = await api.put(`/admin/quotes/presets/payment-terms/${id}`, payload);
    return data.data || data;
  },

  async deletePaymentTermTemplate(id: number): Promise<{ deleted: true }> {
    const { data } = await api.delete(`/admin/quotes/presets/payment-terms/${id}`);
    return data.data || data;
  },

  // Split payment-term templates (migration 124).
  async listPaymentNetDaysTemplates(): Promise<{ templates: PaymentNetDaysTemplate[] }> {
    const { data } = await api.get('/admin/quotes/presets/payment-net-days');
    return data.data || data;
  },

  async listPaymentTimingTemplates(): Promise<{ templates: PaymentTimingTemplate[] }> {
    const { data } = await api.get('/admin/quotes/presets/payment-timing');
    return data.data || data;
  },
};

// -------------------------------------------------------------------
// Public (no-auth) — accept / decline page
// -------------------------------------------------------------------

export interface PublicQuoteView {
  quoteNumber: string;
  status: QuoteStatus;
  language: string;
  currency: string;
  issueDate: string;
  validUntil: string | null;
  eventName: string | null;
  eventDate: string | null;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  introText: string | null;
  outroText: string | null;
  netAmountMinor: number;
  vatRate: number | null;
  vatAmountMinor: number;
  shippingAmountMinor: number;
  totalAmountMinor: number;
  respondedAt: string | null;
  responseLockedAt: string | null;
  canRespond: boolean;
  lineItems: Array<{
    position: number;
    quantity: number;
    description: string;
    unitPriceMinor: number;
    discountPercent: number;
    lineTotalMinor: number;
  }>;
  /** Terms of Service block driven by the global `crm_quotes_tos_*`
   *  settings. When `required` is true, the public page must show a
   *  checkbox the customer ticks before Accept can fire. The text +
   *  url are optional content the admin curates in CRM Settings. */
  tos?: {
    required: boolean;
    text: string;
    url: string;
    acceptedAt: string | null;
  };
  recipient: { displayName: string; email: string; companyName: string | null } | null;
  issuer: {
    companyName: string;
    email: string;
    website: string;
    footerLine: string;
    /** Absolute or /uploads/-prefixed URL set by the public route. */
    logoUrl?: string | null;
    /** Dark-mode branding logo; the page picks per its colour mode. */
    logoUrlDark?: string | null;
  } | null;
}

export const publicQuotesService = {
  async get(token: string): Promise<{ quote: PublicQuoteView }> {
    const { data } = await api.get(`/public/quotes/${token}`);
    return data.data || data;
  },
  async respond(
    token: string,
    action: 'accept' | 'decline',
    options: { tosAccepted?: boolean } = {},
  ): Promise<{ status: QuoteStatus; lockedAt: string }> {
    const { data } = await api.post(`/public/quotes/${token}/respond`, {
      action,
      tosAccepted: options.tosAccepted,
    });
    return data.data || data;
  },
};
