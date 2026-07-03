/**
 * Admin → Contracts API client. Hits /api/admin/contracts/*.
 *
 * Mirrors bills.service.ts shape: `data.data || data` unwrap, blob
 * responses for PDFs via URL.createObjectURL.
 */
import { api } from '../config/api';

/** One leg of the integrity-check response (unsigned or signed PDF).
 *  `expected` is the stored SHA-256 column value; `actual` is freshly
 *  computed off the file on disk. `match` is true only when both are
 *  set and equal. `present:false` means the file doesn't exist on
 *  disk — usually expected for `signed` until the customer signs. */
export interface ContractIntegrityLeg {
  path: string | null;
  present: boolean;
  expected: string | null;
  actual: string | null;
  match: boolean;
}

export interface ContractIntegrityResult {
  unsigned: ContractIntegrityLeg;
  signed: ContractIntegrityLeg;
}

/** Shape of one row from /admin/contracts/:id/audit-trail. */
export interface AuditEntry {
  id: number;
  activity_type: string;
  actor_type: string | null;
  actor_id: number | null;
  actor_name: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export type ContractStatus =
  | 'draft'
  | 'sent'
  | 'signed_by_customer'
  | 'signed_by_admin'
  | 'fully_signed'
  | 'cancelled';

export type ContractSort =
  | 'newest' | 'oldest'
  | 'issue_asc' | 'issue_desc'
  | 'customer_asc' | 'customer_desc';

/** Canonical section enum kept in sync with backend SECTIONS_ORDER
 *  and contractBlocksService.ALLOWED_SECTIONS. Renaming any value
 *  here also needs a backend update — there's a test that guards it. */
export type ContractBlockSection =
  | 'basics'
  | 'scope'
  | 'privacy'
  | 'commercial'
  | 'nda'
  | 'closing';

export const CONTRACT_SECTIONS: ContractBlockSection[] = [
  'basics', 'scope', 'privacy', 'commercial', 'nda', 'closing',
];

export interface ContractBlock {
  id: number;
  slug: string;
  section: ContractBlockSection;
  name: string;
  description: string | null;
  bodyText: string;
  bodyTextDe: string | null;
  /** Migration 131 — locale-variant bodies. Null until the admin
   *  fills them in via the block library editor. Render context falls
   *  back EN when the contract's locale has no translation. */
  bodyTextRu: string | null;
  bodyTextPt: string | null;
  bodyTextNl: string | null;
  bodyTextFr: string | null;
  isSystem: boolean;
  isActive: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContractBlockInclusion {
  id: number;
  blockId: number;
  section: ContractBlockSection;
  position: number;
  included: boolean;
  block: {
    slug: string;
    name: string;
    description: string | null;
    bodyText: string;
    bodyTextDe: string | null;
    isSystem: boolean;
  };
  bodyTextSnapshot: string | null;
  bodyTextDeSnapshot: string | null;
}

export interface ContractSummary {
  id: number;
  contractNumber: string;
  /** Cross-document lineage UUID (migration 140). See QuoteSummary. */
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
    preferredLanguage?: string | null;
  };
  status: ContractStatus;
  language: string;
  issueDate: string;
  validUntil: string | null;
  title: string | null;
  /** Event snapshot fields (migration 130 in-place edit). Mirror
   *  quotes.event_* + invoices.event_* so the label flows through
   *  quote → contract → invoice unchanged. Null when the standalone
   *  contract didn't set them OR when the DB hasn't re-migrated yet. */
  eventName?: string | null;
  eventDate?: string | null;
  eventTimeStart?: string | null;
  eventTimeEnd?: string | null;
  introText: string | null;
  outroText: string | null;
  pdfPath: string | null;
  signedPdfPath: string | null;
  /** SHA-256 hex digest of the on-disk PDF — surfaced for the
   *  audit-trail panel so the admin (and the customer in their
   *  audit confirmation) can verify file integrity by re-hashing. */
  pdfSha256?: string | null;
  signedPdfSha256?: string | null;
  /** Migration 136 — post-sign PDF re-stamp failure marker. When non-
   *  null, the most recent stamp attempt threw and the contract is in
   *  an orphan state (status is signed_by_customer or signed_by_admin
   *  but signed_pdf_path is missing). Detail page surfaces a recovery
   *  banner pointing at the resend-signed / restamp-signatures admin
   *  routes. Cleared by any successful subsequent stamp. */
  signedPdfRenderFailedAt?: string | null;
  signedPdfRenderError?: string | null;
  sentAt: string | null;
  signedByCustomerAt: string | null;
  signedByAdminAt: string | null;
  signedCustomerName: string | null;
  signedAdminName: string | null;
  /** Disk paths to the captured signature PNGs. Surfaced only so the
   *  UI can show a "(no image)" hint next to evidence rows whose
   *  customer/admin signature didn't capture (e.g. old canvas bug);
   *  the paths themselves are never exposed in user-facing strings. */
  signedCustomerSignaturePath?: string | null;
  signedAdminSignaturePath?: string | null;
  createdByAdminId: number | null;
  /** Lineage back-pointers (migration 130). Used by the detail page to
   *  render "Linked quote" + "Linked invoices" panels. Null when the
   *  contract was created standalone or when the DB lineage columns
   *  haven't migrated yet. */
  sourceQuoteId?: number | null;
  convertedEventId?: number | null;
  createdAt: string;
  updatedAt: string;
  inclusions?: ContractBlockInclusion[];
}

export type ContractDetail = ContractSummary & {
  inclusions: ContractBlockInclusion[];
};

export interface ContractListResponse {
  contracts: ContractSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ContractCreatePayload {
  customerAccountId: number;
  language?: string;
  title?: string | null;
  /** Event snapshot fields — same shape as the quote editor. */
  eventName?: string | null;
  eventDate?: string | null;
  eventTimeStart?: string | null;
  eventTimeEnd?: string | null;
  introText?: string | null;
  outroText?: string | null;
  issueDate?: string;
  validUntil?: string;
  /** Migration 121 — optional link to a Project Overview project. */
  projectId?: number | null;
}

export interface ContractUpdatePayload {
  title?: string | null;
  eventName?: string | null;
  eventDate?: string | null;
  eventTimeStart?: string | null;
  eventTimeEnd?: string | null;
  introText?: string | null;
  outroText?: string | null;
  language?: string;
  issueDate?: string;
  validUntil?: string;
  /** Full list of inclusions to write. Server rewrites the inclusion
   *  rows from this payload — caller controls inclusion + per-section
   *  order via the position field. Omit to leave inclusions untouched. */
  blocks?: Array<{ blockId: number; included?: boolean; position?: number }>;
  /** Migration 121 — optional Project Overview link. null clears it. */
  projectId?: number | null;
}

export interface ContractBlockCreatePayload {
  section: ContractBlockSection;
  name: string;
  bodyText: string;
  bodyTextDe?: string | null;
  bodyTextRu?: string | null;
  bodyTextPt?: string | null;
  bodyTextNl?: string | null;
  bodyTextFr?: string | null;
  description?: string | null;
  displayOrder?: number;
  isActive?: boolean;
}

export type ContractBlockUpdatePayload = Partial<ContractBlockCreatePayload>;

export const contractsService = {
  async list(params: {
    status?: ContractStatus[];
    customerAccountId?: number;
    q?: string;
    sort?: ContractSort;
    page?: number;
    pageSize?: number;
  } = {}): Promise<ContractListResponse> {
    const { data } = await api.get('/admin/contracts', {
      params: { ...params, status: params.status?.join(',') },
    });
    return data.data || data;
  },

  async get(id: number): Promise<{ contract: ContractDetail }> {
    const { data } = await api.get(`/admin/contracts/${id}`);
    return data.data || data;
  },

  async create(payload: ContractCreatePayload): Promise<{ contract: ContractDetail }> {
    const { data } = await api.post('/admin/contracts', payload);
    return data.data || data;
  },

  async update(id: number, payload: ContractUpdatePayload): Promise<{ contract: ContractDetail }> {
    const { data } = await api.put(`/admin/contracts/${id}`, payload);
    return data.data || data;
  },

  async send(id: number): Promise<{ token: string; pdfPath: string | null }> {
    const { data } = await api.post(`/admin/contracts/${id}/send`);
    return data.data || data;
  },

  async cancel(id: number): Promise<{ status: 'cancelled' }> {
    const { data } = await api.post(`/admin/contracts/${id}/cancel`);
    return data.data || data;
  },

  /** Convert a fully-signed contract into an event + scheduled invoices.
   *  Requires source_quote_id (no line items otherwise). Idempotent — if
   *  the contract already has converted_event_id set the same event id
   *  comes back with alreadyConverted: true. */
  async convertToEvent(id: number): Promise<{ eventId: number; alreadyConverted: boolean }> {
    const { data } = await api.post(`/admin/contracts/${id}/convert-to-event`);
    return data.data || data;
  },

  /** Convert a fully-signed contract directly into invoice(s) — no event. */
  async convertToInvoice(id: number): Promise<{ installmentsCreated: number }> {
    const { data } = await api.post(`/admin/contracts/${id}/convert-to-invoice`);
    return data.data || data;
  },

  /** Re-render the signed PDF (system-render path only — wet-signed
   *  uploads are preserved) and resend the contract_fully_signed
   *  email to both parties. Recovery action for contracts where the
   *  initial dual-party send failed silently. */
  async resendSigned(id: number): Promise<{ signedPdfPath: string; resent: true }> {
    const { data } = await api.post(`/admin/contracts/${id}/resend-signed`);
    return data.data || data;
  },

  /** Re-stamp one or both signature images on a contract whose
   *  original sign happened before the canvas worked correctly.
   *  Either dataUrl may be null/omitted — the corresponding image
   *  is then left untouched. Always re-renders + persists the PDF. */
  async restampSignatures(
    id: number,
    payload: { customerSignatureDataUrl?: string | null; adminSignatureDataUrl?: string | null },
  ): Promise<{ signedPdfPath: string; stamped: { customer: boolean; admin: boolean } }> {
    const { data } = await api.post(`/admin/contracts/${id}/restamp-signatures`, payload);
    return data.data || data;
  },

  async countersign(
    id: number,
    payload: { name: string; signatureDataUrl?: string | null },
  ): Promise<{ status: ContractStatus; signedAt: string }> {
    const { data } = await api.post(`/admin/contracts/${id}/countersign`, payload);
    return data.data || data;
  },

  async uploadSignedPdf(id: number, file: File): Promise<{ status: 'fully_signed'; signedPdfPath: string }> {
    const form = new FormData();
    form.append('file', file);
    const { data } = await api.post(`/admin/contracts/${id}/upload-signed-pdf`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data.data || data;
  },

  async pdfUrl(id: number): Promise<string> {
    const res = await api.get(`/admin/contracts/${id}/pdf`, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },

  async signedPdfUrl(id: number): Promise<string> {
    const res = await api.get(`/admin/contracts/${id}/signed-pdf`, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },

  async previewPdfUrl(id: number): Promise<string> {
    const res = await api.get(`/admin/contracts/${id}/preview`, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },

  /** Audit trail — chronological activity_logs entries for this
   *  contract. Renders the timeline on the detail page so the admin
   *  has a single-pane view of every event (sent, signed, counter-
   *  signed, resent emails, conversions). */
  async auditTrail(id: number): Promise<{ entries: AuditEntry[] }> {
    const { data } = await api.get(`/admin/contracts/${id}/audit-trail`);
    return data.data || data;
  },

  /** Integrity check — re-hashes the unsigned + signed PDF on disk
   *  and compares each to the stored SHA-256 column from migration
   *  131. Used by the IntegrityCheckCard on ContractDetailPage; the
   *  admin clicks once to confirm no backup-corruption / manual edit
   *  has altered the document since it was issued. */
  async verifyIntegrity(id: number): Promise<ContractIntegrityResult> {
    const { data } = await api.get(`/admin/contracts/${id}/verify-integrity`);
    return data.data || data;
  },

  // ----- Block library -------------------------------------------------
  async listBlocks(params: { section?: ContractBlockSection; includeInactive?: boolean } = {}): Promise<{ blocks: ContractBlock[] }> {
    const { data } = await api.get('/admin/contracts/blocks', { params });
    return data.data || data;
  },

  async createBlock(payload: ContractBlockCreatePayload): Promise<{ block: ContractBlock }> {
    const { data } = await api.post('/admin/contracts/blocks', payload);
    return data.data || data;
  },

  async updateBlock(id: number, payload: ContractBlockUpdatePayload): Promise<{ block: ContractBlock }> {
    const { data } = await api.put(`/admin/contracts/blocks/${id}`, payload);
    return data.data || data;
  },

  async deleteBlock(id: number): Promise<{ ok: true }> {
    const { data } = await api.delete(`/admin/contracts/blocks/${id}`);
    return data.data || data;
  },
};

// ===================================================================
// Public client — used by ContractResponsePage (no auth, token-based).
// ===================================================================

export interface PublicContractView {
  contractNumber: string;
  status: ContractStatus;
  language: string;
  issueDate: string;
  validUntil: string | null;
  title: string | null;
  introText: string | null;
  outroText: string | null;
  sentAt: string | null;
  signedByCustomerAt: string | null;
  signedByAdminAt: string | null;
  signedCustomerName: string | null;
  signedAdminName: string | null;
  /** Customer IP at signing — surfaced to the customer so they can
   *  verify what we recorded about THEM. Admin's counter-sign IP is
   *  intentionally NOT in this shape; it's the operator's identifier
   *  and not part of the customer's audit surface. */
  signedCustomerIp?: string | null;
  hasSignedPdf: boolean;
  /** SHA-256 hashes of the on-disk PDFs — shown in the audit
   *  confirmation so the customer can re-hash their copy. */
  pdfSha256?: string | null;
  signedPdfSha256?: string | null;
  canSign: boolean;
  sections: Array<{
    section: ContractBlockSection;
    blocks: Array<{
      blockId: number;
      section: ContractBlockSection;
      position: number;
      name: string;
      body: string;
    }>;
  }>;
  recipient: {
    displayName: string;
    companyName: string | null;
    email: string;
  } | null;
  issuer: {
    companyName: string | null;
    addressLine1: string | null;
    postalCode: string | null;
    city: string | null;
    email: string | null;
    website: string | null;
    /** Light + dark branding logo URLs; the page picks per its colour mode. */
    logoUrl?: string | null;
    logoUrlDark?: string | null;
  } | null;
  /** Admin-set behaviour flags surfaced for the public sign page.
   *  Server re-enforces both — these only drive the UI. */
  allowPdfUpload?: boolean;
  requireDrawnSignature?: boolean;
}

export const publicContractsService = {
  async get(token: string): Promise<{ contract: PublicContractView }> {
    const { data } = await api.get(`/public/contracts/${token}`);
    return data.data || data;
  },

  async sign(token: string, payload: { name: string; signatureDataUrl?: string | null; accepted: true }): Promise<{ status: ContractStatus; signedAt: string }> {
    const { data } = await api.post(`/public/contracts/${token}/sign`, payload);
    return data.data || data;
  },

  async uploadSignedPdf(token: string, file: File): Promise<{ status: 'fully_signed'; signedPdfPath: string }> {
    const form = new FormData();
    form.append('file', file);
    const { data } = await api.post(`/public/contracts/${token}/upload-signed-pdf`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data.data || data;
  },
};
