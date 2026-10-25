import React from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { ShoppingBag, Send, Link2 } from 'lucide-react';
import { api } from '../../../config/api';
import { Badge, Card, Loading, type BadgeTone } from '../../../components/common';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { formatPhotoPrice } from '../../../features/photo-sales/photoSales';
import { PhotoSalesStoreNotice } from '../../../features/photo-sales/PhotoSalesStoreNotice';
import {
  photoOrdersQueryKey, usePhotoOrders, type PhotoOrderSummary,
} from '../../../features/photo-sales/usePhotoOrders';

interface OrdersTabProps {
  eventId: number;
}

/** Badge for an order: what Snipcart and the audit made of it. */
function useOrderStatus() {
  const { t } = useTranslation();
  return (order: PhotoOrderSummary): { tone: BadgeTone; label: string } => {
    switch (order.status) {
      case 'completed':
        return order.remaining_days > 0
          ? { tone: 'success', label: t('photoSales.statusPaid', 'Paid') }
          : { tone: 'neutral', label: t('photoSales.statusExpired', 'Access ended') };
      case 'refunded':
        return { tone: 'neutral', label: t('photoSales.statusRefunded', 'Refunded') };
      case 'refund_failed':
        return { tone: 'danger', label: t('photoSales.statusRefundFailed', 'Refund failed') };
      case 'charged_back':
        return { tone: 'danger', label: t('photoSales.statusChargedBack', 'Charged back') };
      default:
        return { tone: 'neutral', label: t('photoSales.statusCancelled', 'Cancelled') };
    }
  };
}

/**
 * Photo sales — per-gallery "Orders" tab.
 * Lists every order with what became of it, and lets the gallery's owner copy
 * or re-send the buyer's access link of a paid order.
 */
export const OrdersTab: React.FC<OrdersTabProps> = ({ eventId }) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const queryClient = useQueryClient();
  const orderStatus = useOrderStatus();
  const { data, isLoading, isError, refetch } = usePhotoOrders(eventId);

  const resendMutation = useMutation({
    mutationFn: (orderId: string) =>
      api.post(`/admin/events/${eventId}/photo-orders/${encodeURIComponent(orderId)}/resend-email`),
    onSuccess: () => {
      toast.success(t('photoSales.resendSuccess', 'Access email sent again'));
      queryClient.invalidateQueries({ queryKey: photoOrdersQueryKey(eventId) });
    },
    onError: (error: any) => {
      toast.error(error?.response?.data?.error || t('photoSales.resendError', 'Failed to resend email'));
    },
  });

  // The link is fetched on demand: the order list never carries it, so only
  // the gallery's owner (the route checks) can copy a buyer's link.
  const copyLink = async (order: PhotoOrderSummary) => {
    try {
      const { data: link } = await api.post(
        `/admin/events/${eventId}/photo-orders/${encodeURIComponent(order.order_id)}/access-link`
      );
      await navigator.clipboard.writeText(link.access_link);
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
          className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-accent border border-accent rounded-lg hover:bg-hover"
        >
          {t('common.retry')}
        </button>
      </Card>
    );
  }

  const orders = data?.orders || [];
  const paid = orders.filter((order) => order.status === 'completed');
  const revenueCents = paid.reduce((sum, order) => sum + (Number(order.total_cents) || 0), 0);
  const money = (cents: number, currency?: string) => formatPhotoPrice(cents / 100, currency || 'EUR');

  return (
    <div className="space-y-4">
      <PhotoSalesStoreNotice store={data?.store} />

      {orders.length === 0 ? (
        <Card padding="md">
          <div className="flex items-center gap-3 text-soft">
            <ShoppingBag className="w-5 h-5 shrink-0" />
            <p>{t('photoSales.noOrders', 'No purchases yet. Buyers get an order listed here as soon as a Snipcart checkout completes.')}</p>
          </div>
        </Card>
      ) : (
        <Card padding="md">
          <p className="mb-3 text-sm text-soft">
            {t('photoSales.ordersSummary', '{{count}} paid orders · {{revenue}} revenue', {
              count: paid.length,
              revenue: money(revenueCents),
            })}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="border-b border-line text-soft">
                  <th className="py-2 pr-4 font-medium">{t('photoSales.buyer', 'Buyer')}</th>
                  <th className="py-2 pr-4 font-medium">{t('photoSales.status', 'Status')}</th>
                  <th className="py-2 pr-4 font-medium text-right">{t('photoSales.photos', 'Photos')}</th>
                  <th className="py-2 pr-4 font-medium text-right">{t('photoSales.amount', 'Amount')}</th>
                  <th className="hidden md:table-cell py-2 pr-4 font-medium">{t('photoSales.purchasedAt', 'Purchased')}</th>
                  <th className="py-2 pr-4 font-medium">{t('photoSales.accessLeft', 'Access left')}</th>
                  <th className="py-2 font-medium"><span className="sr-only">{t('photoSales.actions', 'Actions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => {
                  const status = orderStatus(order);
                  const active = order.status === 'completed' && order.remaining_days > 0;
                  return (
                    <tr key={order.order_id} className="border-b border-line-faint last:border-0">
                      <td className="py-3 pr-4 text-heading break-all">{order.buyer_email || '—'}</td>
                      <td className="py-3 pr-4 whitespace-nowrap"><Badge tone={status.tone}>{status.label}</Badge></td>
                      <td className="py-3 pr-4 text-body text-right tabular-nums">{order.status === 'completed' ? order.photo_count : '—'}</td>
                      <td className="py-3 pr-4 text-body text-right tabular-nums whitespace-nowrap">
                        {money(Number(order.total_cents) || 0, order.currency)}
                      </td>
                      <td className="hidden md:table-cell py-3 pr-4 text-soft whitespace-nowrap">
                        {order.purchased_at ? format(new Date(order.purchased_at), 'PPp') : '—'}
                      </td>
                      <td className="py-3 pr-4 text-soft whitespace-nowrap">
                        {active ? t('photoSales.daysLeft', '{{days}} days', { days: order.remaining_days }) : '—'}
                      </td>
                      <td className="py-3">
                        {active && (
                          <div className="flex items-center justify-end gap-2">
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
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-accent border border-accent rounded-lg hover:bg-hover disabled:opacity-50 whitespace-nowrap"
                            >
                              <Send className="w-3.5 h-3.5" />
                              {t('photoSales.resend', 'Resend link')}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
};
