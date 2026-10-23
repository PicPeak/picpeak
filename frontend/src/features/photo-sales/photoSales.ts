// The i18next singleton — same instance that src/i18n/config.ts initializes at
// app startup. Importing the singleton directly (instead of the config module)
// keeps react-i18next out of this module's import graph, so components using
// these helpers stay testable with a minimal react-i18next mock.
import i18n from 'i18next';

/**
 * Photo-sales gallery helpers (frontend side of the pricing rules).
 *
 * The free quota of a priced gallery is a ONE-TIME giveaway: the single-use
 * promo code deducts the first `free_photo_count` photos on the first order
 * that applies it. Prices stay correct in the cart and are re-verified
 * server-side against the database at order.completed — mirroring
 * backend/src/modules/photoSales/priceRules.js.
 */

export interface PhotoSalesPhoto {
  id: number;
  uploaded_at?: string | null;
  photo_price?: number | null;
}

/**
 * Currency formatting for photo prices. German UI convention puts the euro
 * symbol AFTER the amount (0,24 €); other languages keep the browser locale.
 */
export function formatPhotoPrice(value: number, currency = 'EUR'): string {
  const locale = typeof i18n?.language === 'string' && i18n.language.toLowerCase().startsWith('de')
    ? 'de-DE'
    : undefined;
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value);
}

export interface PhotoSalesEventInfo {
  is_priced?: boolean;
  free_photo_count?: number;
  photo_price?: number | null;
  purchase_access_days?: number;
  /** True until the gallery's one-time promo code has been redeemed once —
   *  a buyer who forgets the code does not burn the quota. */
  free_quota_available?: boolean;
}

export interface PhotoSalesConfig {
  enabled: boolean;
  slug: string;
  apiKey: string | null;
  freeCount: number;
  price: number;
  currency: string;
  priceCheckUrl: string;
  accessDays: number;
}

export function buildPhotoSalesConfig(args: {
  slug: string;
  event?: PhotoSalesEventInfo | null;
  apiKey?: string | null;
}): PhotoSalesConfig {
  const { slug, event, apiKey } = args;
  const isPriced = event?.is_priced === true;
  const price = Number(event?.photo_price ?? 0);
  // The free quota is a one-time giveaway per gallery: the promo code is
  // single-use and the server flips free_quota_available to false after it
  // has been redeemed once (an order without the code leaves the quota).
  const freeCount = event?.free_quota_available !== false
    ? Math.max(0, Math.floor(Number(event?.free_photo_count ?? 0)))
    : 0;
  return {
    enabled: isPriced && Number.isFinite(price) && price > 0,
    slug,
    apiKey: apiKey || null,
    freeCount,
    price: Number.isFinite(price) ? price : 0,
    currency: 'EUR',
    // Absolute price-check URL: Snipcart's order validation resolves
    // root-relative data-item-url values against the dashboard's default
    // domain, and fails the order while that field is empty. An absolute URL
    // removes that failure mode (the host still has to be the dashboard's
    // default domain or an allowed domain).
    priceCheckUrl: typeof window !== 'undefined'
      ? `${window.location.origin}/api/gallery/${encodeURIComponent(slug)}/price-check`
      : `/api/gallery/${encodeURIComponent(slug)}/price-check`,
    accessDays: Math.max(1, Math.floor(Number(event?.purchase_access_days ?? 30))),
  };
}

/**
 * The price one PAID photo shows in the cart: the per-photo override when
 * set, otherwise the gallery default. Mirrors effectivePhotoPrice in the
 * backend so the client-side data-item-price always matches the server's
 * price-check answer.
 */
export function effectivePhotoPrice(
  galleryPrice: number,
  photoPriceOverride?: number | null
): number {
  if (photoPriceOverride !== null && photoPriceOverride !== undefined) {
    const value = Number(photoPriceOverride);
    if (Number.isFinite(value)) return value;
  }
  return Number(galleryPrice) || 0;
}

/**
 * The data-item-* attributes Snipcart needs on an add-to-cart control. Every
 * buy button (tile chip, hover icon, lightbox) must carry the SAME item id
 * per photo so Snipcart increments one line instead of stacking duplicates.
 *
 * Cart presentation: the photo thumbnail replaces the bare name, the photoId
 * custom field travels hidden (it is still sent with the order for the
 * webhook), and max-quantity 1 caps every photo at a single copy.
 */
export function snipcartItemProps(args: {
  slug: string;
  priceCheckUrl: string;
  price: number;
  photo: {
    id: number;
    filename?: string;
    original_filename?: string | null;
    thumbnail_url?: string | null;
  };
}): Record<string, string | number> {
  const { slug, priceCheckUrl, price, photo } = args;
  const props: Record<string, string | number> = {
    'data-item-id': `${slug}-photo-${photo.id}`,
    'data-item-price': price,
    'data-item-url': `${priceCheckUrl}${priceCheckUrl.includes('?') ? '&' : '?'}photoId=${photo.id}`,
    'data-item-name': photo.original_filename || photo.filename || `Photo ${photo.id}`,
    'data-item-description': `${slug} — photo ${photo.id}`,
    // Digital goods: photos are delivered through our purchased-downloads
    // page, never shipped. Snipcart removes all shipping options from a cart
    // whose items are all non-shippable — no shipping config in the dashboard
    // needed and no "No shipping method available" error at checkout.
    'data-item-shippable': 'false',
    'data-item-max-quantity': 1,
    'data-item-custom1-name': 'photoId',
    'data-item-custom1-value': String(photo.id),
    'data-item-custom1-type': 'hidden',
  };
  if (photo.thumbnail_url && typeof window !== 'undefined') {
    props['data-item-image'] = photo.thumbnail_url.startsWith('http')
      ? photo.thumbnail_url
      : `${window.location.origin}${photo.thumbnail_url}`;
  }
  return props;
}
