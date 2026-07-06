/**
 * Customer-side API client (#354).
 *
 * Strictly separate from authService.adminLogin / galleryService — uses
 * the /api/customer/* surface and the customer_token cookie. Never falls
 * back to admin endpoints.
 */
import { api } from '../config/api';

export interface CustomerProfile {
  id: number;
  email: string;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  preferredLanguage: string;
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

export interface CustomerEvent {
  id: number;
  slug: string;
  eventName: string;
  eventType: string;
  eventDate: string | null;
  expiresAt: string | null;
  isActive: boolean;
  assignedAt: string;
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

export const customerService = {
  // ---- auth ----
  async login(email: string, password: string, recaptchaToken?: string | null): Promise<{
    customer: CustomerProfile;
    features: { calendar: boolean; quotes: boolean; bills: boolean };
    branding: { showLogo: boolean; showCompanyName: boolean };
  }> {
    const response = await api.post<{
      customer: CustomerProfile;
      features?: { calendar: boolean; quotes: boolean; bills: boolean };
      branding?: { showLogo: boolean; showCompanyName: boolean };
    }>(
      '/customer/auth/login',
      { email, password, recaptchaToken }
    );
    // Backwards-compat fallbacks for older backends that haven't been
    // upgraded yet — defaults match CustomerAuthContext's DEFAULT_*.
    return {
      customer: response.data.customer,
      features: response.data.features || { calendar: false, quotes: false, bills: false },
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
    features: { calendar: boolean; quotes: boolean; bills: boolean };
    branding: { showLogo: boolean; showCompanyName: boolean };
  } | null> {
    try {
      const response = await api.get<{
        customer: CustomerProfile;
        features?: { calendar: boolean; quotes: boolean; bills: boolean };
        branding?: { showLogo: boolean; showCompanyName: boolean };
      }>('/customer/auth/session');
      return {
        customer: response.data.customer,
        features: response.data.features || { calendar: false, quotes: false, bills: false },
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
};

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
  /** Token to open the public response page from the customer
   *  dashboard. null when expired/used. */
  responseToken: string | null;
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
  status: 'sent' | 'signed_by_customer' | 'signed_by_admin' | 'fully_signed' | 'cancelled';
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
  /** Live signing-link token for `sent` contracts so the dashboard can
   *  deep-link the public sign page when the customer lost the email. */
  responseToken: string | null;
}
