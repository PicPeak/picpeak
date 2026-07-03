/**
 * Admin → Customers API client (#354).
 *
 * Hits /api/admin/customers/* (admin auth). Distinct from customer.service.ts
 * which is the customer's own /api/customer/* surface.
 */
import { api } from '../config/api';

export interface CustomerAccountSummary {
  id: number;
  email: string;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  salutation: string | null;
  companyName: string | null;
  isActive: boolean;
  /** Passive = admin-only customer with no portal access (password_hash IS NULL).
   *  The backend never returns the actual hash; this boolean is computed
   *  server-side in transformCustomer. Drives the "Passive — admin only"
   *  badge + the "Send portal invitation" button on the detail page. */
  isPassive?: boolean;
  lastLogin: string | null;
  createdAt: string;
  eventCount?: number;
  /** Per-customer feature flags (#354 follow-up). */
  featureCalendar?: boolean;
  featureQuotes?: boolean;
  featureBills?: boolean;
  /** Per-customer hour logging (migration 129). When on, the customer
   *  detail page renders the "Hours" section card. */
  featureHoursLogging?: boolean;
  /** Per-customer contracts override (migration 131). Defaults true —
   *  existing customers keep their Contracts tab. */
  featureContracts?: boolean;
  /** Default hourly rate in minor units (e.g. CHF 150.00 = 15000).
   *  null when admin hasn't set one — each entry then requires a
   *  per-block override. */
  hourlyRateMinor?: number | null;
}

export interface CustomerAccountDetail extends CustomerAccountSummary {
  phone: string | null;
  billingEmail: string | null;
  vatId: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  state: string | null;
  countryCode: string | null;
  /** Free-text country name (migration 107). PDF renderer uses this
   *  verbatim when set; otherwise falls back to the locale-aware
   *  lookup on countryCode. Useful when countryCode is the postal /
   *  vehicle abbreviation ("FL") rather than the ISO code ("LI"). */
  countryName: string | null;
  preferredLanguage: string;
  /**
   * CRM billing cadence override (migration 102).
   * - 'per_event' (default): respect each quote's installment plan
   * - 'monthly' / 'quarterly': snap every scheduled invoice to
   *   `billingCycleDay` of the next period.
   */
  billingCadence?: 'per_event' | 'monthly' | 'quarterly' | 'manual';
  billingCycleDay?: number;
  /** Per-customer Skonto opt-out (migration 112). When true, none of
   *  this customer's invoices qualify for an early-payment discount,
   *  regardless of template / global defaults. */
  skontoDisabled?: boolean;
  notes: string | null;
  events: Array<{
    id: number;
    slug: string;
    eventName: string;
    eventDate: string | null;
    expiresAt: string | null;
    isArchived: boolean;
    assignedAt: string;
  }>;
}

/** Optional admin-side prefill on invite — see /admin/customers/invite. */
export interface CustomerInvitePrefill {
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
  country_name?: string;
  /** ISO 639 / BCP-47 locale code. Defaults at insert time to the
   *  business profile's default_locale when not supplied. */
  preferred_language?: string;
}

export interface CustomerInvitationSummary {
  id: number;
  email: string;
  expiresAt: string;
  createdAt: string;
  invitedBy: string | null;
}

