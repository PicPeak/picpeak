/**
 * Admin → Contracts API client. Hits /api/admin/contracts/*.
 *
 * Mirrors bills.service.ts shape: `data.data || data` unwrap, blob
 * responses for PDFs via URL.createObjectURL.
 */
import { api } from '../config/api';
import type { AttachmentSelection, IncludedAttachment } from './documentAttachments.service';
import {
  decodeBlobErrorBody,
  documentAccessHeaders,
  type DocumentAccessGrant,
  type DocumentVerificationSent,
} from '../utils/documentAccess';

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

/** One item of the integrity report (#1446). `ok: null` = not checkable. */
export interface ContractIntegrityCheck {
  check: 'unsigned_pdf' | 'signed_pdf' | 'certificate' | 'signature_image' | 'content'
    | 'attachment' | 'manifest' | 'event_chain' | 'completed_artifact';
  subject: string | null;
  ok: boolean | null;
  expected: string | null;
  actual: string | null;
  note: string | null;
  brokenAt?: number | null;
}

export interface ContractIntegrityResult {
  unsigned: ContractIntegrityLeg;
  signed: ContractIntegrityLeg;
  /** The itemised report (#1446). */
  ok?: boolean;
  generatedAt?: string;
  checks?: ContractIntegrityCheck[];
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
  | 'declined'
  | 'cancelled'
  | 'expired'
  | 'awaiting_data';

// ----- Signatures v2 (#1446): signers and the signing log -------------

export type ContractSigningOrder = 'parallel' | 'sequential';
export type ContractSignerRole = 'customer' | 'issuer';
export type ContractSignerStatus = 'pending' | 'invited' | 'signed' | 'declined';

export interface ContractSigner {
  id: number;
  position: number;
  role: ContractSignerRole;
  slotKey: string;
  name: string | null;
  email: string | null;
  status: ContractSignerStatus;
  invitedAt: string | null;
  verifiedAt: string | null;
  verifiedVia: 'otp' | 'portal' | 'admin' | null;
  signedAt: string | null;
  declinedAt: string | null;
  signatureMode: 'drawn' | 'typed' | null;
  /** Reminders sent so far (#1446). */
  reminderCount?: number;
  remindedAt?: string | null;
}

/**
 * A signer an uploaded paper copy has to account for (#1446): everyone who
 * has neither signed in the browser nor declined.
 */
export interface PaperSignatureSigner {
  id: number;
  position: number;
  name: string | null;
  status: ContractSignerStatus;
}

export type ContractSigningEventType =
  | 'sent' | 'invited' | 'invitation_resent' | 'code_sent' | 'verified' | 'signed'
  | 'declined' | 'countersigned' | 'completed' | 'wet_upload' | 'revoked';

export interface ContractSigningEvent {
  seq: number;
  /** One of ContractSigningEventType; unknown types render their raw name. */
  type: string;
  actorType: 'admin' | 'signer' | 'system' | string;
  actorLabel: string | null;
  signerId: number | null;
  occurredAt: string;
  eventHash: string;
  artifactSha256: string | null;
}

/** Result of re-checking the hash chain of the signing log. */
export interface ContractSigningChain {
  ok: boolean;
  count: number;
  head: string | null;
  brokenAt: number | null;
  reason: string | null;
}

/** A follow-up step that failed: an invitation, a reminder, the freeze, or what follows a signature.
 *  Only the step and a safe code: the error's text stays in the server log. */
export interface ContractSigningFollowUp {
  failedAt: string;
  step: string | null;
  code: string | null;
}

export interface ContractSignersOverview {
  /** 2 for signatures v2; null for a contract sent before (single link). */
  version: 2 | null;
  order: ContractSigningOrder;
  signers: ContractSigner[];
  events: ContractSigningEvent[];
  chain: ContractSigningChain | null;
  /** Set while a step after a signature is still outstanding. */
  followUp?: ContractSigningFollowUp | null;
}

export interface ContractSignersPayload {
  order?: ContractSigningOrder;
  /** 1–5 customer signers; the issuer is added automatically. */
  signers: Array<{ name: string; email: string }>;
}

/** Decrypted evidence for one signer — every opening is logged. */
export interface ContractSignerEvidence {
  signerId: number;
  name: string | null;
  ip: string | null;
  userAgent: string | null;
  declineReason: string | null;
  signatureSha256: string | null;
  documentSha256: string | null;
}

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

/** A text per language (#1445): clause overrides and free-text sections. */
export type ContractLocaleText = Partial<Record<'de' | 'en' | 'fr' | 'nl' | 'pt' | 'ru', string>>;

/** A free-text section on a contract (from its template). */
export interface ContractTextSection {
  id: number;
  section: ContractBlockSection;
  position: number;
  heading: string | null;
  body: ContractLocaleText;
}

/** A PDF generated for a contract: unsigned, signed, audit certificate… */
/** One attachment as it went into a generated PDF, from its manifest (#1445). */
export interface ContractDocumentAttachment {
  attachmentId: number;
  name: string;
  sha256: string;
  delivery: 'merged' | 'separate';
  pages: number;
  /** 1-based page the merged attachment starts on; absent when separate. */
  firstPage?: number;
}

export interface ContractGeneratedDocument {
  id: number;
  kind: 'unsigned' | 'signed' | 'audit' | 'wet_upload' | string;
  sha256: string;
  bytes: number;
  pages: number | null;
  templateVersionId: number | null;
  rendererVersion: string | null;
  parentId: number | null;
  /**
   * What the PDF was made of: its attachments with their own checksums, and
   * where the signature page sits. Null for documents recorded without one.
   */
  manifest: {
    attachments?: ContractDocumentAttachment[];
    signaturePage?: number | null;
    slots?: Array<{ key: string; page: number }>;
  } | null;
  generatedAt: string;
}

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
  /** Every frozen language, and this contract's own text (#1445). */
  snapshot?: ContractLocaleText;
  bodyOverride?: ContractLocaleText;
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
  /** The template and version the contract was made from (#1445). */
  templateId?: number | null;
  templateVersionId?: number | null;
  templateName?: string | null;
  templateVersion?: number | null;
  /** Optimistic lock: send it back on update. */
  lockVersion?: number;
  /** sha256 of the content frozen at send. */
  renderedContentSha256?: string | null;
  /** PDFs sent with the contract (#1445), in order. */
  attachments?: IncludedAttachment[];
  /** List rows only: how far the customer signers have got (#1446). */
  signerProgress?: { signed: number; total: number } | null;
  /** Drafts: whether {{customer_address}} would print empty (#1446). */
  customerAddressMissing?: boolean;
  /** When the customer supplied their details (collect-then-freeze, #1446). */
  dataCollectedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  inclusions?: ContractBlockInclusion[];
}

