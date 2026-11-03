import React, { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Clock, AlertTriangle } from 'lucide-react';
import { api } from '../../config/api';
import { readCheckoutBrowserKey } from '../../features/photo-sales/checkoutBrowserKey';
import { Button } from '../../components/common/Button';

interface CheckoutStatus {
  status: string;
  gallery_url: string;
  gallery_slug: string;
  purchased_photo_ids: number[];
  download_url: string | null;
}

export const PhotoCheckoutPage: React.FC = () => {
  const { token = '' } = useParams<{ token: string }>();
  const [params] = useSearchParams();
  const cancelled = params.get('cancelled') === '1';
  const { t } = useTranslation();
  const [data, setData] = useState<CheckoutStatus>();
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const requestConfig = { headers: { 'X-Photo-Checkout-Key': readCheckoutBrowserKey() || '' } };
    setData(undefined);
    setError(false);
    const load = async () => {
      try {
        const response = await api.get<CheckoutStatus>(`/photo-checkout/${encodeURIComponent(token)}`, requestConfig);
        if (stopped) return;
        setData(response.data);
        setError(false);
        if (response.data.status === 'completed') {
          try {
            const key = `picpeak_photo_cart_${response.data.gallery_slug}`;
            const cart: unknown = JSON.parse(sessionStorage.getItem(key) || '[]');
            if (Array.isArray(cart)) sessionStorage.setItem(key, JSON.stringify(cart.filter((item) => !response.data.purchased_photo_ids.includes(item?.id))));
          } catch { /* Storage is optional; purchase access does not depend on it. */ }
        }
        if (['pending', 'creation_unknown', 'processing', 'refund_pending'].includes(response.data.status) && ++attempts < 30) {
          timer = setTimeout(load, 2000);
        }
      } catch { if (!stopped) setError(true); }
    };
    const start = async () => {
      if (cancelled) {
        try { await api.post(`/photo-checkout/${encodeURIComponent(token)}/cancel`, {}, requestConfig); }
        catch { if (!stopped) { setError(true); return; } }
      }
      if (!stopped) await load();
    };
    void start();
    return () => { stopped = true; clearTimeout(timer); };
  }, [token, cancelled, retry]);

  const complete = data?.status === 'completed';
  const waiting = !data || ['pending', 'creation_unknown', 'processing'].includes(data.status);
  const refunded = ['refund_pending', 'refunded', 'refund_failed'].includes(data?.status || '');
  const title = error ? t('photoSales.checkoutStatusError', 'We could not confirm your checkout')
    : complete ? t('photoSales.checkoutComplete', 'Your photos are ready')
      : waiting ? t('photoSales.checkoutConfirming', 'Confirming your payment')
        : refunded ? t('photoSales.checkoutRefundTitle', 'Your order could not be delivered')
          : t('photoSales.checkoutNotCompleted', 'Checkout has ended');
  const help = error ? t('photoSales.checkoutStatusErrorHelp', 'Please check again before starting another payment. Your checkout may still be processing. You can also use the download link emailed after payment is confirmed.')
    : complete ? t('photoSales.checkoutCompleteHelp', 'Open your downloads below. A download link will also be sent to the email address you used at checkout.')
      : waiting ? t('photoSales.checkoutPendingHelp', 'Some payment methods take longer to confirm. Your download link will be emailed when payment is confirmed. Please avoid paying again while it is processing.')
        : data?.status === 'refund_failed' ? t('photoSales.checkoutRefundFailedHelp', 'Your photos are unavailable and the automatic refund needs attention. Please contact your photographer with your payment receipt.')
          : data?.status === 'refund_pending' ? t('photoSales.checkoutRefundPendingHelp', 'Your photos are unavailable. Your refund is being processed; please contact your photographer if you need help.')
            : data?.status === 'refunded' ? t('photoSales.checkoutRefundedHelp', 'This order has been refunded. Please contact your photographer if you need help.')
              : data?.status === 'charged_back' ? t('photoSales.checkoutDisputedHelp', 'Download access has been withdrawn because this payment is disputed. Please contact your photographer.')
                : t('photoSales.checkoutCancelledHelp', 'No photos have been unlocked. Your cart is saved, so you can return to the gallery and try again.');
  const Icon = complete ? CheckCircle2 : waiting && !error ? Clock : AlertTriangle;
  return <main className="min-h-screen bg-background flex items-center justify-center px-4 py-12">
    <div className="w-full max-w-lg rounded-2xl bg-surface border border-border p-6 sm:p-8 text-center">
      <Icon className="w-10 h-10 mx-auto mb-4 text-theme" aria-hidden="true" />
      <div role="status" aria-live="polite">
        <h1 className="text-2xl font-semibold text-theme">{title}</h1>
        <p className="mt-3 text-muted-theme">{help}</p>
      </div>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        {complete && data?.download_url && <Link className="btn btn-md btn-primary" to={data.download_url}>{t('photoSales.openDownloads', 'Open downloads')}</Link>}
        {data?.gallery_url && <Link className="btn btn-md btn-secondary" to={data.gallery_url}>{t('photoSales.returnToGallery', 'Return to gallery')}</Link>}
        {(error || waiting || data?.status === 'refund_pending') && <Button type="button" variant="secondary" onClick={() => setRetry((value) => value + 1)}>{t('photoSales.checkAgain', 'Check again')}</Button>}
      </div>
    </div>
  </main>;
};
