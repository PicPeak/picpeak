import React from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { ShoppingBag, Send, Link2 } from 'lucide-react';
import { api } from '../../../config/api';
import { Card, Loading } from '../../../components/common';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';

interface PhotoOrderSummary {
  order_id: string;
  buyer_email: string;
  total_cents: number;
  currency: string;
  purchased_at: string | null;
  expires_at: string | null;
  photo_count: number;
  remaining_days: number;
  access_token: string | null;
}

interface OrdersPayload {
  orders: PhotoOrderSummary[];
}

interface OrdersTabProps {
  eventId: number;
  /** Full purchase link host + path prefix, e.g. window.location.origin. */
  baseUrl: string;
}

/**
 * Photo sales — per-gallery "Orders" tab.
 * Lists every purchase and lets the admin re-send the access link.
 */
export const OrdersTab: React.FC<OrdersTabProps> = ({ eventId, baseUrl }) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery<OrdersPayload>({
    queryKey: ['admin-event-photo-orders', eventId],
    queryFn: () => api.get(`/admin/events/${eventId}/photo-orders`).then((r) => r.data),
    enabled: !!eventId,
  });

  const resendMutation = useMutation({
    mutationFn: (orderId: string) =>
      api.post(`/admin/events/${eventId}/photo-orders/${encodeURIComponent(orderId)}/resend-email`),
    onSuccess: () => {
      toast.success(t('photoSales.resendSuccess', 'Access email sent again'));
      queryClient.invalidateQueries({ queryKey: ['admin-event-photo-orders', eventId] });
    },
    onError: (error: any) => {
      toast.error(error?.response?.data?.error || t('photoSales.resendError', 'Failed to resend email'));
    },
  });

  const accessLink = (order: PhotoOrderSummary) =>
    order.access_token ? `${baseUrl.replace(/\/$/, '')}/purchased-downloads/${order.access_token}` : '';

  const copyLink = async (order: PhotoOrderSummary) => {
    const link = accessLink(order);
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.info(t('photoSales.linkCopied', 'Access link copied'));
    } catch {
      toast.error(t('photoSales.copyError', 'Could not copy the link'));
    }
  };

  if (isLoading) {
    return <Loading size="lg" text={t('photoSales.loadingOrders', 'Loading orders…')} />;
  }

  if (isError) {
    return (
      <Card padding="md">
        <p className="text-heading">{t('gallery.failedToLoad')}</p>
        <button
          onClick={() => refetch()}
          className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-accent border border-accent rounded-lg hover:bg-accent/10"
        >
          {t('common.retry')}
        </button>
      </Card>
    );
  }

  const orders = data?.orders || [];

  if (orders.length === 0) {
    return (
      <Card padding="md">
        <div className="flex items-center gap-3 text-soft">
          <ShoppingBag className="w-5 h-5" />
          <p>{t('photoSales.noOrders', 'No purchases yet. Buyers get an order listed here as soon as a Snipcart checkout completes.')}</p>
        </div>
      </Card>
    );
  }

  return (
    <Card padding="md">
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead>
            <tr className="border-b border-line text-soft">
              <th className="py-2 pr-4 font-medium">{t('photoSales.buyer', 'Buyer')}</th>
              <th className="py-2 pr-4 font-medium">{t('photoSales.photos', 'Photos')}</th>
              <th className="py-2 pr-4 font-medium">{t('photoSales.amount', 'Amount')}</th>
              <th className="py-2 pr-4 font-medium">{t('photoSales.purchasedAt', 'Purchased')}</th>
              <th className="py-2 pr-4 font-medium">{t('photoSales.accessLeft', 'Access left')}</th>
              <th className="py-2 font-medium">{t('photoSales.actions', 'Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => {
              const total = (Number(order.total_cents) || 0) / 100;
              const expired = order.remaining_days <= 0;
              return (
                <tr key={order.order_id} className="border-b border-line-faint">
                  <td className="py-3 pr-4 text-body">{order.buyer_email}</td>
                  <td className="py-3 pr-4 text-body">{order.photo_count}</td>
                  <td className="py-3 pr-4 text-body">
                    {new Intl.NumberFormat(undefined, { style: 'currency', currency: order.currency || 'EUR' }).format(total)}
                  </td>
                  <td className="py-3 pr-4 text-soft">
                    {order.purchased_at ? format(new Date(order.purchased_at), 'PPp') : '—'}
                  </td>
                  <td className={`py-3 pr-4 ${expired ? 'text-danger' : 'text-soft'}`}>
                    {expired
                      ? t('photoSales.expired', 'Expired')
                      : t('photoSales.daysLeft', '{{days}} days', { days: order.remaining_days })}
                  </td>
                  <td className="py-3">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => copyLink(order)}
                        className="p-1.5 rounded-lg border border-line-strong text-body hover:bg-hover"
                        title={t('photoSales.copyLink', 'Copy access link')}
                        aria-label={t('photoSales.copyLink', 'Copy access link')}
                      >
                        <Link2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => resendMutation.mutate(order.order_id)}
                        disabled={resendMutation.isPending}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-accent border border-accent rounded-lg hover:bg-accent/10 disabled:opacity-50"
                      >
                        <Send className="w-3.5 h-3.5" />
                        {t('photoSales.resend', 'Resend link')}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
};
