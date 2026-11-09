/**
 * Client booking requests (#2440, part 2).
 * Admin: /api/admin/booking/*. Public booking page: /api/public/booking/*.
 */
import { api } from '../config/api';
import type { FactorValue, PricingFactorsSnapshot } from './quoteCatalog.service';

export type BookingStatus = 'awaiting_payment' | 'pending' | 'accepted' | 'declined' | 'expired';
export type DepositStatus = 'none' | 'open' | 'paid' | 'refunded' | 'refund_failed' | 'expired' | 'review';

export interface BookingRequest {
  id: number;
  reference: string;
  status: BookingStatus;
  presetId: number | null;
  serviceName: string;
  startsAt: string;
  endsAt: string;
  holdExpiresAt: string;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  message: string | null;
  language: string | null;
  pricingFactors: PricingFactorsSnapshot | null;
  estimateLines: Array<{ description: string; totalMinor: number }>;
  estimateMinor: number;
  currency: string;
  decidedAt: string | null;
  declineReason: string | null;
  customerAccountId: number | null;
  projectId: number | null;
  quoteId: number | null;
  createdAt: string | null;
  // Part 3 — deposit and gallery unlock.
  depositMinor: number;
  depositStatus: DepositStatus;
  depositPaidAt: string | null;
  depositInvoiceId: number | null;
  paymentIntentId: string | null;
  galleryUnlock: 'full_payment' | 'deposit' | 'off' | null;
  galleries: Array<{ id: number; slug: string; name: string; locked: boolean }>;
  invoices: Array<{ id: number; number: string | null; status: string; currency: string; totalMinor: number; paidMinor: number }>;
}

export interface BookingSettings {
  leadTimeHours: number;
  horizonDays: number;
  slotStepMinutes: number;
  bufferMinutes: number;
  holdHours: number;
  maxOpenRequests: number;
  introText: string | null;
}

export interface BookingBlock {
  id: number;
  startsAt: string;
  endsAt: string;
  note: string | null;
}

/** A pricing factor as the public page sees it (no prices, no zone lists). */
export interface PublicFactor {
  id: number;
  name: string;
  description: string | null;
  inputType: 'number' | 'toggle' | 'choice' | 'zone';
  unitLabel: string | null;
  minValue: number | null;
  maxValue: number | null;
  defaultValue: string | null;
  options: Array<{ id: number; label: string }>;
}

export interface PublicService {
  id: number;
  name: string;
  description: string | null;
  currency: string;
  durationMinutes: number;
  durationFactorId: number | null;
  factors: PublicFactor[];
  /** Asked when sending the request (part 3); null = no deposit. */
  deposit: { type: 'percent' | 'fixed'; percent: number | null; amountMinor: number | null } | null;
}

export interface PublicBookingInfo {
  businessName: string | null;
  defaultLanguage: string | null;
  intro: string | null;
  timezone: string;
  /** Signed by the server; sent back with the request (spam guard). */
  formToken: string;
  leadTimeHours: number;
  horizonDays: number;
  services: PublicService[];
}

export interface PublicEstimate {
  currency: string;
  totalMinor: number;
  lines: Array<{ description: string; totalMinor: number }>;
  unmatched: number[];
  durationMinutes: number;
  depositMinor: number;
}

export interface PublicRequestStatus {
  reference: string;
  status: BookingStatus;
  serviceName: string;
  startsAt: string;
  endsAt: string;
  holdExpiresAt: string;
  estimateMinor: number;
  depositMinor: number;
  depositStatus: DepositStatus;
  currency: string;
  timezone: string;
}

export interface Slot { start: string; end: string }

export interface PublicRequestResult {
  reference: string | null;
  status?: BookingStatus;
  holdExpiresAt?: string;
  estimateMinor?: number;
  depositMinor?: number;
  currency?: string;
  /** Pay the deposit there (part 3). */
  checkoutUrl?: string | null;
  statusToken?: string | null;
}

