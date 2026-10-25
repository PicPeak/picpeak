import React from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../components/common';
import type { PhotoOrdersPayload } from './usePhotoOrders';

/**
 * Warns the admin of a priced gallery that this install cannot sell: without
 * SNIPCART_API_KEY guests see watermarked previews and no cart, without
 * SNIPCART_SECRET_API_KEY every order webhook is refused and no buyer gets
 * their photos.
 */
export const PhotoSalesStoreNotice: React.FC<{ store: PhotoOrdersPayload['store'] }> = ({ store }) => {
  const { t } = useTranslation();
  if (!store || (store.checkout_configured && store.webhook_configured)) return null;

  const missing = [
    !store.checkout_configured && 'SNIPCART_API_KEY',
    !store.webhook_configured && 'SNIPCART_SECRET_API_KEY',
  ].filter(Boolean).join(', ');

  return (
    <Notice tone="warning" title={t('photoSales.storeNotConfigured', 'Photo sales are not set up on this server')}>
      {store.checkout_configured
        ? t('photoSales.storeNoWebhook', 'Guests can fill a cart, but paid orders are never delivered until {{keys}} is set.', { keys: missing })
        : t('photoSales.storeNoCheckout', 'Guests see watermarked previews and cannot buy until {{keys}} is set.', { keys: missing })}
    </Notice>
  );
};
