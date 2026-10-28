'use strict';
const { db } = require('../../database/db');
const { createPurchaseAccessToken } = require('./purchaseAccess');
const logger = require('../../utils/logger');
const { purchaseExpiry, purchaseRows, sendPurchaseEmail } = require('./fulfilment');
const { allocateFreeLines } = require('./priceRules');
const { isDiscountId } = require('./promoDiscount');
const { SALES_CURRENCY, ON_SALE_COLUMNS, isGalleryOnSale, sellablePhotos, verifyPhotoSale, saleSignatureFromUrl } = require('./sellable');
const snipcartSettings = require('./snipcartSettings');
const { reservationToken, findProviderOrder, grantReservation } = require('./snipcartCheckout');
const PAID_STATUSES = new Set(['Paid', 'PaidDeferred']);
const REVOKING_PAYMENT_STATUSES = new Set(['Refunded', 'ChargedBack', 'Cancelled', 'Failed', 'Expired']);
/**
 * Refund an order through the Snipcart API (secret key). Returns
 * 'refunded' or 'refund_failed' — the outcome is stored on the order row.
 */
async function refundSnipcartOrder(orderToken, amount, comment) {
  const auth = snipcartSettings.auth(await snipcartSettings.credentials());
  if (!auth || !orderToken || !Number.isFinite(amount) || amount <= 0) return 'refund_failed';
  try {
    const response = await snipcartSettings.request(`/orders/${encodeURIComponent(orderToken)}/refunds`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ amount, comment, notifyCustomer: true }),
    });
    if (!response.ok) {
      logger.error(`Snipcart refund failed for order ${orderToken}: HTTP ${response.status}`);
      return 'refund_failed';
    }
    return 'refunded';
  } catch (error) {
    logger.error(`Snipcart refund error for order ${orderToken}: ${error.type || error.name}`);
    return 'refund_failed';
  }
}

