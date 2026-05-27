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
  lastLogin: string | null;
  createdAt: string;
  eventCount?: number;
  /** Per-customer feature flags (#354 follow-up). */
  featureCalendar?: boolean;
  featureQuotes?: boolean;
  featureBills?: boolean;
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
  preferredLanguage: string;
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
      preferredLanguage: 'preferred_language',
      notes: 'notes',
      isActive: 'is_active',
      // Per-customer feature flags (#354 follow-up).
      featureCalendar: 'feature_calendar',
      featureQuotes:   'feature_quotes',
      featureBills:    'feature_bills',
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
};
