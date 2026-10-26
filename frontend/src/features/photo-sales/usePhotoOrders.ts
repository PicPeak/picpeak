import { useQuery } from '@tanstack/react-query';
import { api } from '../../config/api';

/** What became of an order: granted, or refused/revoked (see the webhook). */
export type PhotoOrderStatus = 'pending' | 'creation_unknown' | 'processing' | 'completed' | 'refund_pending' | 'refunded' | 'refund_failed' | 'charged_back' | 'cancelled' | 'expired' | 'failed';

export interface PhotoOrderSummary {
  order_id: string;
  payment_provider: 'snipcart' | 'stripe';
  buyer_email: string;
  total_cents: number;
  currency: string;
  status: PhotoOrderStatus | string;
  purchased_at: string | null;
  expires_at: string | null;
  photo_count: number;
  remaining_days: number;
}

export interface PhotoOrdersPayload {
  orders: PhotoOrderSummary[];
  /** Configuration presence, not a provider connectivity check. */
  store?: { provider: 'stripe'; checkout_configured: boolean; webhook_configured: boolean; test_mode: boolean };
}

export const photoOrdersQueryKey = (eventId: number) => ['admin-event-photo-orders', eventId];

/** The gallery's photo orders and the store configuration, for the admin. */
export function usePhotoOrders(eventId: number | undefined, enabled = true) {
  return useQuery<PhotoOrdersPayload>({
    queryKey: photoOrdersQueryKey(eventId ?? 0),
    queryFn: () => api.get(`/admin/events/${eventId}/photo-orders`).then((r) => r.data),
    enabled: !!eventId && enabled,
  });
}
