import React from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../components/common';
import type { PhotoOrdersPayload } from './usePhotoOrders';

/** Configuration presence is separate from successful provider connection. */
export const PhotoSalesStoreNotice: React.FC<{ store: PhotoOrdersPayload['store'] }> = ({ store }) => {
  const { t } = useTranslation();
  if (!store) return null;
  if (store.available.includes('stripe') && store.stripe.test_mode) return <Notice tone="warning" title={t('photoSales.storeTestMode', 'Photo sales are in Stripe test mode')}>
    {t('photoSales.storeTestModeHelp', 'Test payments do not collect money. Configure live credentials before accepting real purchases.')}
  </Notice>;
  if (store.available.length) return null;
  return <Notice tone="warning" title={t('photoSales.storeNotConfigured', 'Photo sales are not set up on this server')}>
    {t('photoSales.storeChooseProvider', 'Guests see watermarked previews. A super admin can configure Stripe, Snipcart, or both in Settings → Payments.')}
  </Notice>;
};
