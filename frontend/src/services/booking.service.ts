/**
 * Client booking requests (#2440, part 2).
 * Admin: /api/admin/booking/*. Public booking page: /api/public/booking/*.
 */
import { api } from '../config/api';
import type { FactorValue, PricingFactorsSnapshot } from './quoteCatalog.service';

export type BookingStatus = 'pending' | 'accepted' | 'declined' | 'expired';

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
}

export interface Slot { start: string; end: string }

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
  }): Promise<{ reference: string | null; holdExpiresAt?: string; estimateMinor?: number; currency?: string }> {
    const { data } = await api.post('/public/booking/requests', payload);
    return unwrap<{ reference: string | null; holdExpiresAt?: string; estimateMinor?: number; currency?: string }>(data);
  },
};
