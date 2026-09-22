/**
 * Customer-side API client (#354).
 *
 * Strictly separate from authService.adminLogin / galleryService — uses
 * the /api/customer/* surface and the customer_token cookie. Never falls
 * back to admin endpoints.
 */
import type { AxiosProgressEvent } from 'axios';
import { api } from '../config/api';
import type { ContractStatus, PublicContractView } from './contracts.service';
import type { PublicQuoteView, QuoteStatus } from './quotes.service';

export interface CustomerProfile {
  id: number;
  email: string;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  preferredLanguage: string;
}

/**
 * Effective customer features (global flag AND the per-customer override),
 * as returned by /customer/auth/login and /customer/auth/session.
 */
export interface CustomerFeatures {
  calendar: boolean;
  quotes: boolean;
  bills: boolean;
  contracts: boolean;
  documents: boolean;
}

export const DEFAULT_CUSTOMER_FEATURES: CustomerFeatures = {
  calendar: false, quotes: false, bills: false, contracts: false, documents: false,
};

export interface CustomerBranding {
  showLogo: boolean;
  showCompanyName: boolean;
}

/**
 * Full self-service profile shape — superset of CustomerProfile (which is
 * the narrow auth-payload version). Used by the profile page and the
 * accept-invite form.
 */
export interface CustomerProfileFull extends CustomerProfile {
  salutation: string | null;
  phone: string | null;
  companyName: string | null;
  vatId: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  state: string | null;
  countryCode: string | null;
}

/** Subset of profile fields the admin can pre-fill on an invitation
 *  and that the customer can edit on accept. */
export interface CustomerProfilePrefill {
  salutation?: string;
  first_name?: string;
  last_name?: string;
  display_name?: string;
  phone?: string;
  company_name?: string;
  vat_id?: string;
  address_line1?: string;
  address_line2?: string;
  postal_code?: string;
  city?: string;
  state?: string;
  country_code?: string;
}

/** Gallery state, decided by the server (#1444). */
export type GalleryAvailability = 'active' | 'expired' | 'unavailable';

export interface CustomerEvent {
  id: number;
  slug: string;
  eventName: string;
  eventType: string;
  eventDate: string | null;
  expiresAt: string | null;
  isActive: boolean;
  assignedAt: string | null;
  availability: GalleryAvailability;
}

export interface CustomerInvitationInfo {
  email: string;
  expiresAt: string;
  invitedBy: string | null;
  /** Admin-supplied prefill — populates the accept-invite profile form. */
  prefill: CustomerProfilePrefill | null;
}

export interface CustomerProfileUpdate {
  salutation?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  phone?: string | null;
  companyName?: string | null;
  vatId?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  state?: string | null;
  countryCode?: string | null;
  preferredLanguage?: string;
}

export interface CustomerAccessTokenResponse {
  token: string;
  event: { id: number; slug: string; eventName: string };
}

// ---- documents + dashboard (#1444) ----

export type CustomerDocumentStatus = 'pending' | 'clean' | 'rejected';

export interface CustomerDocument {
  id: number;
  name: string;
  sizeBytes: number;
  /** `you` = the customer's own upload, `studio` = shared by the photographer. */
  uploadedBy: 'you' | 'studio';
  status: CustomerDocumentStatus;
  downloadable: boolean;
  rejectionReason: string | null;
  eventId: number | null;
  eventName: string | null;
  /** For a link to the event page; the page itself re-checks access. */
  eventSlug?: string | null;
  contractId: number | null;
  createdAt: string | null;
  sharedAt: string | null;
  /** When the studio reviewed the customer's own upload. */
  reviewedAt?: string | null;
  /** Own upload that isn't part of a contract: the customer may delete it. */
  canDelete?: boolean;
}

/** A document the studio asked for and is still waiting on (#1444). */
export interface CustomerDocumentRequest {
  id: number;
  title: string;
  note: string | null;
  dueAt: string | null;
  status: 'open';
  eventId: number | null;
  createdAt: string | null;
}

export interface CustomerDocumentLimits {
  maxUploadBytes: number;
  quotaBytes: number;
  usedBytes: number;
}