export type ContractDetail = ContractSummary & {
  inclusions: ContractBlockInclusion[];
  textSections?: ContractTextSection[];
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
  /** Initial inclusions, written in the same transaction as the contract.
   *  Omit to start from a template version (the default one when
   *  templateVersionId is omitted too). */
  blocks?: Array<{ blockId: number; included?: boolean; position?: number }>;
  /** A published template version to start from (#1445). */
  templateVersionId?: number;
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
  /** The lockVersion the editor loaded; a newer save gets 409 (#1445). */
  lockVersion?: number;
  /** The full attachment list; omit to leave it unchanged (#1445). */
  attachments?: AttachmentSelection[];
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

  /**
   * `idempotencyKey` makes a retry safe: the server answers a key it has
   * already seen with the draft that key created (`replayed: true`) instead
   * of creating a second one. Reuse the key until a create succeeds.
   */
  async create(
    payload: ContractCreatePayload,
    options: { idempotencyKey?: string } = {},
  ): Promise<{ contract: ContractDetail; replayed?: boolean }> {
    const { data } = await api.post(
      '/admin/contracts',
      payload,
      options.idempotencyKey ? { headers: { 'Idempotency-Key': options.idempotencyKey } } : undefined,
    );
    return data.data || data;
  },

  async update(id: number, payload: ContractUpdatePayload): Promise<{ contract: ContractDetail }> {
    const { data } = await api.put(`/admin/contracts/${id}`, payload);
    return data.data || data;
  },

  /** What a send would freeze and deliver, and what stands in its way (read-only). */
  async sendPreview(id: number): Promise<ContractSendPreview> {
    const { data } = await api.get(`/admin/contracts/${id}/send-preview`);
    return data.data || data;
  },

  /** `reviewToken`: the pre-send review's; the send is refused if the contract changed since.
   *  `collectData` (#1446): ask the customer for their details first; the
   *  contract is frozen and sent once they have. */
  async send(
    id: number,
    options: { reviewToken?: string; collectData?: boolean } = {},
  ): Promise<{ token: string; pdfPath: string | null; invitationFailed?: boolean }> {
    const payload = {
      ...(options.reviewToken ? { reviewToken: options.reviewToken } : {}),
      ...(options.collectData ? { collectData: true } : {}),
    };
    const { data } = await api.post(`/admin/contracts/${id}/send`, Object.keys(payload).length ? payload : undefined);
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

  /** `mode` is read for signatures-v2 contracts (drawn or typed). */
  async countersign(
    id: number,
    payload: { name: string; signatureDataUrl?: string | null; mode?: 'drawn' | 'typed' },
  ): Promise<{ status: ContractStatus; signedAt: string }> {
    const { data } = await api.post(`/admin/contracts/${id}/countersign`, payload);
    return data.data || data;
  },

  /** Signers, the signing log and its chain check (#1446). */
  async signers(id: number): Promise<ContractSignersOverview> {
    const { data } = await api.get(`/admin/contracts/${id}/signers`);
    return data.data || data;
  },

  /** Replace a draft's customer signers and signing order. */
  async setSigners(id: number, payload: ContractSignersPayload): Promise<ContractSignersOverview> {
    const { data } = await api.put(`/admin/contracts/${id}/signers`, payload);
    return data.data || data;
  },

  /** A new link for one signer; the previous link stops working. */
  async resendSignerLink(id: number, signerId: number): Promise<{ resent: true }> {
    const { data } = await api.post(`/admin/contracts/${id}/signers/${signerId}/resend`);
    return data.data || data;
  },

  /** A reminder with a new link (#1446) — the same path the reminder ladder takes. */
  async remindSigner(id: number, signerId: number): Promise<{ reminded: true; step: number }> {
    const { data } = await api.post(`/admin/contracts/${id}/signers/${signerId}/remind`);
    return data.data || data;
  },

  /** IP address, user agent and decline reasons, decrypted. Logged on every call. */
  async signingEvidence(id: number): Promise<{ evidence: ContractSignerEvidence[] }> {
    const { data } = await api.get(`/admin/contracts/${id}/signing-evidence`);
    return data.data || data;
  },

  /**
   * The customer signers a paper copy would have to account for (#1446):
   * everyone who has neither signed in the browser nor declined.
   * `electronicSignaturePresent` means someone already signed in the browser,
   * and the server refuses the upload (ELECTRONIC_SIGNATURE_PRESENT).
   */
  async paperSignatureCoverage(id: number): Promise<{ signers: PaperSignatureSigner[]; electronicSignaturePresent: boolean }> {
    const { data } = await api.get(`/admin/contracts/${id}/paper-signature-coverage`);
    return data.data || data;
  },

  /**
   * `coversSignerIds` states which signers the paper copy carries. The upload
   * completes the contract for all of them, so the server refuses it unless
   * every signer still awaiting a signature is named.
   */
  async uploadSignedPdf(
    id: number,
    file: File,
    coversSignerIds: number[] = [],
  ): Promise<{ status: 'fully_signed'; signedPdfPath: string }> {
    const form = new FormData();
    form.append('file', file);
    if (coversSignerIds.length) form.append('coversSignerIds', JSON.stringify(coversSignerIds));
    const { data } = await api.post(`/admin/contracts/${id}/upload-signed-pdf`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data.data || data;
  },

  /** The integrity report as a one-page PDF (#1446). */
  async integrityReportUrl(id: number): Promise<string> {
    const res = await api.get(`/admin/contracts/${id}/verify-integrity`, { params: { format: 'pdf' }, responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },

  /** The signing certificate, once the contract has one. */
  async certificateUrl(id: number): Promise<string> {
    const res = await api.get(`/admin/contracts/${id}/certificate`, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
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
  /** The PDFs generated for a contract (#1445): kind, checksum, size, pages. */
  async documents(id: number): Promise<{ documents: ContractGeneratedDocument[] }> {
    const { data } = await api.get(`/admin/contracts/${id}/documents`);
    return data.data || data;
  },

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
  /** The full view is only served to a verified visitor (or the portal). */
  verificationRequired?: false;
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
  /**
   * The account holder's block. On a signer session it is trimmed to the
   * display name for anyone who is not that customer (#1446): the address a
   * co-signer verifies with is their authentication data, not the other
   * signers'.
   */
  recipient: {
    displayName: string;
    companyName: string | null;
    email: string | null;
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
  /** Attachments (#1445): merged ones are inside the PDF, separate ones
   *  download on their own. */
  attachments?: Array<{ id: number; name: string; delivery: 'merged' | 'separate'; pages: number }>;
  /**
   * The line items and totals frozen into the contract when it was sent
   * (#1445) — the figures the content hash covers, and so the ones the
   * signature is bound to. Null for a contract sent before they were
   * frozen, and for one with no source quote.
   */
  commercial?: {
    sourceQuoteNumber: string | null;
    currency: string;
    lineItems: Array<{
      position: number;
      parentPosition: number | null;
      kind: string;
      description: string;
      details: string | null;
      unit: string | null;
      quantity: number;
      unitPriceMinor: number;
      discountPercent: number;
      lineTotalMinor: number;
    }>;
    totals: {
      netMinor: number;
      vatRatePercent: number;
      vatMinor: number;
      shippingMinor: number;
      grossMinor: number;
    };
  } | null;
}

/** The parts of a contract the shared ContractBody shows (signing page, review, template preview). */
export type ContractBodyContent = Pick<PublicContractView,
  'title' | 'contractNumber' | 'language' | 'recipient' | 'introText' | 'outroText' | 'sections' | 'commercial'>;

/** The pre-send review of a draft (#1445): GET /admin/contracts/:id/send-preview. */
export interface ContractSendPreview {
  content: ContractBodyContent;
  signingOrder: 'parallel' | 'sequential';
  signers: Array<{ position: number; role: 'customer' | 'issuer'; name: string | null; email: string | null }>;
  attachments: Array<{
    attachmentId: number; name: string; delivery: 'merged' | 'separate'; pages: number; sha256: string; ok: boolean;
  }>;
  totals: (NonNullable<PublicContractView['commercial']>['totals'] & { currency: string }) | null;
  template: { id: number; name: string; version: number } | null;
  problems: Array<{ code: string; severity: 'error' | 'warning'; message: string; attachmentId?: number; keys?: string[] }>;
  /** What was reviewed; sending with it is refused if the contract changed since. */
  reviewToken: string;
  lockVersion: number;
}

/**
 * What the emailed link returns before the visitor has confirmed the one-time
 * code: the issuer's branding and a masked recipient address, nothing about
 * the customer or the contract.
 */
export interface PublicContractShell {
  verificationRequired: true;
  language: string;
  emailHint: string | null;
  issuer: {
    companyName: string | null;
    logoUrl?: string | null;
    logoUrlDark?: string | null;
  } | null;
}

/**
 * Public signing link. Every request after verification carries the access
 * grant from confirmVerification as the X-Document-Access header.
 */
export const publicContractsService = {
  async get(token: string, grant?: string | null): Promise<{ contract: PublicContractView | PublicContractShell }> {
    const { data } = await api.get(`/public/contracts/${token}`, { headers: documentAccessHeaders(grant) });
    return data.data || data;
  },

  /** Email a one-time code to the customer's address on file. */
  async requestVerification(token: string): Promise<DocumentVerificationSent> {
    const { data } = await api.post(`/public/contracts/${token}/verification`);
    return data.data || data;
  },

  /** Exchange the emailed code for a short-lived access grant. */
  async confirmVerification(token: string, code: string): Promise<DocumentAccessGrant> {
    const { data } = await api.post(`/public/contracts/${token}/verification/confirm`, { code });
    return data.data || data;
  },

  async sign(
    token: string,
    payload: { name: string; signatureDataUrl?: string | null; accepted: true },
    grant?: string | null,
  ): Promise<{ status: ContractStatus; signedAt: string }> {
    const { data } = await api.post(`/public/contracts/${token}/sign`, payload, { headers: documentAccessHeaders(grant) });
    return data.data || data;
  },

  async uploadSignedPdf(token: string, file: File, grant?: string | null): Promise<{ status: 'fully_signed'; signedPdfPath: string }> {
    const form = new FormData();
    form.append('file', file);
    const { data } = await api.post(`/public/contracts/${token}/upload-signed-pdf`, form, {
      headers: { 'Content-Type': 'multipart/form-data', ...documentAccessHeaders(grant) },
    });
    return data.data || data;
  },

  /** Blob URL of the PDF; it needs the grant header, so it can't be a plain link. */
  async pdfUrl(token: string, grant?: string | null): Promise<string> {
    try {
      const res = await api.get(`/public/contracts/${token}/pdf`, {
        responseType: 'blob',
        headers: documentAccessHeaders(grant),
      });
      return URL.createObjectURL(res.data);
    } catch (err) {
      // So the page can tell a grant that ran out from any other failure.
      await decodeBlobErrorBody(err);
      throw err;
    }
  },
};
