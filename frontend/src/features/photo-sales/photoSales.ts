// The i18next singleton — same instance that src/i18n/config.ts initializes at
// app startup. Importing the singleton directly (instead of the config module)
// keeps react-i18next out of this module's import graph, so components using
// these helpers stay testable with a minimal react-i18next mock.
import i18n from 'i18next';

/**
 * Photo-sales gallery helpers (frontend side of the pricing rules).
 *
 * The free quota of a priced gallery is a ONE-TIME giveaway: the single-use
 * promo code deducts a fixed credit of free_photo_count × gallery price
 * on the first order that applies it. Prices are confirmed on the server before checkout and stored
 * in an immutable order snapshot — mirroring
 * backend/src/modules/photoSales/priceRules.js.
 */

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
  expires_at?: string | null;
  /** True until the gallery's one-time promo code has been redeemed once —
   *  a buyer who forgets the code does not burn the quota. */
  free_quota_available?: boolean;
  promo_code?: string | null;
}

export interface PhotoSalesConfig {
  enabled: boolean;
  slug: string;
  checkoutReady: boolean;
  promoCode: string | null;
  freeCount: number;
  price: number;
  currency: string;
  accessDays: number;
  /** The cart line's description: what the buyer gets, and until when. */
  itemDescription: string;
}

/**
 * When a purchase made now stops downloading: purchase_access_days from now,
 * but never after the gallery expires (the backend caps it the same way —
 * an expired gallery is archived and takes the originals with it).
 */
export function purchaseAccessUntil(accessDays: number, galleryExpiresAt?: string | null, now = Date.now()): Date {
  const accessEnd = now + accessDays * 24 * 60 * 60 * 1000;
  const galleryEnd = galleryExpiresAt ? new Date(galleryExpiresAt).getTime() : NaN;
  return new Date(Number.isFinite(galleryEnd) ? Math.min(accessEnd, galleryEnd) : accessEnd);
}

export function buildPhotoSalesConfig(args: {
  slug: string;
  event?: PhotoSalesEventInfo | null;
  checkoutConfigured?: boolean;
}): PhotoSalesConfig {
  const { slug, event, checkoutConfigured } = args;
  const isPriced = event?.is_priced === true;
  const price = Number(event?.photo_price ?? 0);
  // The free quota is a one-time giveaway per gallery: the promo code is
  // single-use and the server flips free_quota_available to false after it
  // has been redeemed once (an order without the code leaves the quota).
  const accessDays = Math.max(1, Math.floor(Number(event?.purchase_access_days ?? 30)));
  const accessUntil = purchaseAccessUntil(accessDays, event?.expires_at).toLocaleString(
    typeof i18n?.language === 'string' && i18n.language.toLowerCase().startsWith('de') ? 'de-DE' : undefined,
    { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }
  ) + ' UTC';
  const freeCount = event?.free_quota_available !== false
    ? Math.max(0, Math.floor(Number(event?.free_photo_count ?? 0)))
    : 0;
  return {
    enabled: isPriced && Number.isFinite(price) && price > 0,
    slug,
    checkoutReady: isPriced && !!checkoutConfigured && Number.isFinite(price) && price > 0,
    promoCode: freeCount > 0 ? event?.promo_code || null : null,
    freeCount,
    price: Number.isFinite(price) ? price : 0,
    currency: 'EUR',
    accessDays,
    itemDescription: i18n.t('photoSales.itemDescription', {
      date: accessUntil,
      defaultValue: 'Full quality, without watermark. Download until {{date}}.',
    }),
  };
}

/**
 * The price one PAID photo shows in the cart: the per-photo override when
 * set, otherwise the gallery default. Mirrors effectivePhotoPrice in the
 * backend for display; the server always calculates the checkout price itself.
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