const unwrap = <T,>(data: { data?: T } & T): T => (data.data || data) as T;

export const bookingService = {
  // ---- admin ----------------------------------------------------------
  async listRequests(status?: BookingStatus): Promise<BookingRequest[]> {
    const { data } = await api.get('/admin/booking/requests', { params: status ? { status } : undefined });
    return unwrap<{ requests: BookingRequest[] }>(data).requests;
  },
  async accept(id: number): Promise<BookingRequest> {
    const { data } = await api.post(`/admin/booking/requests/${id}/accept`);
    return unwrap<{ request: BookingRequest }>(data).request;
  },
  async decline(id: number, reason: string): Promise<BookingRequest> {
    const { data } = await api.post(`/admin/booking/requests/${id}/decline`, { reason: reason || undefined });
    return unwrap<{ request: BookingRequest }>(data).request;
  },
  async applyDeposit(id: number, invoiceId: number): Promise<BookingRequest> {
    const { data } = await api.post(`/admin/booking/requests/${id}/apply-deposit`, { invoiceId });
    return unwrap<{ request: BookingRequest }>(data).request;
  },
  async unlockGallery(eventId: number): Promise<void> {
    await api.post(`/admin/booking/galleries/${eventId}/unlock`);
  },
  async listBlocks(): Promise<BookingBlock[]> {
    const { data } = await api.get('/admin/booking/blocks');
    return unwrap<{ blocks: BookingBlock[] }>(data).blocks;
  },
  async createBlock(payload: { startsAt: string; endsAt: string; note?: string }): Promise<BookingBlock> {
    const { data } = await api.post('/admin/booking/blocks', payload);
    return unwrap<{ block: BookingBlock }>(data).block;
  },
  async deleteBlock(id: number): Promise<void> {
    await api.delete(`/admin/booking/blocks/${id}`);
  },
  async getSettings(): Promise<{ settings: BookingSettings; timezone: string; hasBusinessHours: boolean }> {
    const { data } = await api.get('/admin/booking/settings');
    return unwrap<{ settings: BookingSettings; timezone: string; hasBusinessHours: boolean }>(data);
  },
  async saveSettings(payload: Partial<BookingSettings>): Promise<BookingSettings> {
    const { data } = await api.put('/admin/booking/settings', payload);
    return unwrap<{ settings: BookingSettings }>(data).settings;
  },

  // ---- public ---------------------------------------------------------
  async publicInfo(): Promise<PublicBookingInfo> {
    const { data } = await api.get('/public/booking');
    return unwrap<PublicBookingInfo>(data);
  },
  async estimate(serviceId: number, values: Record<string, FactorValue>, language?: string): Promise<PublicEstimate> {
    const { data } = await api.post('/public/booking/estimate', { serviceId, values, language });
    return unwrap<PublicEstimate>(data);
  },
  async slots(serviceId: number, from: string, to: string, duration?: number | null): Promise<{ timezone: string; durationMinutes: number; slots: Slot[] }> {
    const { data } = await api.get('/public/booking/slots', {
      params: { serviceId, from, to, ...(duration ? { duration } : {}) },
    });
    return unwrap<{ timezone: string; durationMinutes: number; slots: Slot[] }>(data);
  },
  async sendRequest(payload: {
    serviceId: number; values: Record<string, FactorValue>; start: string; name: string; email: string;
    phone?: string; company?: string; message?: string; language?: string; website?: string; formToken?: string;
  }): Promise<PublicRequestResult> {
    const { data } = await api.post('/public/booking/requests', payload);
    return unwrap<PublicRequestResult>(data);
  },
  /** `cancelled`: back from a cancelled checkout; the server closes it and frees the slot. */
  async requestStatus(token: string, opts: { cancelled?: boolean } = {}): Promise<PublicRequestStatus> {
    const { data } = await api.get(`/public/booking/requests/status/${token}`, {
      params: opts.cancelled ? { cancelled: '1' } : undefined,
    });
    return unwrap<PublicRequestStatus>(data);
  },
};
