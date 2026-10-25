'use strict';

/**
 * Photo sales — what may be sold, and to whom.
 *
 * The Snipcart price check and the order webhook are public: Snipcart's
 * servers call them without a gallery session, and the cart line's URL (which
 * names the gallery and the photo) is set by the browser. So neither can rely
 * on the gallery login. Three rules close that gap, and every sale path
 * (price check, webhook, purchase link) applies the same ones:
 *
 *   - the gallery is on sale: priced, active, not archived, not a draft and
 *     not expired (isGalleryOnSale);
 *   - the photo is one an ordinary guest sees: live, visible, not under
 *     review, processed, and not a video (sellablePhotos);
 *   - the cart line carries a sale signature that only a viewer who passed
 *     the gallery's access check receives with the photo list
 *     (signPhotoSale). Knowing a slug and guessing sequential photo ids is
 *     not enough to buy from a password-protected gallery.
 */

const crypto = require('crypto');
const {
  livePhotos, applyPhotoVisibilityFilter, wherePhotoProcessed, isPhotoProcessed,
} = require('../../utils/photoVisibility');
const { isGalleryAvailable } = require('../../utils/galleryLifecycle');
const { isGalleryPriced } = require('./priceRules');

/** The one currency photo sales charge in (the cart is configured for it). */
const SALES_CURRENCY = 'EUR';

/** The events columns isGalleryOnSale reads. */
const ON_SALE_COLUMNS = ['id', 'slug', 'is_priced', 'is_active', 'is_archived', 'is_draft', 'expires_at'];

function isGalleryOnSale(event) {
  return isGalleryPriced(event) && isGalleryAvailable(event);
}

function isVideoPhoto(photo) {
  return photo.media_type === 'video' || String(photo.mime_type || '').startsWith('video/');
}

/**
 * The photos of a gallery that can be sold: what an ordinary guest sees in
 * the gallery list, without videos (they are not sold).
 */
function sellablePhotos(conn, eventId) {
  const query = livePhotos(conn)
    .where('photos.event_id', eventId)
    .whereNull('photos.moderation_status');
  applyPhotoVisibilityFilter(query, 'guest');
  wherePhotoProcessed(query);
  return query
    .where(function () {
      this.whereNull('photos.media_type').orWhereNot('photos.media_type', 'video');
    })
    .where(function () {
      this.whereNull('photos.mime_type').orWhereNot('photos.mime_type', 'like', 'video/%');
    });
}

/** Single-row form of sellablePhotos, for a photo already read. */
function isPhotoSellable(photo) {
  return !!photo
    && photo.deleted_at == null
    && photo.moderation_status == null
    && (photo.visibility == null || photo.visibility === 'visible')
    && isPhotoProcessed(photo)
    && !isVideoPhoto(photo);
}

function saleSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required to sign photo sales');
  return secret;
}

/**
 * The sale signature of one photo (hex, 32 chars). A photo id belongs to one
 * gallery, and every check also requires the photo to be a sellable photo of
 * the gallery being bought from.
 */
function signPhotoSale(photoId) {
  return crypto.createHmac('sha256', saleSecret())
    .update(`photo-sale:${Number(photoId)}`)
    .digest('hex')
    .slice(0, 32);
}

function verifyPhotoSale(photoId, signature) {
  const candidate = String(signature || '');
  if (!/^[0-9a-f]{32}$/.test(candidate)) return false;
  const expected = signPhotoSale(photoId);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(candidate));
}

/** The `sig` query parameter of a cart line's URL (null when absent). */
function saleSignatureFromUrl(url) {
  const match = String(url || '').match(/[?&]sig=([0-9a-f]+)/i);
  return match ? match[1].toLowerCase() : null;
}

module.exports = {
  SALES_CURRENCY,
  ON_SALE_COLUMNS,
  isGalleryOnSale,
  isVideoPhoto,
  sellablePhotos,
  isPhotoSellable,
  signPhotoSale,
  verifyPhotoSale,
  saleSignatureFromUrl,
};