export const customerAdminService = {
  async list(search?: string): Promise<CustomerAccountSummary[]> {
    const response = await api.get<{ customers: CustomerAccountSummary[] }>(
      '/admin/customers',
      { params: search ? { search } : undefined }
    );
    return response.data.customers;
  },

  async search(term: string): Promise<CustomerAccountSummary[]> {
    if (!term || !term.trim()) return [];
    const response = await api.get<{ customers: CustomerAccountSummary[] }>(
      '/admin/customers/search',
      { params: { email: term } }
    );
    return response.data.customers;
  },

  async get(id: number): Promise<CustomerAccountDetail> {
    const response = await api.get<{ customer: CustomerAccountDetail }>(`/admin/customers/${id}`);
    return response.data.customer;
  },

  async update(id: number, payload: Partial<Omit<CustomerAccountDetail, 'id' | 'events' | 'eventCount'>>): Promise<CustomerAccountDetail> {
    // Frontend sends camelCase, backend accepts snake_case — translate here
    // so callers can stay in TS-land conventions.
    const snake: Record<string, any> = {};
    const map: Record<string, string> = {
      email: 'email',
      salutation: 'salutation',
      firstName: 'first_name',
      lastName: 'last_name',
      displayName: 'display_name',
      phone: 'phone',
      companyName: 'company_name',
      billingEmail: 'billing_email',
      vatId: 'vat_id',
      addressLine1: 'address_line1',
      addressLine2: 'address_line2',
      postalCode: 'postal_code',
      city: 'city',
      state: 'state',
      countryCode: 'country_code',
      countryName: 'country_name',
      preferredLanguage: 'preferred_language',
      notes: 'notes',
      isActive: 'is_active',
      // Per-customer feature flags (#354 follow-up).
      featureCalendar: 'feature_calendar',
      featureQuotes:   'feature_quotes',
      featureBills:    'feature_bills',
      featureHoursLogging: 'feature_hours_logging',
      featureContracts: 'feature_contracts',
      // Hour-logging default rate (migration 129).
      hourlyRateMinor: 'hourly_rate_minor',
      // CRM billing cadence (migration 102 + 128).
      billingCadence: 'billing_cadence',
      billingCycleDay: 'billing_cycle_day',
      // Per-customer Skonto opt-out (migration 112).
      skontoDisabled: 'skonto_disabled',
    };
    for (const [k, v] of Object.entries(payload)) {
      if (k in map) snake[map[k]] = v;
    }
    const response = await api.put<{ customer: CustomerAccountDetail }>(`/admin/customers/${id}`, snake);
    return response.data.customer;
  },

  async deactivate(id: number): Promise<void> {
    await api.post(`/admin/customers/${id}/deactivate`);
  },

  /** Restore a deactivated customer (login re-enabled, assignments stay). */
  async reactivate(id: number): Promise<void> {
    await api.post(`/admin/customers/${id}/reactivate`);
  },

  /**
   * Anonymize-in-place erasure (GDPR style). Customer row stays for
   * audit FKs but every PII column is nulled and credentials are wiped.
   * See backend service `eraseCustomer` for the full contract.
   */
  async erase(id: number): Promise<void> {
    await api.post(`/admin/customers/${id}/erase`);
  },

  /**
   * Trigger a password reset for an existing customer. The backend
   * generates a 7-day single-use token and emails the customer.
   */
  async sendPasswordReset(id: number): Promise<{ email: string; expiresAt: string }> {
    const response = await api.post<{ data: { email: string; expiresAt: string } } | { email: string; expiresAt: string }>(
      `/admin/customers/${id}/password-reset`,
    );
    return ((response.data as any).data ?? response.data) as { email: string; expiresAt: string };
  },

  /**
   * Replace the full set of events this customer is assigned to.
   * Empty array clears every assignment. The backend rejects any
   * archived event ids it sees, so the response { added, removed }
   * counts may be lower than the input length if the admin selected
   * something stale — surface the numbers in a toast.
   *
   * Access revocation: gallery middleware re-checks the assignment
   * row on every customer-minted JWT, so removing an event here
   * immediately blocks the customer's next request to that gallery.
   * No separate token-blacklist call needed.
   */
  async setEvents(id: number, eventIds: number[]): Promise<{ added: number; removed: number }> {
    const response = await api.put<{ data: { added: number; removed: number } } | { added: number; removed: number }>(
      `/admin/customers/${id}/events`,
      { event_ids: eventIds },
    );
    return ((response.data as any).data ?? response.data) as { added: number; removed: number };
  },

  /**
   * Invite a customer. `prefill` is an optional set of profile fields the
   * admin can pre-populate on the invitation row — the customer sees them
   * pre-filled (and editable) on the accept form. Saves the customer typing
   * for the common case where the photographer already has the wedding
   * couple's name + address from the booking form.
   */
  async invite(
    email: string,
    prefill?: CustomerInvitePrefill,
  ): Promise<{ id: number; email: string; expiresAt: string }> {
    const response = await api.post<{ data: { invitation: { id: number; email: string; expiresAt: string } } }>(
      '/admin/customers/invite',
      { email, prefill },
    );
    return (response.data as any).data?.invitation ?? (response.data as any).invitation;
  },

  async listInvitations(): Promise<CustomerInvitationSummary[]> {
    const response = await api.get<{ invitations: CustomerInvitationSummary[] }>('/admin/customers/invitations');
    return response.data.invitations;
  },

  async cancelInvitation(id: number): Promise<void> {
    await api.delete(`/admin/customers/invitations/${id}`);
  },

  /**
   * Create a "passive" customer directly — admin-only record with no
   * portal access, no invitation, no email. The customer is created
   * with `password_hash = NULL`; the auth middleware rejects login
   * for those, so the customer physically can't access the portal
   * until the admin promotes them via `sendInvite()`.
   *
   * Used by the quote/invoice editor's "+ Create new customer" inline
   * form: lets the admin spin up an identity in seconds for one-off
   * projects (where issuing portal credentials would be overkill).
   */
  async createDirect(
    email: string,
    prefill?: CustomerInvitePrefill,
  ): Promise<CustomerAccountDetail> {
    const response = await api.post<{ data: { customer: CustomerAccountDetail } } | { customer: CustomerAccountDetail }>(
      '/admin/customers',
      { email, prefill },
    );
    return ((response.data as any).data ?? response.data).customer;
  },

  /**
   * Promote a passive customer to active by firing the standard
   * portal-invitation email. The customer clicks the link, lands on
   * the accept page (pre-populated with their existing profile),
   * sets a password, and is now active. The customer's id is
   * preserved across promotion — all their existing invoices,
   * quotes, and gallery assignments survive.
   *
   * Rejects with 409 CUSTOMER_ALREADY_ACTIVE if the customer
   * already has a password set.
   */
  async sendInvite(id: number): Promise<{ id: number; email: string; expiresAt: string }> {
    const response = await api.post<{ data: { invitation: { id: number; email: string; expiresAt: string } } }>(
      `/admin/customers/${id}/send-invite`,
    );
    return (response.data as any).data?.invitation ?? (response.data as any).invitation;
  },

  // -------------------------------------------------------------------
  // Hour entries (migration 129).
  // -------------------------------------------------------------------

  async listHourEntries(customerId: number, status?: HourEntryStatus): Promise<HourEntry[]> {
    const response = await api.get<{ data: { entries: HourEntry[] } }>(
      `/admin/customers/${customerId}/hour-entries`,
      { params: status ? { status } : undefined },
    );
    return ((response.data as any).data?.entries ?? (response.data as any).entries) || [];
  },

  async createHourEntry(
    customerId: number,
    payload: HourEntryCreatePayload,
  ): Promise<{ id: number; status: HourEntryStatus; invoiceId?: number }> {
    const response = await api.post(
      `/admin/customers/${customerId}/hour-entries`,
      payload,
    );
    return (response.data as any).data ?? response.data;
  },

  async updateHourEntry(
    customerId: number,
    entryId: number,
    payload: HourEntryUpdatePayload,
  ): Promise<{ id: number }> {
    const response = await api.put(
      `/admin/customers/${customerId}/hour-entries/${entryId}`,
      payload,
    );
    return (response.data as any).data ?? response.data;
  },

  async deleteHourEntry(customerId: number, entryId: number): Promise<{ deleted: true }> {
    const response = await api.delete(
      `/admin/customers/${customerId}/hour-entries/${entryId}`,
    );
    return (response.data as any).data ?? response.data;
  },

  /** Per-event flow only — mints a standalone invoice from all
   *  unbilled entries and stamps them billed. Monthly-mode customers
   *  auto-bill on save and get a 409 here. */
  async billUnbilledHourEntries(customerId: number): Promise<{ invoiceId: number; entriesBilled: number }> {
    const response = await api.post(
      `/admin/customers/${customerId}/hour-entries/bill`,
    );
    return (response.data as any).data ?? response.data;
  },

  /** Landing aggregate for /admin/clients/hours — every customer that
   *  currently carries unbilled hour entries, with open hours + open
   *  amount (install default currency). Sorted by open amount desc. */
  async getUnbilledHoursSummary(): Promise<UnbilledHoursSummaryRow[]> {
    const response = await api.get(`/admin/customers/hour-entries/unbilled-summary`);
    return ((response.data as any).data?.summary ?? (response.data as any).summary) || [];
  },

  /** Admin override — issue the customer's running monthly draft now,
   *  bypassing the cadence-day wait. 409 when no draft exists or the
   *  draft is empty. Returns the issued invoice id + number. */
  async triggerMonthlyBill(customerId: number): Promise<{ invoiceId: number; invoiceNumber: string }> {
    const response = await api.post(
      `/admin/customers/${customerId}/trigger-monthly-bill`,
    );
    return (response.data as any).data ?? response.data;
  },

  /** Preview the customer's open monthly draft (line items + totals).
   *  Returns null when nothing has been queued for the current period. */
  async getMonthlyDraft(customerId: number): Promise<{ draft: MonthlyDraftPreview | null }> {
    const response = await api.get(
      `/admin/customers/${customerId}/monthly-draft`,
    );
    return (response.data as any).data ?? response.data;
  },
};

