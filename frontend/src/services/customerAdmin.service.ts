/**
 * Admin → Customers API client (#354).
 *
 * Hits /api/admin/customers/* (admin auth). Distinct from customer.service.ts
 * which is the customer's own /api/customer/* surface.
 */
import { api } from '../config/api';

/**
 * A customer group (#1443, migration 226). Referenced by id everywhere, so a
 * rename or a recolour shows up wherever the chip is drawn without rewriting
 * a customer record.
 */
export interface CustomerGroup {
  id: number;
  name: string;
  description: string | null;
  /** #rrggbb. Drawn as a dot beside the name, never as the only meaning. */
  color: string;
  sortOrder: number;
  /** Archived groups stay on the customers that carry them and are not
   *  offered for new assignments. */
  isArchived: boolean;
  /** Only on the catalogue listing. */
  memberCount?: number;
  createdAt?: string | null;
}

export interface CustomerGroupPayload {
  name?: string;
  description?: string | null;
  color?: string | null;
  isArchived?: boolean;
}

export interface CustomerGroupCatalogue {
  groups: CustomerGroup[];
  /** Customers in no group, over every status — same basis as memberCount. */
  ungroupedCount: number;
}

/**
 * The most customers one bulk group change may cover. Mirrors
 * MAX_BULK_CUSTOMERS in backend/src/routes/adminCustomers.js, which refuses
 * more with a 400.
 */
export const BULK_GROUP_MAX_CUSTOMERS = 500;
/** The most groups one filter, or one customer, carries (MAX_GROUP_IDS on the server). */
export const MAX_GROUPS_PER_CUSTOMER = 100;

export interface CustomerGroupBulkPayload {
  customerIds: number[];
  addGroupIds?: number[];
  removeGroupIds?: number[];
  dryRun?: boolean;
}

/** The effective change: memberships that exist already aren't counted. */
export interface CustomerGroupBulkResult {
  customers: number;
  added: number;
  removed: number;
  perGroup: { groupId: number; added: number; removed: number }[];
  dryRun: boolean;
}

export type CustomerStatusFilter = 'all' | 'active' | 'inactive';
export type CustomerGroupMatch = 'any' | 'all';

export interface CustomerListOptions {
  search?: string;
  groupIds?: number[];
  /** Only sent with two or more groups; `any` is the server default. */
  groupMatch?: CustomerGroupMatch;
  /** Customers in no group. Wins over `groupIds`. */
  ungrouped?: boolean;
  status?: CustomerStatusFilter;
}

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
  /** Customer groups (#1443). Always present on the list and detail
   *  responses, empty for a customer in no group. */
  groups?: CustomerGroup[];
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
  /** Per-customer documents override (migration 225). Defaults true — the
   *  global `documents` flag is the master switch. */
  featureDocuments?: boolean;
  /** Default hourly rate in minor units (e.g. CHF 150.00 = 15000).
   *  null when admin hasn't set one — each entry then requires a
   *  per-block override. */
  hourlyRateMinor?: number | null;
  /** Default day rate in minor units for per-day quote lines (migration
   *  215). null falls back to the business default day rate. */
  dayRateMinor?: number | null;
  /** Newsletter consent (migration 199, #1264). Opt-OUT: false means the
   *  customer still receives campaigns. Transactional mail — galleries,
   *  quotes, invoices — ignores this entirely. */
  marketingOptOut?: boolean;
  /** When the customer opted out. null while they are still subscribed. */
  marketingOptOutAt?: string | null;
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
  /** Per-customer re-bill proof-attachment override (#866). Tri-state:
   *  null = inherit the global default, true = always attach the supplier
   *  proof to re-billed invoices, false = never. */
  rebillAttachProof?: boolean | null;
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

/**
 * The group routes answer through `successResponse`, which wraps the payload
 * in `data`; the older customer routes answer with the payload itself. One
 * place to stop caring which.
 */
type Enveloped<T> = T | { data: T };
const isEnveloped = <T,>(payload: Enveloped<T>): payload is { data: T } =>
  !!payload && typeof payload === 'object' && 'data' in payload && (payload as { data?: T }).data !== undefined;
const unwrap = <T,>(payload: Enveloped<T>): T => (isEnveloped(payload) ? payload.data : payload);

/** One row of a customer's timeline (GET /admin/customers/:id/activity, #1444). */
export interface CustomerActivityEntry {
  id: number;
  /** activity_logs.activity_type — labelled via admin.activities.<type>. */
  type: string;
  at: string | null;
  actorType: string;
  actorName: string | null;
  eventId: number | null;
  metadata: { documentId?: number; status?: string; eventId?: number; requestId?: number; count?: number };
}