/** The order as Snipcart's API knows it, or null when it cannot be read. */
async function fetchSnipcartOrder(orderToken) {
  const auth = snipcartSettings.auth(await snipcartSettings.credentials());
  if (!auth || !orderToken) return null;
  try {
    const response = await snipcartSettings.request(`/orders/${encodeURIComponent(orderToken)}`, {
      headers: { Authorization: auth, Accept: 'application/json' },
    });
    if (!response.ok) {
      logger.warn(`Snipcart order ${orderToken} could not be fetched: HTTP ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    logger.warn(`Snipcart order ${orderToken} could not be fetched: ${error.type || error.name}`);
    return null;
  }
}

function photoIdOfItem(item) {
  const candidates = [
    item?.customFields?.photoId,
    item?.custom_fields?.photoId,
  ];
  for (const field of Array.isArray(item?.customFields) ? item.customFields : []) {
    if (String(field?.name || '').toLowerCase() === 'photoid') candidates.push(field?.value);
  }
  const fromUrl = String(item?.url || '').match(/[?&]photoId=(\d+)/);
  if (fromUrl) candidates.push(fromUrl[1]);
  for (const candidate of candidates) {
    const num = Number(candidate);
    if (Number.isInteger(num) && num > 0) return num;
  }
  return null;
}

/**
 * Gallery slug derived from the order itself: every cart line carries a
 * data-item-url pointing at /api/gallery/<slug>/price-check?photoId=… — so
 * ONE static webhook URL serves every gallery. All lines must name the same
 * gallery; a mixed cart answers null.
 */
function gallerySlugFromOrderItems(items) {
  const slugs = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const match = String(item?.url || '').match(/\/api\/gallery\/([^/?]+)\/price-check/);
    if (!match) return null;
    try { slugs.add(decodeURIComponent(match[1])); } catch { slugs.add(match[1]); }
  }
  return slugs.size === 1 ? [...slugs][0] : null;
}

function centsOf(amount) {
  const value = Number(amount);
  return Number.isFinite(value) ? Math.round(value * 100) : NaN;
}

/** Revoke a granted order: the link and every purchase row stop working. */
async function revokeOrder(orderToken, status) {
  const order = await findProviderOrder(orderToken);
  if (!order || ['refunded', 'charged_back', 'cancelled'].includes(order.status)) return false;
  const now = new Date().toISOString();
  await db.transaction(async (trx) => {
    await trx('photo_purchase_orders').where({ id: order.id }).update({ status, recovery_needs_attention: false, recovery_error: null, ...(!order.promo_used ? { promo_gallery_id: null } : {}), updated_at: now });
    await trx('photo_purchases').where({ order_id: order.order_id }).update({ expires_at: now, updated_at: now });
  });
  logger.info(`Snipcart order ${orderToken} revoked (${status})`);
  return true;
}

/**
 * Refuse a paid order: refund it and, when its gallery is known, store it
 * with the refund outcome and no purchase rows.
 *
 * The row is claimed BEFORE the refund: a concurrent delivery of the same
 * order loses on UNIQUE order_id and never reaches the refund. It reads
 * refund_failed until Snipcart accepts the refund, so a total that cannot be
 * refunded (missing, or nothing charged) or a crash in between leaves the
 * order flagged for the admin, never reported as refunded.
 */
async function rejectOrder(order, gallery, reason, reserved = null) {
  const orderToken = String(order.token);
  const chargedCents = centsOf(order.total);
  logger.error(`Snipcart order ${orderToken} refused: ${reason}. Refunding.`);
  const refund = () => refundSnipcartOrder(
    orderToken, chargedCents / 100, `Photo sales: ${reason} — refunded automatically`
  );
  const record = {
    order_id: orderToken, provider_order_id: orderToken, payment_provider: 'snipcart',
    recovery_needs_attention: chargedCents > 0, recovery_error: 'REFUND_UNCONFIRMED',
    gallery_id: gallery?.id || null,
    buyer_email: order.email || '',
    total_cents: Number.isFinite(chargedCents) ? Math.max(0, chargedCents) : 0,
    currency: String(order.currency || '').toUpperCase().slice(0, 8),
    status: 'refund_failed',
    purchased_at: new Date().toISOString(),
    expires_at: null,
    // Never handed out: the column is NOT NULL UNIQUE, and no purchase row
    // carries it, so it grants nothing.
    access_token: createPurchaseAccessToken(),
    email_sent: false,
    promo_used: false,
  };
  let recordId;
  if (reserved) {
    const changed = await db('photo_purchase_orders').where({ id: reserved.id }).whereIn('status', ['pending', 'creation_unknown', 'processing', 'expired'])
      .where((q) => q.whereNull('provider_order_id').orWhere({ provider_order_id: orderToken })).update({ ...record, order_id: reserved.order_id, access_token: reserved.access_token });
    if (changed) recordId = reserved.id;
    else if (await findProviderOrder(orderToken)) return;
  }
  if (!recordId) {
    const inserted = await db('photo_purchase_orders').insert(record).returning('id');
    recordId = inserted[0]?.id ?? inserted[0];
  }
  if (chargedCents === 0 || await refund() === 'refunded') {
    await db('photo_purchase_orders')
      .where({ id: recordId })
      .update({ status: 'refunded', recovery_needs_attention: false, recovery_error: null, promo_gallery_id: null, updated_at: new Date().toISOString() });
  }
}

/** Audit a paid order against the database, then grant or refuse it. */
async function grantOrder(order) {
  const orderToken = String(order.token);
  const items = Array.isArray(order.items) ? order.items : [];
  const token = reservationToken(items);
  const reserved = token ? await db('photo_purchase_orders').where({ payment_provider: 'snipcart', checkout_token: token }).first() : null;
  const reject = (gallery, reason) => rejectOrder(order, gallery, reason, reserved && (!reserved.provider_order_id || reserved.provider_order_id === orderToken) ? reserved : null);
  if (token === false || (token && !reserved)) return reject(null, 'the checkout reservation is invalid');

  const gallerySlug = gallerySlugFromOrderItems(items);
  const gallery = gallerySlug
    ? await db('events')
      .where({ slug: gallerySlug })
      .first(...ON_SALE_COLUMNS, 'event_name', 'photo_price', 'purchase_access_days', 'free_photo_count', 'promo_code', 'snipcart_discount_id')
    : null;
  if (!gallery) return reject(null, 'the cart does not name one priced gallery');
  if (!isGalleryOnSale(gallery, { allowTemporarilyDisabled: true })) return reject(gallery, 'the gallery is not on sale');

  const currency = String(order.currency || '').toUpperCase();
  if (currency !== SALES_CURRENCY) {
    return reject(gallery, `currency ${currency || 'unknown'} is not ${SALES_CURRENCY}`);
  }

  // Every line must be one signed, sellable photo of this gallery, once.
  const photoIds = [];
  for (const item of items) {
    const photoId = photoIdOfItem(item);
    if (!photoId || photoIds.includes(photoId) || Number(item?.quantity ?? 1) !== 1
        || !verifyPhotoSale(photoId, saleSignatureFromUrl(item?.url))) {
      return reject(gallery, 'a cart line is not a signed photo of this gallery');
    }
    photoIds.push(photoId);
  }
  if (!photoIds.length) return reject(gallery, 'the cart holds no photos');
  const sellableRows = await sellablePhotos(db, gallery.id)
    .whereIn('photos.id', photoIds)
    .select('photos.id', 'photos.photo_price');
  const byId = new Map(sellableRows.map((row) => [Number(row.id), row]));
  if (photoIds.some((id) => !byId.has(id))) {
    return reject(gallery, 'a photo in the cart is not for sale');
  }

  if (reserved) {
    if (await grantReservation(reserved, order, gallery, photoIds)) return;
    return reject(gallery, 'the payment does not match an available checkout reservation');
  }

  // Per-order gross recomputed from the database: every photo carries its
  // effective price (override or gallery default). The free quota is the
  // one-time promo-code discount, verified below.
  const allocation = allocateFreeLines(
    { ...gallery, free_photo_count: 0 },
    photoIds.map((id) => ({ photoId: id, photo_price: byId.get(id).photo_price }))
  );
  const grossCents = allocation.reduce((sum, line) => sum + line.amountCents, 0);

  // One-time promo code: honoured exactly once per gallery — on the FIRST
  // order that actually applies it (the Snipcart discount is single-use).
  const priorPromoUse = await db('photo_purchase_orders')
    .where({ gallery_id: gallery.id })
    .where((q) => q.where({ promo_used: true }).orWhere({ promo_gallery_id: gallery.id }))
    .first('id');
  const discountCodes = (Array.isArray(order.discounts) ? order.discounts : [])
    .map((d) => String(d?.code || ''))
    .filter(Boolean);
  const codeApplied = !!(gallery.promo_code && discountCodes.includes(gallery.promo_code));
  const codeHonored = codeApplied && !priorPromoUse && isDiscountId(gallery.snipcart_discount_id);
  const freeValueCents = codeHonored
    ? Math.round(Math.max(0, Number(gallery.free_photo_count || 0)) * Number(gallery.photo_price || 0) * 100)
    : 0;
  const expectedTotalCents = Math.max(0, grossCents - freeValueCents);

  // Prices are tax-inclusive (docs/PHOTO_SALES.md), so the charged total is
  // the item total minus the discount. Anything else was re-priced or taxed
  // on top, and is refunded.
  const chargedTotalCents = centsOf(order.total);
  if (!Number.isFinite(chargedTotalCents) || Math.abs(chargedTotalCents - expectedTotalCents) > 1) {
    return reject(
      gallery,
      `charged ${chargedTotalCents}c, expected ${expectedTotalCents}c`
    );
  }

  const buyerEmail = order.email || order.user?.email || order.billingAddress?.email || '';
  let purchasedAt; let expiresAt;
  const accessToken = createPurchaseAccessToken();

  try {
    await db.transaction(async (trx) => {
      const eventQuery = trx('events').where({ id: gallery.id });
      if (trx.client.config.client === 'pg') eventQuery.forUpdate();
      const currentGallery = await eventQuery.first();
      if (!isGalleryOnSale(currentGallery, { allowTemporarilyDisabled: true })) throw Object.assign(new Error('Gallery closed'), { code: 'SALE_CLOSED' });
      const now = Date.now();
      purchasedAt = new Date(now).toISOString();
      expiresAt = purchaseExpiry(currentGallery, now);
      await trx('photo_purchase_orders').insert({
        order_id: orderToken, payment_provider: 'snipcart', provider_order_id: orderToken,
        gallery_id: gallery.id,
        buyer_email: buyerEmail,
        total_cents: chargedTotalCents,
        currency: SALES_CURRENCY,
        status: 'completed',
        purchased_at: purchasedAt,
        expires_at: expiresAt,
        access_token: accessToken,
        email_sent: false,
        promo_used: codeHonored,
        promo_gallery_id: codeHonored ? gallery.id : null,
      });
      await trx('photo_purchases').insert(purchaseRows({
        orderId: orderToken, galleryId: gallery.id, buyerEmail, purchasedAt,
        expiresAt, accessToken, currency: SALES_CURRENCY, lines: allocation,
      }));
    });
  } catch (error) {
    if (await findProviderOrder(orderToken)) return;
    if (error.code === 'SALE_CLOSED' || (codeApplied && await db('photo_purchase_orders').where({ promo_gallery_id: gallery.id }).first('id'))) {
      return reject(gallery, 'the gallery or its one-time promo is no longer available');
    }
    throw error;
  }

  await sendPurchaseEmail(
    await db('photo_purchase_orders').where({ order_id: orderToken }).first(),
    gallery.event_name || gallerySlug, photoIds.length,
  );

  logger.info(`Snipcart order ${orderToken} granted: gallery ${gallerySlug}, ${photoIds.length} photo(s), ${chargedTotalCents}c`);
  return undefined;
}


async function trackPendingOrder(order) {
  const token = reservationToken(order.items);
  if (!token || await findProviderOrder(order.token)) return;
  await db('photo_purchase_orders').where({ payment_provider: 'snipcart', checkout_token: token })
    .whereIn('status', ['pending', 'creation_unknown', 'processing']).whereNull('provider_order_id')
    .update({ provider_order_id: String(order.token), status: 'processing' });
}
async function reconcileOrder(order) {
  const orderToken = String(order.token);
  // A partial refund leaves the payment status at Paid; any refunded
  // amount revokes the order all the same.
  const refunded = order.paymentStatus === 'Refunded' || Number(order.refundsAmount) > 0;
  if (REVOKING_PAYMENT_STATUSES.has(order.paymentStatus) || order.status === 'Cancelled' || refunded) {
    const status = order.paymentStatus === 'ChargedBack' ? 'charged_back'
      : refunded ? 'refunded' : 'cancelled';
    await revokeOrder(orderToken, status);
    return;
  }
  if (!PAID_STATUSES.has(order.paymentStatus)) {
    await trackPendingOrder(order);
    logger.info(`Snipcart order ${orderToken}: payment ${order.paymentStatus || 'unknown'}, not granted yet`);
    return;
  }

  const stored = await findProviderOrder(orderToken);
  if (!stored || ['pending', 'creation_unknown', 'processing'].includes(stored.status)) {
    try {
      await grantOrder(order);
    } catch (error) {
      // A redelivery racing the first delivery loses on UNIQUE order_id.
      const raced = await findProviderOrder(orderToken);
      if (!raced || ['pending', 'creation_unknown', 'processing'].includes(raced.status)) throw error;
    }
  }
  const granted = await findProviderOrder(orderToken);
  if (granted?.status === 'completed' && !granted.email_sent) {
    const gallery = await db('events').where({ id: granted.gallery_id }).first('event_name', 'slug');
    const count = await db('photo_purchases').where({ order_id: granted.order_id }).count('* as n').first();
    await sendPurchaseEmail(granted, gallery?.event_name || gallery?.slug || '', Number(count.n));
  }

}
module.exports = { fetchSnipcartOrder, reconcileOrder };