/** Open bill accumulator preview (migration 128). One row in
 *  the invoices table with is_monthly_draft=true that gathers every
 *  invoice line created for this customer during the current period;
 *  ships on the cadence day or via triggerMonthlyBill. Manual-cadence
 *  drafts carry no period (periodStart/End null) and ship only on the
 *  admin trigger. */
export interface MonthlyDraftPreview {
  id: number;
  invoiceNumber: string;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  netAmountMinor: number;
  vatRate: number | null;
  vatAmountMinor: number;
  totalAmountMinor: number;
  lineItems: MonthlyDraftLineItem[];
}

export interface MonthlyDraftLineItem {
  id: number;
  position: number;
  quantity: number;
  description: string;
  unitPriceMinor: number;
  discountPercent: number;
  lineTotalMinor: number;
  parentPosition: number | null;
  detailsText: string;
}

// -------------------------------------------------------------------
// Hour-entry types (migration 129)
// -------------------------------------------------------------------

export type HourEntryStatus = 'unbilled' | 'billed' | 'cancelled';

export interface HourEntry {
  id: number;
  customerAccountId: number;
  entryDate: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  hourlyRateMinorOverride: number | null;
  description: string | null;
  status: HourEntryStatus;
  invoiceId: number | null;
  invoiceLineItemId: number | null;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
  invoiceIsMonthlyDraft: boolean;
  invoiceScheduledSendAt: string | null;
  billedAt: string | null;
  recordedByAdminId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface UnbilledHoursSummaryRow {
  customerAccountId: number;
  companyName: string | null;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  isPassive: boolean;
  billingCadence: string | null;
  entryCount: number;
  totalMinutes: number;
  openAmountMinor: number;
  /** false when at least one entry has no resolvable rate (no override,
   *  no customer rate, no install default) — its amount is excluded from
   *  openAmountMinor and the UI prompts to set a rate. */
  rateResolvable: boolean;
}

export interface HourEntryCreatePayload {
  entryDate: string;        // YYYY-MM-DD
  startTime: string;        // HH:MM
  endTime: string;          // HH:MM
  hourlyRateMinorOverride?: number | null;
  description?: string | null;
  /** Migration 118 — optional "book to project" link. */
  projectId?: number | null;
}

export interface HourEntryUpdatePayload {
  entryDate?: string;
  startTime?: string;
  endTime?: string;
  hourlyRateMinorOverride?: number | null;
  description?: string | null;
}
