import React from 'react';
import { useTranslation } from 'react-i18next';
import { ShoppingCart } from 'lucide-react';
import { usePhotoSales } from './PhotoSalesContext';

/**
 * Photo sales — the gallery header's cart button. Same accent CTA as the
 * header's Download button it replaces in a priced gallery; `.snipcart-
 * checkout` makes Snipcart open the cart. The count shows only once the cart
 * holds something, so an empty or still-loading cart shows no empty bubble.
 */
export const PhotoSalesCartButton: React.FC = () => {
  const { t } = useTranslation();
  const { checkoutReady, cartCount } = usePhotoSales();
  if (!checkoutReady) return null;

  const label = cartCount > 0
    ? t('photoSales.cartWithCount', 'Cart, {{count}} photos', { count: cartCount })
    : t('photoSales.cart', 'Cart');

  return (
    <button
      type="button"
      className="snipcart-checkout gallery-btn inline-flex items-center gap-2 px-3 sm:px-4 h-9 rounded-lg text-sm font-medium transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
      style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-accent-fg, #ffffff)' }}
      aria-label={label}
      title={label}
    >
      <ShoppingCart className="w-4 h-4" aria-hidden="true" />
      <span className="hidden sm:inline">{t('photoSales.cart', 'Cart')}</span>
      {cartCount > 0 && (
        <span
          className="photo-sales-cart-count inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full text-xs font-semibold tabular-nums"
          aria-hidden="true"
        >
          {cartCount}
        </span>
      )}
    </button>
  );
};