export interface CustomerDashboard {
  needsAction: {
    quotes: Array<{
      id: number; quoteNumber: string; eventName: string | null; validUntil: string | null;
      sentAt: string | null; totalAmountMinor: number; currency: string;
    }>;
    contracts: Array<{
      id: number; contractNumber: string; title: string | null; eventName: string | null;
      validUntil: string | null; sentAt: string | null;
    }>;
    invoices: Array<{
      id: number; invoiceNumber: string; status: string; dueDate: string | null; overdue: boolean;
      eventName: string | null; totalAmountMinor: number; openAmountMinor: number; currency: string;
    }>;
    /** The customer's own rejected uploads — upload a corrected one, or delete it. */
    documents?: Array<{ id: number; name: string; reviewNote: string | null }>;
    /** Documents the studio asked for; `link` preselects the request on the upload. */
    documentRequests?: Array<{ id: number; title: string; note: string | null; dueAt: string | null; link: string }>;
  };
  /** Newest first, from the same visibility rules as the lists they link to. */
  recent?: CustomerRecentItem[];
  galleries: { active: CustomerEvent[]; expired: CustomerEvent[] };
}

export type CustomerRecentKind =
  | 'document_shared' | 'document_uploaded' | 'document_accepted' | 'document_rejected'
  | 'contract_sent' | 'contract_signed' | 'quote_sent' | 'invoice_sent' | 'gallery_assigned';

export interface CustomerRecentItem {
  kind: CustomerRecentKind;
  id: number;
  title: string;
  at: string;
  /** A portal path. */
  link: string;
}

export interface CustomerEventOverview {
  event: CustomerEvent;
  sections: { quotes: boolean; contracts: boolean; invoices: boolean; documents: boolean };
  quotes: Array<{
    id: number; quoteNumber: string; status: CustomerQuote['status']; issueDate: string | null;
    validUntil: string | null; totalAmountMinor: number; currency: string;
  }>;
  contracts: Array<{
    id: number; contractNumber: string; status: CustomerContract['status']; title: string | null;
    issueDate: string | null; hasPdf: boolean; hasSignedPdf: boolean;
  }>;
  invoices: Array<{
    id: number; kind: 'invoice' | 'storno'; invoiceNumber: string; status: CustomerInvoice['status'];
    issueDate: string | null; dueDate: string | null; totalAmountMinor: number; paidAmountMinor: number; currency: string;
  }>;
  documents: CustomerDocument[];
}