export const customerAdminService = {
  async activity(id: number, beforeId?: number | null): Promise<{ entries: CustomerActivityEntry[]; nextBeforeId: number | null }> {
    const { data } = await api.get(`/admin/customers/${id}/activity`, { params: beforeId ? { beforeId } : {} });
    return data;
  },

  async list(options: CustomerListOptions = {}): Promise<CustomerAccountSummary[]> {
    // The filters are server-side (#1443); the overview keeps filtering the
    // answer by its search box. Defaults are left out of the request.
    const { search, groupIds, groupMatch, ungrouped, status } = options;
    const params: Record<string, string> = {};
    if (search) params.search = search;
    if (ungrouped) params.ungrouped = 'true';
    else if (groupIds && groupIds.length > 0) {
      params.groupIds = groupIds.join(',');
      if (groupMatch === 'all') params.groupMatch = 'all';
    }
    if (status && status !== 'all') params.status = status;
    const response = await api.get<{ customers: CustomerAccountSummary[] }>(
      '/admin/customers',
      { params: Object.keys(params).length > 0 ? params : undefined }
    );
    return response.data.customers;
  },

  // ---- groups (#1443) ----------------------------------------------------

  async listGroups(includeArchived = false): Promise<CustomerGroup[]> {
    const response = await api.get<Enveloped<{ groups: CustomerGroup[] }>>(
      '/admin/customers/groups',
      { params: includeArchived ? { includeArchived: 'true' } : undefined }
    );
    return unwrap(response.data).groups;
  },

  /** The catalogue plus the number of customers in no group at all. */
  async listGroupCatalogue(includeArchived = false): Promise<CustomerGroupCatalogue> {
    const response = await api.get('/admin/customers/groups', {
      params: includeArchived ? { includeArchived: 'true' } : undefined,
    });
    const data = unwrap(response.data);
    return { groups: data.groups, ungroupedCount: Number(data.ungroupedCount) || 0 };
  },

  async createGroup(payload: CustomerGroupPayload): Promise<CustomerGroup> {
    const response = await api.post<Enveloped<{ group: CustomerGroup }>>('/admin/customers/groups', payload);
    return unwrap(response.data).group;
  },

  async updateGroup(id: number, payload: CustomerGroupPayload): Promise<CustomerGroup> {
    const response = await api.put<Enveloped<{ group: CustomerGroup }>>(`/admin/customers/groups/${id}`, payload);
    return unwrap(response.data).group;
  },

  async deleteGroup(id: number): Promise<void> {
    await api.delete(`/admin/customers/groups/${id}`);
  },

  async reorderGroups(orderedIds: number[]): Promise<CustomerGroup[]> {
    const response = await api.post<Enveloped<{ groups: CustomerGroup[] }>>('/admin/customers/groups/reorder', { orderedIds });
    return unwrap(response.data).groups;
  },

  /**
   * Add customers to groups and take them out of others, all or nothing.
   * With `dryRun` nothing is written; the answer is the preview.
   */
  async bulkAssignGroups(payload: CustomerGroupBulkPayload): Promise<CustomerGroupBulkResult> {
    const response = await api.post<Enveloped<CustomerGroupBulkResult>>('/admin/customers/groups/bulk-assign', payload);
    return unwrap(response.data);
  },

  /** Replace a customer's groups with exactly these ids. */
  async setCustomerGroups(id: number, groupIds: number[]): Promise<CustomerGroup[]> {
    const response = await api.put<Enveloped<{ groups: CustomerGroup[] }>>(`/admin/customers/${id}/groups`, { groupIds });
    return unwrap(response.data).groups;
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
      // Per-customer documents override (migration 225).
      featureDocuments: 'feature_documents',
      // Hour-logging default rate (migration 129).
      hourlyRateMinor: 'hourly_rate_minor',
      // Quote day rate (migration 220).
      dayRateMinor: 'day_rate_minor',
      // CRM billing cadence (migration 102 + 128).
      billingCadence: 'billing_cadence',
      billingCycleDay: 'billing_cycle_day',
      // Per-customer Skonto opt-out (migration 112).
      skontoDisabled: 'skonto_disabled',
      // Per-customer re-bill proof-attachment override (#866). null clears it.
      rebillAttachProof: 'rebill_attach_proof',
      // Newsletter consent (migration 199, #1264). Admin-settable so a
      // customer who unsubscribes by phone can be honoured immediately.
      marketingOptOut: 'marketing_opt_out',
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
    const response = await api.post<Enveloped<{ email: string; expiresAt: string }>>(
      `/admin/customers/${id}/password-reset`,
    );
    return unwrap(response.data);
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
    const response = await api.put<Enveloped<{ added: number; removed: number }>>(
      `/admin/customers/${id}/events`,
      { event_ids: eventIds },
    );
    return unwrap(response.data);
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
    const response = await api.post<Enveloped<{ invitation: { id: number; email: string; expiresAt: string } }>>(
      '/admin/customers/invite',
      { email, prefill },
    );
    return unwrap(response.data).invitation;
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
    /** Needs customers.groups.manage; the server refuses the whole create without it. */
    groupIds?: number[],
  ): Promise<CustomerAccountDetail> {
    const response = await api.post<Enveloped<{ customer: CustomerAccountDetail }>>(
      '/admin/customers',
      groupIds && groupIds.length > 0 ? { email, prefill, groupIds } : { email, prefill },
    );
    return unwrap(response.data).customer;
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
    const response = await api.post<Enveloped<{ invitation: { id: number; email: string; expiresAt: string } }>>(
      `/admin/customers/${id}/send-invite`,
    );
    return unwrap(response.data).invitation;
  },

  // -------------------------------------------------------------------
  // Hour entries (migration 129).
  // -------------------------------------------------------------------

  async listHourEntries(customerId: number, status?: HourEntryStatus): Promise<HourEntry[]> {
    const response = await api.get<Enveloped<{ entries: HourEntry[] }>>(
      `/admin/customers/${customerId}/hour-entries`,
      { params: status ? { status } : undefined },
    );
    return unwrap(response.data).entries || [];
  },

  async createHourEntry(
    customerId: number,
    payload: HourEntryCreatePayload,
  ): Promise<{ id: number; status: HourEntryStatus; invoiceId?: number }> {
    const response = await api.post<Enveloped<{ id: number; status: HourEntryStatus; invoiceId?: number }>>(
      `/admin/customers/${customerId}/hour-entries`,
      payload,
    );
    return unwrap(response.data);
  },

  async updateHourEntry(
    customerId: number,
    entryId: number,
    payload: HourEntryUpdatePayload,
  ): Promise<{ id: number }> {
    const response = await api.put<Enveloped<{ id: number }>>(
      `/admin/customers/${customerId}/hour-entries/${entryId}`,
      payload,
    );
    return unwrap(response.data);
  },

  async deleteHourEntry(customerId: number, entryId: number): Promise<{ deleted: true }> {
    const response = await api.delete<Enveloped<{ deleted: true }>>(
      `/admin/customers/${customerId}/hour-entries/${entryId}`,
    );
    return unwrap(response.data);
  },

  /** Per-event flow only — mints a standalone invoice from all
   *  unbilled entries and stamps them billed. Monthly-mode customers
   *  auto-bill on save and get a 409 here. */
  async billUnbilledHourEntries(customerId: number): Promise<{ invoiceId: number; entriesBilled: number }> {
    const response = await api.post<Enveloped<{ invoiceId: number; entriesBilled: number }>>(
      `/admin/customers/${customerId}/hour-entries/bill`,
    );
    return unwrap(response.data);
  },

  /** Combine open hours and/or open re-bills into ONE invoice (#866, Feature 3).
   *  Hours and re-bills stay as distinct, contiguous line groups. */
  async billCombined(
    customerId: number,
    opts: { includeHours: boolean; includeRebills: boolean },
  ): Promise<{ invoiceId: number; entriesBilled: number; rebillsBilled: number }> {
    const response = await api.post<Enveloped<{ invoiceId: number; entriesBilled: number; rebillsBilled: number }>>(
      `/admin/customers/${customerId}/bill-combined`,
      opts,
    );
    return unwrap(response.data);
  },

  /** Landing aggregate for /admin/clients/hours — every customer that
   *  currently carries unbilled hour entries, with open hours + open
   *  amount (install default currency). Sorted by open amount desc. */
  async getUnbilledHoursSummary(): Promise<UnbilledHoursSummaryRow[]> {
    const response = await api.get<Enveloped<{ summary: UnbilledHoursSummaryRow[] }>>(`/admin/customers/hour-entries/unbilled-summary`);
    return unwrap(response.data).summary || [];
  },

  /** Admin override — issue the customer's running monthly draft now,
   *  bypassing the cadence-day wait. 409 when no draft exists or the
   *  draft is empty. Returns the issued invoice id + number. */
  async triggerMonthlyBill(customerId: number): Promise<{ invoiceId: number; invoiceNumber: string }> {
    const response = await api.post<Enveloped<{ invoiceId: number; invoiceNumber: string }>>(
      `/admin/customers/${customerId}/trigger-monthly-bill`,
    );
    return unwrap(response.data);
  },

  /** Preview the customer's open monthly draft (line items + totals).
   *  Returns null when nothing has been queued for the current period. */
  async getMonthlyDraft(customerId: number): Promise<{ draft: MonthlyDraftPreview | null }> {
    const response = await api.get<Enveloped<{ draft: MonthlyDraftPreview | null }>>(
      `/admin/customers/${customerId}/monthly-draft`,
    );
    return unwrap(response.data);
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
