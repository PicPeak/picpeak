import React from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../components/common';
import type { PhotoOrdersPayload } from './usePhotoOrders';

/** Configuration presence is separate from successful provider connection. */
export const PhotoSalesStoreNotice: React.FC<{ store: PhotoOrdersPayload['store'] }> = ({ store }) => {
  const { t } = useTranslation();
  if (!store) return null;
  if (store.checkout_configured && store.webhook_configured) return store.test_mode ? (
    <Notice tone="warning" title={t('photoSales.storeTestMode', 'Photo sales are in Stripe test mode')}>
      {t('photoSales.storeTestModeHelp', 'Test payments do not collect money. Configure live credentials before accepting real purchases.')}
    </Notice>
  ) : null;

  const missing = [
    !store.checkout_configured && 'STRIPE_SECRET_KEY',
    !store.webhook_configured && 'STRIPE_WEBHOOK_SECRET',
  ].filter(Boolean).join(', ');

  return (
    <Notice tone="warning" title={t('photoSales.storeNotConfigured', 'Photo sales are not set up on this server')}>
      {store.checkout_configured
        ? t('photoSales.storeNoWebhook', 'Purchases are unavailable until a super admin completes the webhook setup in Settings → Payments, or the server operator configures {{keys}}.', { keys: missing })
        : t('photoSales.storeNoCheckout', 'Guests see watermarked previews. A super admin can set up Stripe in Settings → Payments, or the server operator can configure {{keys}}.', { keys: missing })}
    </Notice>
  );
};
