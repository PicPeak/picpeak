/**
 * Admin → customer gifts and gift stock API client (migration 343).
 *
 * Hits /api/admin/gifts/*. Every endpoint needs the `customerGifts` feature
 * flag; reading needs `customers.gifts.view`, changes `customers.gifts.manage`.
 */
import { api } from '../config/api';

export interface GiftRules {
  milestoneYears: number[];
  minBookings: number;
  activityMinInvoices: number;
  activityPeriodYears: number;
  rhythmMarginMonths: number;
  graceDays: number;
}

export interface GiftItem {
  id: number;
  name: string;
  description: string | null;
  isArchived: boolean;
  stock: number;
}

export interface GiftMovement {
  id: number;
  kind: 'purchase' | 'gift' | 'gift_undone' | 'correction';
  quantityDelta: number;
  unitCostMinor: number | null;
  currency: string | null;
  inboundDocumentId: number | null;
  reason: string | null;
  occurredOn: string;
}

export interface GiftSuggestion {
  customerId: number;
  customerName: string;
  milestoneYears: number;
  milestoneDate: string;
  /** Null, with lastPaidOn and reason, without bills.view. */
  bookingCount: number | null;
  lastPaidOn: string | null;
  reason: 'too_few_bookings' | 'inactive' | null;
}

export interface CustomerGift {
  id: number;
  status: 'given' | 'declined';
  giftItemId: number | null;
  itemName: string | null;
  milestoneYears: number | null;
  isOverride: boolean;
  note: string | null;
  giftDate: string;
  undone: boolean;
}

export interface CustomerGifts {
  noGifts: boolean;
  startDateOverride: string | null;
  gifts: CustomerGift[];
}

export interface AddStockInput {
  quantity: number;
  unitCostMinor?: number | null;
  currency?: string | null;
  occurredOn?: string;
  inboundDocumentId?: number | null;
  note?: string;
}

export interface GiveGiftInput {
  giftItemId: number;
  giftDate?: string;
  note?: string;
  milestoneYears?: number | null;
  isOverride?: boolean;
  reduceStock?: boolean;
}

export const giftsService = {
  async listSuggestions(): Promise<{ due: GiftSuggestion[]; notQualified: GiftSuggestion[] }> {
    const { data } = await api.get('/admin/gifts/suggestions');
    return data;
  },
  async getRules(): Promise<GiftRules> {
    const { data } = await api.get('/admin/gifts/rules');
    return data.rules;
  },
  async updateRules(rules: Partial<GiftRules>): Promise<GiftRules> {
    const { data } = await api.put('/admin/gifts/rules', rules);
    return data.rules;
  },
  async listItems(includeArchived = false): Promise<GiftItem[]> {
    const { data } = await api.get('/admin/gifts/items', { params: { includeArchived } });
    return data.items;
  },
  async createItem(input: { name: string; description?: string }): Promise<GiftItem> {
    const { data } = await api.post('/admin/gifts/items', input);
    return data.item;
  },
  async updateItem(id: number, fields: { name?: string; description?: string | null; isArchived?: boolean }): Promise<GiftItem> {
    const { data } = await api.patch(`/admin/gifts/items/${id}`, fields);
    return data.item;
  },
  async listMovements(id: number): Promise<GiftMovement[]> {
    const { data } = await api.get(`/admin/gifts/items/${id}/movements`);
    return data.movements;
  },
  async addStock(id: number, input: AddStockInput): Promise<GiftMovement> {
    const { data } = await api.post(`/admin/gifts/items/${id}/stock`, input);
    return data.movement;
  },
  async correctStock(id: number, input: { quantityDelta: number; reason: string }): Promise<GiftMovement> {
    const { data } = await api.post(`/admin/gifts/items/${id}/corrections`, input);
    return data.movement;
  },
  async getCustomerGifts(customerId: number): Promise<CustomerGifts> {
    const { data } = await api.get(`/admin/gifts/customers/${customerId}`);
    return data;
  },
  async updateCustomerPreferences(
    customerId: number,
    fields: { noGifts?: boolean; startDateOverride?: string | null },
  ): Promise<CustomerGifts> {
    const { data } = await api.patch(`/admin/gifts/customers/${customerId}`, fields);
    return data;
  },
  async giveGift(customerId: number, input: GiveGiftInput): Promise<CustomerGifts> {
    const { data } = await api.post(`/admin/gifts/customers/${customerId}/gifts`, input);
    return data;
  },
  async decline(customerId: number, input: { milestoneYears: number; note?: string }): Promise<CustomerGifts> {
    const { data } = await api.post(`/admin/gifts/customers/${customerId}/declines`, input);
    return data;
  },
  async undo(giftId: number): Promise<CustomerGifts> {
    const { data } = await api.post(`/admin/gifts/${giftId}/undo`);
    return data;
  },
};
