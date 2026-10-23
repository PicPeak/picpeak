import React from 'react';
import { useTranslation } from 'react-i18next';
import { ShoppingCart } from 'lucide-react';
import { usePhotoSales } from './PhotoSalesContext';
import { effectivePhotoPrice, formatPhotoPrice, snipcartItemProps } from './photoSales';

interface PurchaseBadgePhoto {
  id: number;
  filename?: string;
  original_filename?: string | null;
  uploaded_at?: string | null;
  photo_price?: number | null;
  thumbnail_url?: string | null;
  type?: string;
  media_type?: string;
}

/**
 * Photo sales — always-visible price chip on gallery tiles.
 *
 * One tap adds the photo to the Snipcart cart: paid photos show their
 * effective price (per-photo override or gallery default), free-tier photos
 * show "Free" and add a 0.00 item. Snipcart re-validates every item against
 * the DB-backed price-check URL, so the chip can never be re-priced by the
 * client.
 */
/**
 * Photo sales — always-visible price chip on gallery tiles.
 *
 * One tap adds the photo to the Snipcart cart at its base price (gallery
 * price or per-photo override). The first N photos of the ORDER are free —
 * the cart re-prices its lines live (cartAllocation) and the server audits
 * the total at order.completed.
 */
export const PhotoPurchaseBadge: React.FC<{ photo: PurchaseBadgePhoto }> = ({ photo }) => {
  const { t } = useTranslation();
  const photoSales = usePhotoSales();

  if (!photoSales.checkoutReady) return null;
  if (photo.type === 'video' || photo.media_type === 'video') return null;

  const price = effectivePhotoPrice(photoSales.price, photo.photo_price);
  const priceLabel = formatPhotoPrice(price, photoSales.currency || 'EUR');
  const itemProps = snipcartItemProps({
    slug: photoSales.slug,
    priceCheckUrl: photoSales.priceCheckUrl,
    price,
    photo,
  });

  return (
    <button
      type="button"
      className="snipcart-add-item absolute bottom-2 left-2 z-10 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold text-white bg-accent/95 hover:bg-accent shadow-md backdrop-blur-sm pointer-events-auto transition-colors"
      aria-label={t('photoSales.addToCartPrice', 'Add photo to cart for {{price}}', { price: priceLabel })}
      title={t('photoSales.buyTitle', 'Buy this photo in full quality, without watermark')}
      {...itemProps}
    >
      <ShoppingCart className="w-3.5 h-3.5" />
      {priceLabel}
    </button>
  );
};
