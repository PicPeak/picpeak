/**
 * Photo sales — Snipcart order webhooks.
 *
 * Mounted in server.js AHEAD of the global JSON body parsers (the
 * development HMAC needs the exact bytes) and ahead of the global API rate
 * limiter, so it carries its own limiter.
 *
 * Authentication is Snipcart v3's official mechanism: the
 * X-Snipcart-RequestToken header, verified against Snipcart's
 * /api/requestvalidation/{token} endpoint with the SECRET key. The order is
 * then fetched from Snipcart's API with the same key, and THAT order — not
 * the webhook body — is the source of truth for the total, the currency, the
 * payment status and the cart lines. SNIPCART_WEBHOOK_SECRET (a static HMAC
 * over the body, used by scripts/simulate-snipcart-webhook.js) is honoured
 * outside production only; the body is then trusted as the order.
 *
 * Every order event reconciles one order with what Snipcart says about it:
 *
 *   - paid (Paid / PaidDeferred) and not yet granted → audit, then grant;
 *   - refunded (even partly), charged back, cancelled, failed or expired →
 *     revoke;
 *   - anything else (Deferred, Pending, Authorized …) → wait for the next
 *     order.paymentStatus.changed.
 *
 * The audit refuses an order whose gallery is not on sale, whose lines are
 * not signed sellable photos of that gallery, whose currency is not the
 * sales currency, or whose charged total differs from the total recomputed
 * from the database. A refused order is refunded and stored with the refund
 * outcome so the admin sees it. The row is claimed before the refund, so two
 * concurrent deliveries of one refused order refund it once.
 *
 * Idempotent by Snipcart order id: an order already stored is never granted
 * twice (UNIQUE order_id).
 */

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { db } = require('../../database/db');
const { errorResponse } = require('../../utils/routeHelpers');
const { rateLimitKey } = require('../../utils/rateLimitKey');
const { queueEmail } = require('../../services/emailProcessor');
const { createPurchaseAccessToken, buildPurchasedDownloadUrl } = require('../../modules/photoSales/purchaseAccess');
const { getFrontendBaseUrl } = require('../../utils/frontendUrl');
const logger = require('../../utils/logger');
const { allocateFreeLines } = require('../../modules/photoSales/priceRules');
const { isDiscountId } = require('../../modules/photoSales/promoDiscount');
const {
  SALES_CURRENCY, ON_SALE_COLUMNS, isGalleryOnSale, sellablePhotos, verifyPhotoSale, saleSignatureFromUrl,
} = require('../../modules/photoSales/sellable');

const router = express.Router();

const SNIPCART_API = 'https://app.snipcart.com/api';
const PAID_STATUSES = new Set(['Paid', 'PaidDeferred']);
const REVOKING_PAYMENT_STATUSES = new Set(['Refunded', 'ChargedBack', 'Cancelled', 'Failed', 'Expired']);
const ORDER_EVENTS = new Set([
  'order.completed', 'order.paymentStatus.changed', 'order.status.changed', 'order.refund.created',
]);

// Every unauthenticated POST costs an outbound call to Snipcart, and this
// router sits ahead of the global API limiter.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  // Snipcart delivers from a few IPs; a busy shop must not hit 429s.
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
});

function snipcartAuthHeader() {
  const secret = (process.env.SNIPCART_SECRET_API_KEY || '').trim();
  return secret ? `Basic ${Buffer.from(`${secret}:`).toString('base64')}` : null;
}

/**
 * Refund an order through the Snipcart API (secret key). Returns
 * 'refunded' or 'refund_failed' — the outcome is stored on the order row.
 */
