import React from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ShoppingCart } from 'lucide-react';
import { Button } from '../../components/common/Button';
import { usePhotoSales, type PurchasePhoto } from './PhotoSalesContext';
import { effectivePhotoPrice, formatPhotoPrice } from './photoSales';

/** The same purchase action in the shared and Premium lightboxes. */
export const PhotoPurchaseButton: React.FC<{ photo: PurchasePhoto; onOpenCart?: () => void }> = ({ photo, onOpenCart }) => {
  const { t } = useTranslation();
  const sales = usePhotoSales();
  if (!sales.checkoutReady || !photo.sale_token) return null;
  const inCart = sales.cartItemIds.has(photo.id);
  const price = formatPhotoPrice(effectivePhotoPrice(sales.price, photo.photo_price), sales.currency);
  return <Button
    type="button" className="rounded-full shrink-0" leftIcon={inCart ? <Check className="w-4 h-4" /> : <ShoppingCart className="w-4 h-4" />}
    onClick={() => {
      if (inCart) { onOpenCart?.(); sales.openCart(); }
      else sales.addToCart(photo);
    }}
    aria-label={inCart ? t('photoSales.inCartOpen', 'In your cart — open the cart') : t('photoSales.addToCartPrice', 'Add photo to cart for {{price}}', { price })}
  >{inCart ? t('photoSales.inCart', 'In cart') : t('photoSales.addToCartPrice', 'Add photo to cart for {{price}}', { price })}</Button>;
};
