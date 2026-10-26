import React, { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, Trash2 } from 'lucide-react';
import { Modal } from '../../components/common/Modal';
import { api } from '../../config/api';
import type { CartPhoto } from './PhotoSalesContext';
import { formatPhotoPrice, type PhotoSalesConfig } from './photoSales';
import { checkoutBrowserKey } from './checkoutBrowserKey';
import { AuthenticatedImage } from '../../components/common/AuthenticatedImage';
import { Button } from '../../components/common/Button';

export const PhotoSalesCart: React.FC<{
  open: boolean; onClose: () => void; config: PhotoSalesConfig;
  items: CartPhoto[]; onRemove: (id: number) => void;
}> = ({ open, onClose, config, items, onRemove }) => {
  const { t, i18n } = useTranslation();
  const [promoCode, setPromoCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const promoHintId = useId();
  const request = useRef<{ signature: string; key: string }>();
  const gross = items.reduce((sum, item) => sum + Math.round(item.price * 100), 0);
  const promoApplied = !!config.promoCode && promoCode.trim().toUpperCase() === config.promoCode;
  const discount = promoApplied ? Math.min(gross, Math.round(config.freeCount * config.price * 100)) : 0;
  const format = (minor: number) => formatPhotoPrice(minor / 100, config.currency);

  const checkout = async () => {
    if (busy || !items.length) return;
    setBusy(true);
    setError('');
    const photoIds = items.map((item) => item.id);
    const code = promoCode.trim().toUpperCase();
    const signature = JSON.stringify([config.slug, photoIds, code]);
    if (request.current?.signature !== signature) request.current = { signature, key: crypto.randomUUID() };
    try {
      const response = await api.post<{ checkout_url?: string; return_url?: string }>(`/gallery/${encodeURIComponent(config.slug)}/checkout`, {
        photoIds, promoCode: code, checkoutKey: request.current.key, browserKey: checkoutBrowserKey(), language: i18n?.language || 'en',
      });
      const destination = response.data.checkout_url || response.data.return_url;
      if (!destination) throw new Error('Missing checkout destination');
      window.location.assign(destination);
    } catch (caught) {
      const code = (caught as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (code === 'CHECKOUT_ENDED') request.current = undefined;
      const messages: Record<string, string> = {
        PHOTOS_UNAVAILABLE: t('photoSales.checkoutPhotosUnavailable', 'Some selected photos are no longer available. Remove them and try again.'),
        PROMO_UNAVAILABLE: t('photoSales.checkoutPromoUnavailable', 'This promo code is used or reserved by another checkout. Try again later or remove the code.'),
        GALLERY_CLOSING: t('photoSales.checkoutGalleryClosing', 'This gallery closes too soon to start a checkout. Please contact your photographer.'),
        CHECKOUT_ENDED: t('photoSales.checkoutEnded', 'That checkout has ended. Select Continue to start a new one.'),
      };
      setError(messages[code || ''] || t('photoSales.checkoutRetry', 'Checkout is temporarily unavailable. Your cart is saved; please try again.'));
      setBusy(false);
    }
  };

  return <Modal
    open={open} onClose={() => { if (!busy) onClose(); }}
    title={t('photoSales.cart', 'Cart')} description={config.itemDescription}
    footer={<>
      <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>{t('photoSales.keepBrowsing', 'Keep browsing')}</Button>
      <Button type="button" isLoading={busy} focusableWhileLoading disabled={!items.length} onClick={checkout}>
        {busy ? t('photoSales.openingCheckout', 'Opening checkout…') : t('photoSales.continueCheckout', 'Continue to payment')}
      </Button>
    </>}
  >
    {!items.length ? <p className="text-muted py-6 text-center">{t('photoSales.cartEmpty', 'Add photos to your cart to get started.')}</p> : <>
      <ul className="divide-y divide-line">
        {items.map((item) => <li key={item.id} className="flex items-center gap-3 py-3">
          {item.thumbnail ? <AuthenticatedImage src={item.thumbnail} isGallery slug={config.slug} alt="" className="w-14 h-14 object-cover rounded-lg" />
            : <div className="w-14 h-14 rounded-lg bg-inset flex items-center justify-center"><Image className="w-6 h-6 text-muted" aria-hidden="true" /></div>}
          <span className="flex-1 min-w-0 truncate text-body">{item.name}</span>
          <span className="text-heading tabular-nums">{format(Math.round(item.price * 100))}</span>
          <button type="button" className="p-2 rounded-lg text-muted hover:text-body hover:bg-hover" disabled={busy} onClick={() => onRemove(item.id)} aria-label={t('photoSales.removeFromCart', 'Remove {{name}} from cart', { name: item.name })}>
            <Trash2 className="w-4 h-4" aria-hidden="true" />
          </button>
        </li>)}
      </ul>
      {config.freeCount > 0 && <div className="mt-4 text-sm text-body">
        <label className="block">
          {t('photoSales.promoCode', 'Promo code')}
          <input className="input mt-1 w-full" aria-describedby={config.promoCode ? promoHintId : undefined} value={promoCode} onChange={(event) => { setPromoCode(event.target.value); setError(''); }} maxLength={64} autoComplete="off" disabled={busy} />
        </label>
        {config.promoCode && <p id={promoHintId} className="mt-1 text-xs text-muted">{t('photoSales.availablePromo', 'One-time gallery code: {{code}}', { code: config.promoCode })}</p>}
      </div>}
      <dl className="mt-5 space-y-2 text-sm">
        {discount > 0 && <div className="flex justify-between text-body"><dt>{t('photoSales.promoDiscount', 'Gallery promo')}</dt><dd>−{format(discount)}</dd></div>}
        <div className="flex justify-between text-heading font-semibold"><dt>{t('photoSales.total', 'Total')}</dt><dd>{format(gross - discount)}</dd></div>
      </dl>
      <p className="mt-3 text-xs text-muted">{t('photoSales.checkoutPriceHint', 'Prices and availability are confirmed when you continue. Payment is handled securely by Stripe.')}</p>
      {items.length >= 100 && <p className="mt-2 text-sm text-body">{t('photoSales.cartLimit', 'You can purchase up to 100 photos per order.')}</p>}
    </>}
    {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}
  </Modal>;
};