export interface UploadOptions {
  eventId?: number | null;
  /** Answers a document request; the server marks it fulfilled with the upload. */
  requestId?: number | null;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/** Save a blob under a filename via a temporary link. */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const customerService = {
  // ---- auth ----
  async login(email: string, password: string, recaptchaToken?: string | null): Promise<{
    customer: CustomerProfile;
    features: CustomerFeatures;
    branding: CustomerBranding;
  }> {
    const response = await api.post<{
      customer: CustomerProfile;
      features?: Partial<CustomerFeatures>;
      branding?: CustomerBranding;
    }>(
      '/customer/auth/login',
      { email, password, recaptchaToken }
    );
    // Backwards-compat fallbacks for older backends that haven't been
    // upgraded yet — defaults match CustomerAuthContext's DEFAULT_*.
    return {
      customer: response.data.customer,
      features: { ...DEFAULT_CUSTOMER_FEATURES, ...(response.data.features || {}) },
      branding: response.data.branding || { showLogo: true, showCompanyName: true },
    };
  },

  async logout(): Promise<void> {
    try {
      await api.post('/customer/auth/logout');
    } catch (e) {
      // Logout is best-effort — the cookie clear is what matters and
      // the backend always clears it even on error.
    }
  },

  /**
   * Resolve the current customer session.
   *
   * Return contract:
   *   - object  → fresh customer + features + branding from the server.
   *   - null    → backend says we are NOT authenticated (401). The
   *               caller should clear local state and bounce to login.
   *   - throws  → any other error (network blip, 5xx, timeout, 410
   *               from a feature-flag flip mid-flight). The caller
   *               should KEEP whatever state it has — punishing the
   *               user with a logout for a transient failure is the
   *               wrong default. Previously this catch swallowed
   *               everything and returned null, which logged the
   *               customer out on the slightest server hiccup
   *               (including the brief window while the admin saves
   *               an unrelated change like gallery assignments).
   */
  async session(): Promise<{
    customer: CustomerProfile;
    features: CustomerFeatures;
    branding: CustomerBranding;
  } | null> {
    try {
      const response = await api.get<{
        customer: CustomerProfile;
        features?: Partial<CustomerFeatures>;
        branding?: CustomerBranding;
      }>('/customer/auth/session');
      return {
        customer: response.data.customer,
        features: { ...DEFAULT_CUSTOMER_FEATURES, ...(response.data.features || {}) },
        branding: response.data.branding || { showLogo: true, showCompanyName: true },
      };
    } catch (error: any) {
      // Only treat an explicit 401 as "session is gone". Anything else
      // (network failure, server 500, etc.) is a transient problem
      // and should not log the customer out.
      if (error?.response?.status === 401) {
        return null;
      }
      throw error;
    }
  },

  /**
   * Look up a password-reset token without consuming it. Lets the reset
   * page render "you're resetting the password for {{email}}" before
   * the customer submits.
   */
  async getPasswordReset(token: string): Promise<{ email: string; expiresAt: string }> {
    const response = await api.get<{ reset: { email: string; expiresAt: string } }>(
      `/customer/auth/password-reset/${encodeURIComponent(token)}`,
    );
    return response.data.reset;
  },

  /** Apply a password reset (token + new password). */
  async applyPasswordReset(token: string, password: string): Promise<{ email: string }> {
    const response = await api.post<{ email: string }>(
      '/customer/auth/password-reset',
      { token, password },
    );
    return response.data;
  },

  // ---- invitations ----
  async getInvitation(token: string): Promise<CustomerInvitationInfo> {
    const response = await api.get<{ invitation: CustomerInvitationInfo }>(
      `/customer/auth/invite/${encodeURIComponent(token)}`
    );
    return response.data.invitation;
  },

  async acceptInvitation(
    token: string,
    name: string,
    password: string,
    profile?: CustomerProfilePrefill,
  ): Promise<{ email: string }> {
    const response = await api.post<{ email: string }>(
      '/customer/auth/accept-invite',
      { token, name, password, profile },
    );
    return response.data;
  },

  // ---- profile (self-service) ----
  async getProfile(): Promise<CustomerProfileFull> {
    const response = await api.get<{ profile: CustomerProfileFull }>('/customer/profile');
    return response.data.profile;
  },

  async updateProfile(payload: CustomerProfileUpdate): Promise<CustomerProfileFull> {
    const response = await api.put<{ profile: CustomerProfileFull }>('/customer/profile', payload);
    return response.data.profile;
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await api.post('/customer/profile/password', { currentPassword, newPassword });
  },

  // ---- dashboard ----
  async listEvents(): Promise<CustomerEvent[]> {
    const response = await api.get<{ events: CustomerEvent[] }>('/customer/events');
    return response.data.events;
  },

  /** Needs-action items and galleries split into active / expired (#1444). */
  async getDashboard(): Promise<CustomerDashboard> {
    const response = await api.get<CustomerDashboard>('/customer/dashboard');
    return response.data;
  },

  /** Everything the customer has for one event (#1444). */
  async getEventOverview(slug: string): Promise<CustomerEventOverview> {
    const response = await api.get<CustomerEventOverview>(
      `/customer/events/${encodeURIComponent(slug)}/overview`
    );
    return response.data;
  },

  /**
   * Exchange the customer JWT for a gallery JWT scoped to one event.
   * The dashboard calls this on card-click and stores the resulting
   * token in the slug-specific gallery cookie via storeGalleryToken().
   */
  async getEventAccessToken(slug: string): Promise<CustomerAccessTokenResponse> {
    const response = await api.get<CustomerAccessTokenResponse>(
      `/customer/events/${encodeURIComponent(slug)}/access-token`
    );
    return response.data;
  },

  // ---- documents (#1444) ----
  async listDocuments(): Promise<{
    documents: CustomerDocument[]; limits: CustomerDocumentLimits; allowedFormats?: string[];
  }> {
    const response = await api.get<{
      documents: CustomerDocument[]; limits: CustomerDocumentLimits; allowedFormats?: string[];
    }>('/customer/documents');
    return response.data;
  },

  async uploadDocument(file: File, options: UploadOptions = {}): Promise<CustomerDocument> {
    const form = new FormData();
    form.append('file', file);
    if (options.eventId) form.append('eventId', String(options.eventId));
    if (options.requestId) form.append('requestId', String(options.requestId));
    const response = await api.post<{ document: CustomerDocument }>('/customer/documents', form, {
      signal: options.signal,
      onUploadProgress: (e: AxiosProgressEvent) => {
        if (options.onProgress && e.total) options.onProgress(e.loaded / e.total);
      },
    });
    return response.data.document;
  },

  /**
   * One document (the document page / a deep link). A document the customer
   * can no longer see rejects with 410 and a code — DOCUMENT_UNSHARED or
   * DOCUMENT_REMOVED — and an unknown one with 404.
   */
  async getDocument(id: number): Promise<CustomerDocument> {
    const response = await api.get<{ document: CustomerDocument }>(`/customer/documents/${id}`);
    return response.data.document;
  },

  async listDocumentRequests(): Promise<CustomerDocumentRequest[]> {
    const response = await api.get<{ requests: CustomerDocumentRequest[] }>('/customer/document-requests');
    return response.data.requests;
  },

  /** Deletes one of the customer's own uploads. */
  async deleteDocument(id: number): Promise<void> {
    await api.delete(`/customer/documents/${id}`);
  },

  /** Downloads the document as an attachment (never opened inline). */
  async downloadDocument(doc: Pick<CustomerDocument, 'id' | 'name'>): Promise<void> {
    const res = await api.get(`/customer/documents/${doc.id}/download`, { responseType: 'blob' });
    saveBlob(res.data, doc.name);
  },

  // ---- CRM (customer-side, read-only) ----
  async listQuotes(): Promise<CustomerQuote[]> {
    const response = await api.get<{ quotes: CustomerQuote[] }>('/customer/quotes');
    return response.data.quotes;
  },

  async listInvoices(): Promise<CustomerInvoice[]> {
    const response = await api.get<{ invoices: CustomerInvoice[] }>('/customer/invoices');
    return response.data.invoices;
  },

  /** Returns a blob URL ready for window.open(). */
  async invoicePdfUrl(id: number): Promise<string> {
    const res = await api.get(`/customer/invoices/${id}/pdf`, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },

  /** Returns a blob URL for the quote PDF (customer-side). */
  async quotePdfUrl(id: number): Promise<string> {
    const res = await api.get(`/customer/quotes/${id}/pdf`, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },

  /** Full quote view for the portal response page. Session-authenticated:
   *  the portal never handles the emailed response token. */
  async getQuote(id: number): Promise<{ quote: PublicQuoteView; canRespond: boolean }> {
    const { data } = await api.get(`/customer/quotes/${id}`);
    return data.data || data;
  },

  async respondToQuote(
    id: number,
    action: 'accept' | 'decline',
    // `expectedTotalMinor` is the total the page showed. A quote that offers
    // add-ons is accepted with its stored choice, and the server refuses a
    // total that no longer matches.
    options: { tosAccepted?: boolean; expectedTotalMinor?: number } = {},
  ): Promise<{ status: QuoteStatus; lockedAt: string }> {
    const { data } = await api.post(`/customer/quotes/${id}/respond`, {
      action,
      tosAccepted: options.tosAccepted,
      ...(options.expectedTotalMinor == null ? {} : { expectedTotalMinor: options.expectedTotalMinor }),
    });
    return data.data || data;
  },

  // ---- Contracts (customer-side) ----
  async listContracts(): Promise<CustomerContract[]> {
    const response = await api.get<{ contracts: CustomerContract[] }>('/customer/contracts');
    return response.data.contracts;
  },

  /** Streams the signed PDF when available, otherwise the system-
   *  rendered PDF. The backend handles the fallback so the frontend
   *  just opens whatever it gets back. */
  async contractPdfUrl(id: number): Promise<string> {
    const res = await api.get(`/customer/contracts/${id}/pdf`, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },

  /** The signing certificate issued when the contract was completed (#1446). */
  async contractCertificateUrl(id: number): Promise<string> {
    const res = await api.get(`/customer/contracts/${id}/certificate`, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },

  /** Open a contract for signing: a signing session for a signatures-v2
   *  contract (no code needed — the portal login confirms the email), or a
   *  short-lived link for a contract sent before. */
  async contractSigningAccess(id: number): Promise<CustomerContractSigningAccess> {
    const response = await api.post<CustomerContractSigningAccess>(`/customer/contracts/${id}/signing-access`);
    return response.data;
  },

  /** Full contract view for the portal signing page. Session-authenticated:
   *  the portal never handles the emailed signing token. */
  async getContract(id: number): Promise<{ contract: PublicContractView; canSign: boolean }> {
    const { data } = await api.get(`/customer/contracts/${id}`);
    return data.data || data;
  },

  async signContract(
    id: number,
    payload: { name: string; signatureDataUrl?: string | null; accepted: true },
  ): Promise<{ status: ContractStatus; signedAt: string }> {
    const { data } = await api.post(`/customer/contracts/${id}/sign`, payload);
    return data.data || data;
  },

  async uploadSignedContractPdf(id: number, file: File): Promise<{ status: 'fully_signed'; signedPdfPath: string }> {
    const form = new FormData();
    form.append('file', file);
    const { data } = await api.post(`/customer/contracts/${id}/upload-signed-pdf`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data.data || data;
  },
};

export type CustomerContractSigningAccess =
  | { mode: 'session'; sessionToken: string; expiresAt: string }
  /** Sent before signatures v2: sign on the portal's own page, no token. */
  | { mode: 'portal' };

export interface CustomerQuote {
  id: number;
  quoteNumber: string;
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'expired' | 'converted';
  currency: string;
  issueDate: string;
  validUntil: string | null;
  eventName: string | null;
  eventDate: string | null;
  netAmountMinor: number;
  vatRate: number | null;
  vatAmountMinor: number;
  shippingAmountMinor: number;
  totalAmountMinor: number;
  introText: string | null;
  outroText: string | null;
  sentAt: string | null;
  respondedAt: string | null;
  responseLockedAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  /** Whether the quote can still be accepted or declined from the portal. */
  canRespond: boolean;
}

export interface CustomerInvoice {
  id: number;
  /** Document discriminator. 'invoice' is the default; 'storno' rows
   *  are Stornorechnungen (cancellation invoices) and render with a
   *  distinct badge + lineage banner. */
  kind: 'invoice' | 'storno';
  invoiceNumber: string;
  /** `cancelled` only appears on the customer side for invoices that
   *  were formally reversed via Stornorechnung (cancellation_storno_id
   *  IS NOT NULL). Soft-cancelled drafts stay hidden server-side. */
  status: 'sent' | 'paid' | 'overdue' | 'cancelled';
  currency: string;
  issueDate: string;
  dueDate: string;
  installmentIndex: number;
  installmentTotal: number;
  installmentLabel: string | null;
  netAmountMinor: number;
  vatRate: number | null;
  vatAmountMinor: number;
  shippingAmountMinor: number;
  totalAmountMinor: number;
  paidAmountMinor: number;
  paidAt: string | null;
  lateFeeAmountMinor: number;
  reminderLevel: number;
  sentAt: string | null;
  /** On a Storno row (kind='storno') → id of the invoice it reverses. */
  cancelsInvoiceId: number | null;
  /** Human invoice_number of the row referenced by `cancelsInvoiceId`,
   *  joined server-side so the customer view can show the actual
   *  invoice number instead of the bare row id. */
  cancelsInvoiceNumber: string | null;
  /** On a cancelled invoice → id of the Storno that cancelled it. */
  cancellationStornoId: number | null;
  /** Human invoice_number of the Storno referenced by
   *  `cancellationStornoId`. */
  cancellationStornoNumber: string | null;
  /** Inline event snapshot (migration 123) — rendered next to the
   *  invoice number on the customer portal bills list. */
  eventName: string | null;
  eventDate: string | null;
}

export interface CustomerContract {
  id: number;
  contractNumber: string;
  status: 'sent' | 'signed_by_customer' | 'signed_by_admin' | 'fully_signed' | 'declined' | 'cancelled' | 'expired' | 'awaiting_data';
  language: string;
  issueDate: string;
  validUntil: string | null;
  title: string | null;
  sentAt: string | null;
  signedByCustomerAt: string | null;
  signedByAdminAt: string | null;
  signedCustomerName: string | null;
  signedAdminName: string | null;
  hasPdf: boolean;
  hasSignedPdf: boolean;
  /** Whether a signing certificate has been issued for it (#1446). */
  hasCertificate?: boolean;
  /** Whether the customer can sign this contract from the portal. */
  canSign: boolean;
  /** How far the customer signers have got (#1446). */
  signerProgress?: { signed: number; total: number } | null;
  /** The contract waits for the customer's details before it is prepared (#1446). */
  canCompleteDetails?: boolean;
}
