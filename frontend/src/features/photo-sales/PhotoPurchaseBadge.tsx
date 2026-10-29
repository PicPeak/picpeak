import React from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ShoppingCart } from 'lucide-react';
import { usePhotoSales } from './PhotoSalesContext';
import { effectivePhotoPrice, formatPhotoPrice } from './photoSales';
import { twMerge } from 'tailwind-merge';

interface PurchaseBadgePhoto {
  id: number;
  filename?: string;
  original_filename?: string | null;
  uploaded_at?: string | null;
  photo_price?: number | null;
  thumbnail_url?: string | null;
  sale_token?: string | null;
  type?: string;
  media_type?: string;
}

/**
 * Photo sales — always-visible price chip on gallery tiles.
 *
 * One tap adds the photo to the cart at its price (gallery price or
 * per-photo override); a photo already in the cart reads "In cart" and opens
 * the cart instead. A dark translucent pill, so it reads on light and dark
 * photos alike. Photos that are not for sale (no sale_token) get no chip.
 */
export const PhotoPurchaseBadge: React.FC<{ photo: PurchaseBadgePhoto; className?: string }> = ({ photo, className }) => {
  const { t } = useTranslation();
  const photoSales = usePhotoSales();

  if (!photoSales.checkoutReady) return null;
  if (photo.type === 'video' || photo.media_type === 'video') return null;

  const price = effectivePhotoPrice(photoSales.price, photo.photo_price);
  const priceLabel = formatPhotoPrice(price, photoSales.currency || 'EUR');
  if (!photo.sale_token) return null;
  const inCart = photoSales.cartItemIds.has(photo.id);

  return (
    <button
      type="button"
      className={twMerge('photo-sales-chip absolute bottom-2 left-2 z-10 inline-flex items-center gap-1.5 rounded-full py-1 pl-2 pr-2.5 text-xs font-semibold pointer-events-auto', className)}
      aria-label={inCart
        ? t('photoSales.inCartOpen', 'In your cart — open the cart')
        : t('photoSales.addToCartPrice', 'Add photo to cart for {{price}}', { price: priceLabel })}
      title={inCart ? undefined : t('photoSales.buyTitle', 'Buy this photo in full quality, without watermark')}
      data-photo-purchase
      data-in-cart={inCart ? 'true' : undefined}
      onClick={(event) => { event.stopPropagation(); if (inCart) photoSales.openCart(); else photoSales.addToCart(photo); }}
    >
      {inCart ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <ShoppingCart className="w-3.5 h-3.5" aria-hidden="true" />}
      {inCart ? t('photoSales.inCart', 'In cart') : priceLabel}
    </button>
  );
};