async function refundSnipcartOrder(orderToken, amount, comment) {
  const auth = snipcartAuthHeader();
  if (!auth || !orderToken || !Number.isFinite(amount) || amount <= 0) return 'refund_failed';
  try {
    const response = await fetch(`${SNIPCART_API}/orders/${encodeURIComponent(orderToken)}/refunds`, {
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
    logger.error(`Snipcart refund error for order ${orderToken}: ${error.message}`);
    return 'refund_failed';
  }
}

/** The order as Snipcart's API knows it, or null when it cannot be read. */
async function fetchSnipcartOrder(orderToken) {
  const auth = snipcartAuthHeader();
  if (!auth || !orderToken) return null;
  try {
    const response = await fetch(`${SNIPCART_API}/orders/${encodeURIComponent(orderToken)}`, {
      headers: { Authorization: auth, Accept: 'application/json' },
    });
    if (!response.ok) {
      logger.warn(`Snipcart order ${orderToken} could not be fetched: HTTP ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    logger.warn(`Snipcart order ${orderToken} could not be fetched: ${error.message}`);
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
 * Development-only HMAC over the raw body (scripts/simulate-snipcart-
 * webhook.js). Never accepted in production: it has no timestamp and no
 * replay protection.
 */
function verifyDevelopmentSignature(rawBody, signature) {
  if (process.env.NODE_ENV === 'production') return false;
  const secret = (process.env.SNIPCART_WEBHOOK_SECRET || '').trim();
  if (!secret || !signature) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const candidate = String(signature).replace(/^hmac_/, '').trim();
  if (!candidate || expected.length !== candidate.length) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(candidate, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Snipcart v3's official webhook authentication: every request carries an
 * X-Snipcart-RequestToken that is verified against Snipcart's API with the
 * SECRET key (valid for one minute, usable once).
 */
async function verifySnipcartRequestToken(token) {
  const auth = snipcartAuthHeader();
  if (!auth || !token) return false;
  try {
    const response = await fetch(
      `${SNIPCART_API}/requestvalidation/${encodeURIComponent(String(token))}`,
      { headers: { Authorization: auth, Accept: 'application/json' } }
    );
    return response.ok;
  } catch (error) {
    logger.warn(`Snipcart request token validation failed: ${error.message}`);
    return false;
  }
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

function orderTokenOf(payload) {
  const content = payload?.content || {};
  return content?.token || content?.orderToken || payload?.orderToken || content?.order?.token || null;
}

/** The body's order, for the development signature path only. */
function orderFromBody(payload) {
  const content = payload?.content || {};
  return content?.order || (content?.token ? content : null);
}

function centsOf(amount) {
  const value = Number(amount);
  return Number.isFinite(value) ? Math.round(value * 100) : NaN;
}

/** Revoke a granted order: the link and every purchase row stop working. */
async function revokeOrder(orderToken, status) {
  const order = await db('photo_purchase_orders').where({ order_id: String(orderToken) }).first('id', 'status');
  if (!order || order.status !== 'completed') return false;
  const now = new Date().toISOString();
  await db.transaction(async (trx) => {
    await trx('photo_purchase_orders').where({ id: order.id }).update({ status, updated_at: now });
    await trx('photo_purchases').where({ order_id: String(orderToken) }).update({ expires_at: now, updated_at: now });
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
async function rejectOrder(order, gallery, reason) {
  const orderToken = String(order.token);
  const chargedCents = centsOf(order.total);
  logger.error(`Snipcart order ${orderToken} refused: ${reason}. Refunding.`);
  const refund = () => refundSnipcartOrder(
    orderToken, chargedCents / 100, `Photo sales: ${reason} — refunded automatically`
  );
  if (!gallery) {
    // No gallery to store the order against (gallery_id is NOT NULL).
    logger.error(`Snipcart order ${orderToken} has no known gallery; refund outcome: ${await refund()}`);
    return;
  }
  await db('photo_purchase_orders').insert({
    order_id: orderToken,
    gallery_id: gallery.id,
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
  });
  if (await refund() === 'refunded') {
    await db('photo_purchase_orders')
      .where({ order_id: orderToken })
      .update({ status: 'refunded', updated_at: new Date().toISOString() });
  }
}

/**
 * When a granted purchase stops: purchase_access_days from now, but never
 * after the gallery expires — expiry deactivates and archives the gallery,
 * which takes the originals (and every purchase link) down with it.
 */
function purchaseExpiry(gallery) {
  const days = Number(gallery.purchase_access_days || 30);
  const accessEnd = Date.now() + (Number.isFinite(days) ? days : 30) * 24 * 60 * 60 * 1000;
  const galleryEnd = gallery.expires_at ? new Date(gallery.expires_at).getTime() : NaN;
  return new Date(Number.isFinite(galleryEnd) ? Math.min(accessEnd, galleryEnd) : accessEnd).toISOString();
}

/** Audit a paid order against the database, then grant or refuse it. */
async function grantOrder(order) {
  const orderToken = String(order.token);
  const items = Array.isArray(order.items) ? order.items : [];

  const gallerySlug = gallerySlugFromOrderItems(items);
  const gallery = gallerySlug
    ? await db('events')
      .where({ slug: gallerySlug })
      .first(...ON_SALE_COLUMNS, 'event_name', 'photo_price', 'purchase_access_days', 'free_photo_count', 'promo_code', 'snipcart_discount_id')
    : null;
  if (!gallery) return rejectOrder(order, null, 'the cart does not name one priced gallery');
  if (!isGalleryOnSale(gallery)) return rejectOrder(order, gallery, 'the gallery is not on sale');

  const currency = String(order.currency || '').toUpperCase();
  if (currency !== SALES_CURRENCY) {
    return rejectOrder(order, gallery, `currency ${currency || 'unknown'} is not ${SALES_CURRENCY}`);
  }

  // Every line must be one signed, sellable photo of this gallery, once.
  const photoIds = [];
  for (const item of items) {
    const photoId = photoIdOfItem(item);
    if (!photoId || photoIds.includes(photoId) || Number(item?.quantity ?? 1) !== 1
        || !verifyPhotoSale(photoId, saleSignatureFromUrl(item?.url))) {
      return rejectOrder(order, gallery, 'a cart line is not a signed photo of this gallery');
    }
    photoIds.push(photoId);
  }
  if (!photoIds.length) return rejectOrder(order, gallery, 'the cart holds no photos');
  const sellableRows = await sellablePhotos(db, gallery.id)
    .whereIn('photos.id', photoIds)
    .select('photos.id', 'photos.photo_price');
  const byId = new Map(sellableRows.map((row) => [Number(row.id), row]));
  if (photoIds.some((id) => !byId.has(id))) {
    return rejectOrder(order, gallery, 'a photo in the cart is not for sale');
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
    .where({ gallery_id: gallery.id, promo_used: true })
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
    return rejectOrder(
      order,
      gallery,
      `charged ${chargedTotalCents}c, expected ${expectedTotalCents}c`
    );
  }

  const buyerEmail = order.email || order.user?.email || order.billingAddress?.email || '';
  const purchasedAt = new Date().toISOString();
  const expiresAt = purchaseExpiry(gallery);
  const accessToken = createPurchaseAccessToken();

  await db.transaction(async (trx) => {
    await trx('photo_purchase_orders').insert({
      order_id: orderToken,
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
    });
    await trx('photo_purchases').insert(allocation.map((line) => ({
      order_id: orderToken,
      gallery_id: gallery.id,
      photo_id: Number(line.photoId),
      buyer_email: buyerEmail,
      purchased_at: purchasedAt,
      expires_at: expiresAt,
      access_token: accessToken,
      currency: SALES_CURRENCY,
      amount_cents: line.amountCents,
    })));
  });

  if (buyerEmail) {
    await queueEmail(null, buyerEmail, 'photo_purchase_access', {
      buyer_email: buyerEmail,
      gallery_name: gallery.event_name || gallerySlug,
      access_link: buildPurchasedDownloadUrl({ baseUrl: await getFrontendBaseUrl(), accessToken }),
      purchased_at: purchasedAt,
      expires_at: expiresAt,
      download_count: photoIds.length,
      photo_count: photoIds.length,
    });
    await db('photo_purchase_orders').where({ order_id: orderToken }).update({ email_sent: true });
  }

  logger.info(`Snipcart order ${orderToken} granted: gallery ${gallerySlug}, ${photoIds.length} photo(s), ${chargedTotalCents}c`);
  return undefined;
}

async function handleWebhook(req, res) {
  try {
    const requestToken = req.headers['x-snipcart-requesttoken'];
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));

    const tokenValid = await verifySnipcartRequestToken(requestToken);
    const developmentSigned = !tokenValid && verifyDevelopmentSignature(rawBody, req.headers['x-snipcart-signature']);
    if (!tokenValid && !developmentSigned) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const eventName = payload?.eventName;
    if (!ORDER_EVENTS.has(eventName)) return res.status(200).json({ ok: true });

    const orderToken = orderTokenOf(payload);
    if (!orderToken) {
      logger.warn(`Snipcart webhook ${eventName}: missing order token`);
      return res.status(400).json({ error: 'Missing order token' });
    }

    // The order as Snipcart's API knows it. A failed fetch answers 502 so
    // Snipcart delivers the webhook again.
    const order = tokenValid ? await fetchSnipcartOrder(orderToken) : orderFromBody(payload);
    if (!order && eventName === 'order.refund.created' && developmentSigned) {
      await revokeOrder(orderToken, 'refunded');
      return res.status(200).json({ ok: true });
    }
    if (!order) return res.status(502).json({ error: 'Order could not be read from Snipcart' });
    order.token = order.token || orderToken;

    // A partial refund leaves the payment status at Paid; any refunded
    // amount revokes the order all the same.
    const refunded = order.paymentStatus === 'Refunded' || Number(order.refundsAmount) > 0;
    if (REVOKING_PAYMENT_STATUSES.has(order.paymentStatus) || order.status === 'Cancelled' || refunded) {
      const status = order.paymentStatus === 'ChargedBack' ? 'charged_back'
        : refunded ? 'refunded' : 'cancelled';
      await revokeOrder(orderToken, status);
      return res.status(200).json({ ok: true });
    }
    if (!PAID_STATUSES.has(order.paymentStatus)) {
      logger.info(`Snipcart order ${orderToken}: payment ${order.paymentStatus || 'unknown'}, not granted yet`);
      return res.status(200).json({ ok: true });
    }

    const stored = await db('photo_purchase_orders').where({ order_id: String(orderToken) }).first('id');
    if (!stored) {
      try {
        await grantOrder(order);
      } catch (error) {
        // A redelivery racing the first delivery loses on UNIQUE order_id.
        const raced = await db('photo_purchase_orders').where({ order_id: String(orderToken) }).first('id');
        if (!raced) throw error;
      }
    }
    // The body never carries the access token: Snipcart keeps webhook
    // responses in its dashboard logs.
    return res.status(200).json({ ok: true });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to process Snipcart order');
  }
}

// Photo sales: ONE static dashboard entry serves every gallery —
// the slug-less route derives the gallery from the order's item URLs. The
// per-slug path stays for already-configured URLs and is handled the same.
router.post('/snipcart-webhook', webhookLimiter, express.raw({ type: '*/*', limit: '2mb' }), handleWebhook);
router.post('/:slug/snipcart-webhook', webhookLimiter, express.raw({ type: '*/*', limit: '2mb' }), handleWebhook);

module.exports = router;
