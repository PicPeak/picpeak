/**
 * Admin calendar API client.
 *
 * Wraps the single aggregate endpoint
 *   GET /api/admin/calendar/items?from=YYYY-MM-DD&to=YYYY-MM-DD
 * exposed by `backend/src/routes/adminCalendar.js` (E.3).
 *
 * The response is a discriminated union on `kind` so the calendar page
 * can switch render style per item type without juggling four separate
 * react-query subscriptions.
 *
 * Hour-entry mutations stay on the existing customerAdmin.service —
 * the calendar's drag-create / inline-edit modals call those directly.
 */

import { api } from '../config/api';

export type CalendarItemKind = 'event' | 'hours' | 'quote' | 'contract';

interface CalendarItemBase {
  kind: CalendarItemKind;
  customerName: string | null;
}

export interface CalendarEventItem extends CalendarItemBase {
  kind: 'event';
  id: number;
  slug: string;
  eventName: string;
  eventDate: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  isFullDay: boolean;
}

export interface CalendarHoursItem extends CalendarItemBase {
  kind: 'hours';
  id: number;
  customerAccountId: number;
  entryDate: string;
  startTime: string;
  endTime: string;
  description: string | null;
  status: 'unbilled' | 'billed' | 'cancelled';
  invoiceId: number | null;
  invoiceStatus: string | null;
  /**
   * True when this entry's invoice has been armed for send (monthly
   * draft cleared + scheduled_send_at set, OR status sent/paid/cancelled).
   * Backend computes this via customerHoursService._internal.isEntryLocked.
   * Drives the calendar's locked badge + edit-disabled state.
   */
  locked: boolean;
}

export interface CalendarQuoteItem extends CalendarItemBase {
  kind: 'quote';
  id: number;
  quoteNumber: string;
  eventName: string | null;
  eventDate: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  status: 'sent' | 'accepted';
}

export interface CalendarContractItem extends CalendarItemBase {
  kind: 'contract';
  id: number;
  contractNumber: string;
  eventName: string | null;
  eventDate: string;
  eventTimeStart: string | null;
  eventTimeEnd: string | null;
  status: 'signed_by_customer' | 'fully_signed';
}

export type CalendarItem =
  | CalendarEventItem
  | CalendarHoursItem
  | CalendarQuoteItem
  | CalendarContractItem;

export interface CalendarItemsResponse {
  items: CalendarItem[];
  range: { from: string; to: string };
}

export const calendarService = {
  /**
   * Fetch all four layers (events, hours, pending quotes, pending
   * contracts) for the supplied date range. Both ends are inclusive,
   * ISO YYYY-MM-DD. Backend caps the range at 90 days.
   */
  async list(params: { from: string; to: string }): Promise<CalendarItemsResponse> {
    const { data } = await api.get('/admin/calendar/items', { params });
    return data.data || data;
  },
};
