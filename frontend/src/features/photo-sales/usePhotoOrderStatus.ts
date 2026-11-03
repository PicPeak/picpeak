import { useTranslation } from 'react-i18next';
import type { BadgeTone } from '../../components/common';

/** Badge for an order: payment and delivery state. */
export function useOrderStatus() {
  const { t } = useTranslation();
  return (order: { status: string; needs_attention?: boolean; remaining_days?: number }): { tone: BadgeTone; label: string } => {
    if (order.needs_attention) return { tone: 'danger', label: t('photoSales.statusAttention', 'Needs attention') };
    switch (order.status) {
      case 'pending':
      case 'creation_unknown':
        return { tone: 'warning', label: t('photoSales.statusPending', 'Awaiting payment') };
      case 'processing':
        return { tone: 'warning', label: t('photoSales.statusProcessing', 'Payment processing') };
      case 'refund_pending':
        return { tone: 'warning', label: t('photoSales.statusRefundPending', 'Refund pending') };
      case 'expired':
      case 'failed':
        return { tone: 'neutral', label: t('photoSales.statusUnpaid', 'Not paid') };
      case 'completed':
        return (order.remaining_days || 0) > 0
          ? { tone: 'success', label: t('photoSales.statusPaid', 'Paid') }
          : { tone: 'neutral', label: t('photoSales.statusExpired', 'Access ended') };
      case 'refunded':
        return { tone: 'neutral', label: t('photoSales.statusRefunded', 'Refunded') };
      case 'refund_failed':
        return { tone: 'danger', label: t('photoSales.statusRefundFailed', 'Refund failed') };
      case 'charged_back':
        return { tone: 'danger', label: t('photoSales.statusChargedBack', 'Charged back') };
      case 'cancelled':
        return { tone: 'neutral', label: t('photoSales.statusCancelled', 'Cancelled') };
      default:
        return { tone: 'neutral', label: t('photoSales.statusUnknown', 'Unknown') };
    }
  };
}
