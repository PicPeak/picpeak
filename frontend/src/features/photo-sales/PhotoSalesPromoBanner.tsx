import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Gift } from 'lucide-react';
import { usePhotoSales } from './PhotoSalesContext';

/**
 * Photo sales — the one-time promo code above the grid. The free quota of
 * the FIRST order is redeemed by entering the code at checkout (Snipcart
 * discount, single use, synced by the backend). Shown only while the
 * discount exists in the store and has not been used.
 */
export const PhotoSalesPromoBanner: React.FC<{
  promoCode: string | null | undefined;
  discountReady: boolean | undefined;
}> = ({ promoCode, discountReady }) => {
  const { t } = useTranslation();
  const { checkoutReady, freeCount } = usePhotoSales();
  const [copied, setCopied] = useState(false);

  if (!checkoutReady || freeCount <= 0 || !discountReady || !promoCode) return null;

  const copy = () => {
    navigator.clipboard?.writeText(promoCode).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  return (
    <div className="photo-sales-promo mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl px-4 py-3" data-testid="photo-sales-promo-code">
      <span className="photo-sales-promo-icon inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full" aria-hidden="true">
        <Gift className="h-4 w-4" />
      </span>
      <div className="min-w-[12rem] flex-1">
        <p className="text-sm font-semibold text-theme">
          {t('photoSales.promoTitle', '{{count}} photos free with your first order', { count: freeCount })}
        </p>
        <p className="text-xs text-muted-theme">
          {t('photoSales.promoHint', 'Enter the code at checkout. It works once per gallery.')}
        </p>
      </div>
      <button
        type="button"
        onClick={copy}
        className="photo-sales-promo-code inline-flex w-full sm:w-auto items-center justify-center gap-2 rounded-lg px-3 py-2 sm:py-1.5 font-mono text-sm font-semibold tracking-wider"
        aria-label={t('photoSales.promoCodeCopyLabel', 'Copy promo code {{code}}', { code: promoCode })}
      >
        {promoCode}
        {copied
          ? <Check className="h-4 w-4" aria-hidden="true" />
          : <Copy className="h-4 w-4 opacity-70" aria-hidden="true" />}
        <span className="sr-only" role="status">{copied ? t('photoSales.promoCodeCopied', 'Copied!') : ''}</span>
      </button>
    </div>
  );
};
