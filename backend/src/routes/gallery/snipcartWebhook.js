/**
 * Photo sales — Snipcart order.completed webhook.
 *
 * Mounted in server.js AHEAD of the global JSON body parsers so the raw
 * body stays available (the optional legacy HMAC fallback needs the exact
 * bytes, and parsing early never hurts).
 *
 * Authentication is Snipcart v3's official mechanism: the
 * X-Snipcart-RequestToken header, verified against Snipcart's
 * /api/requestvalidation/{token} endpoint with the SECRET key (valid one
 * minute, single use). There is no separate webhook HMAC secret in v3;
 * SNIPCART_WEBHOOK_SECRET is kept only as an optional legacy fallback.
 *
 * Idempotent by Snipcart order id — a redelivered webhook answers 200 with
 * { duplicate: true } and creates nothing.
 */

const express = require('express');
const crypto = require('crypto');
const { db } = require('../../database/db');
const { livePhotos } = require('../../utils/photoVisibility');
const { errorResponse } = require('../../utils/routeHelpers');
const { queueEmail } = require('../../services/emailProcessor');
const { createPurchaseAccessToken, buildPurchasedDownloadUrl } = require('../../modules/photoSales/purchaseAccess');
const { getFrontendBaseUrl } = require('../../utils/frontendUrl');
const logger = require('../../utils/logger');
const { allocateFreeLines } = require('../../modules/photoSales/priceRules');

const router = express.Router();

/**
 * Refund an order through the Snipcart API (secret key). Used when the
 * DB-backed audit finds the charged amount doesn't match the per-order free
 * allocation — a tampered cart must not yield photos, and an honest buyer
 * must not lose money.
 */
async function refundSnipcartOrder(orderToken, amount, comment) {
  try {
    const secret = (process.env.SNIPCART_SECRET_API_KEY || '').trim();
    if (!secret || !orderToken || !Number.isFinite(amount) || amount <= 0) return false;
    const auth = Buffer.from(`${secret}:`).toString('base64');
    const response = await fetch(
      `https://payment.snipcart.com/api/orders/${encodeURIComponent(orderToken)}/refunds`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ amount, comment }),
      }
    );
    if (!response.ok) {
      logger.warn(`Snipcart refund failed for order ${orderToken}: HTTP ${response.status}`);
    }
    return response.ok;
  } catch (error) {
    logger.warn(`Snipcart refund error for order ${orderToken}: ${error.message}`);
    return false;
  }
}

/**
 * Photo ids in the order's line order (deduplicated, first occurrence wins
 * the position). The free allocation runs against THIS order, not against
 * item ids — same rule as the client-side cart allocation.
 */
function orderedPhotoIds(items) {
  const ids = [];
  for (const item of Array.isArray(items) ? items : []) {
    const candidates = [
      item?.photoId,
      item?.photo_id,
      item?.customFields?.photoId,
      item?.customFields?.photo_id,
      item?.custom_fields?.photoId,
      item?.custom_fields?.photo_id,
    ];
    const fieldList = Array.isArray(item?.customFields) ? item.customFields : [];
    for (const field of fieldList) {
      if (String(field?.name || '').toLowerCase() === 'photoid') {
        candidates.push(field?.value);
      }
    }
    for (const candidate of candidates) {
      const num = Number(candidate);
      if (Number.isFinite(num) && num > 0 && !ids.includes(num)) ids.push(num);
    }
  }
  return ids;
}

function verifySnipcartSignature(rawBody, signature) {
  const secret = (process.env.SNIPCART_WEBHOOK_SECRET || '').trim();
  if (!secret || !signature) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const candidate = signature.replace(/^hmac_/, '').trim();
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
 * SECRET key (valid for one minute, usable once). There is NO per-webhook
 * HMAC secret in v3.
 */
async function verifySnipcartRequestToken(token) {
  const secret = (process.env.SNIPCART_SECRET_API_KEY || '').trim();
  if (!secret || !token) return false;
  try {
    const auth = Buffer.from(`${secret}:`).toString('base64');
    const response = await fetch(
      `https://app.snipcart.com/api/requestvalidation/${encodeURIComponent(String(token))}`,
      { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } }
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
 * ONE static webhook URL can serve every gallery without a per-slug
 * dashboard entry.
 */
function gallerySlugFromOrderItems(items) {
  for (const item of Array.isArray(items) ? items : []) {
    const url = String(item?.url || '');
    const match = url.match(/\/api\/gallery\/([^/?]+)\/(?:price-check|photo|preview)/);
    if (match) {
      try { return decodeURIComponent(match[1]); } catch { return match[1]; }
    }
  }
  return null;
}

async function handleWebhook(req, res) {
  try {
    const signature = req.headers['x-snipcart-signature'] || req.headers['X-Snipcart-Signature'];
    const requestToken = req.headers['x-snipcart-requesttoken'] || req.headers['X-Snipcart-RequestToken'];
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));

    // Official v3 verification: request token checked against Snipcart's API.
    // Optional legacy fallback: HMAC when SNIPCART_WEBHOOK_SECRET is set.
    const tokenValid = await verifySnipcartRequestToken(requestToken);
    const signatureValid = verifySnipcartSignature(rawBody, String(signature || ''));
    if (!tokenValid && !signatureValid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const eventName = payload?.eventName || payload?.event_name;
    if (eventName !== 'order.completed') {
      return res.status(200).json({ ok: true, ignored: true });
    }

    // Snipcart v3 puts the FULL Order object directly in `content` — there is
    // no `content.order` wrapper. Keep the v2 flat shapes as fallbacks so
    // nothing depends on the webhook version.
    const content = payload?.content || {};
    const order = content?.order
      || (content?.token ? content : null)
      || payload?.data?.order
      || payload?.order
      || {};
    const orderId = order?.token || order?.id || payload?.id;
    if (!orderId) {
      logger.warn(`Snipcart webhook ${eventName}: missing order id in payload`);
      return res.status(400).json({ error: 'Missing order id' });
    }

    const exists = await db('photo_purchase_orders').where({ order_id: String(orderId) }).first('id');
    if (exists) {
      return res.status(200).json({ ok: true, duplicate: true });
    }

    const buyerEmail = order?.email || order?.customer?.email || order?.billingAddress?.email || '';
    const gallerySlug = req.params?.slug || gallerySlugFromOrderItems(order?.items);
    if (!gallerySlug) {
      logger.warn(`Snipcart webhook ${eventName}: cannot determine gallery for order ${orderId}`);
      return res.status(400).json({ error: 'Cannot determine gallery from order' });
    }
    const gallery = await db('events')
      .where({ slug: gallerySlug })
      .first('id', 'event_name', 'photo_price', 'purchase_access_days', 'free_photo_count', 'is_priced', 'promo_code', 'snipcart_discount_id');
    if (!gallery || gallery.is_priced !== true && gallery.is_priced !== 1 && gallery.is_priced !== '1') {
      return res.status(404).json({ error: 'Gallery not found or not priced' });
    }

    const orderedIds = orderedPhotoIds(order?.items || []);
    if (!orderedIds.length) {
      logger.warn(`Snipcart webhook ${eventName}: order ${orderId} has no purchased photo ids`);
      return res.status(400).json({ error: 'No purchased photo ids supplied' });
    }

    // Only photos that actually belong to THIS gallery become purchase rows;
    // anything else in the payload is dropped rather than stored under a
    // mismatched gallery.
    const ownedRows = await livePhotos(db)
      .where({ event_id: gallery.id })
      .whereIn('id', orderedIds)
      .select('id', 'photo_price');
    const ownedById = new Map(ownedRows.map((row) => [Number(row.id), row]));
    const orderedOwned = orderedIds.filter((id) => ownedById.has(id));
    if (!orderedOwned.length) {
      logger.warn(`Snipcart webhook ${eventName}: order ${orderId} has no photos belonging to gallery ${gallerySlug}`);
      return res.status(400).json({ error: 'No purchased photos belong to this gallery' });
    }

    // Per-order gross recomputed from the database: every photo carries its
    // effective price (override or gallery default). The free quota is NOT
    // per-line — it is the one-time promo-code discount, verified below.
    const allocation = allocateFreeLines(
      { ...gallery, free_photo_count: 0 },
      orderedOwned.map((id) => ({ photoId: id, photo_price: ownedById.get(id)?.photo_price }))
    );
    const grossCents = allocation.reduce((sum, line) => sum + line.amountCents, 0);

    // One-time promo code: honoured exactly once per gallery — on the FIRST
    // order that actually applies it. The Snipcart discount is single-use
    // (maxNumberOfUsages=1), so a buyer who forgets the code on the first
    // order does not burn the quota for everyone else.
    const priorPromoUse = await db('photo_purchase_orders')
      .where({ gallery_id: gallery.id, promo_used: true })
      .first('id');
    const discountCodes = (Array.isArray(order?.discounts) ? order.discounts : [])
      .map((d) => String(d?.code || ''))
      .filter(Boolean);
    const codeApplied = !!(gallery.promo_code && discountCodes.includes(gallery.promo_code));
    const codeHonored = codeApplied && !priorPromoUse && !!gallery.snipcart_discount_id;
    const freeValueCents = codeHonored
      ? Math.round(Math.max(0, Number(gallery.free_photo_count || 0)) * Number(gallery.photo_price || 0) * 100)
      : 0;
    const expectedTotalCents = Math.max(0, grossCents - freeValueCents);

    // What Snipcart actually charged. Prefer the order total, fall back to
    // summing the line totals when the payload shape doesn't carry it.
    const orderTotal = Number(order?.total ?? order?.totals?.total ?? order?.summary?.total);
    const linesTotalCents = (Array.isArray(order?.items) ? order.items : []).reduce(
      (sum, item) => sum + Math.round(Number(item?.totalPrice ?? Number(item?.price ?? 0) * Number(item?.quantity ?? 1)) * 100),
      0
    );
    const chargedTotalCents = Number.isFinite(orderTotal) ? Math.round(orderTotal * 100) : linesTotalCents;

    // Audit: a cart that was re-priced outside the client-side allocation
    // (dev tools) pays the wrong amount. Refund it and deliver nothing.
    if (Math.abs(chargedTotalCents - expectedTotalCents) > 1) {
      logger.error(
        `Snipcart order ${orderId} amount mismatch: charged ${chargedTotalCents}c, expected ${expectedTotalCents}c (gallery ${gallery.id}). Refunding.`
      );
      await refundSnipcartOrder(orderId, chargedTotalCents / 100, 'Photo sales price mismatch — refunded automatically');
      return res.status(200).json({ ok: true, mismatch: true, refunded: true });
    }

    const purchasedAt = new Date().toISOString();
    const days = Number(gallery.purchase_access_days || 30);
    const expiresAt = new Date(Date.now() + (Number.isFinite(days) ? days : 30) * 24 * 60 * 60 * 1000).toISOString();
    const accessToken = createPurchaseAccessToken();

    await db.transaction(async (trx) => {
      await trx('photo_purchase_orders').insert({
        order_id: String(orderId),
        gallery_id: gallery.id,
        buyer_email: buyerEmail,
        total_cents: Math.max(0, chargedTotalCents || 0),
        currency: order?.currency || 'EUR',
        status: 'completed',
        purchased_at: purchasedAt,
        expires_at: expiresAt,
        access_token: accessToken,
        email_sent: false,
        promo_used: codeHonored,
      });

      // Per-order allocation: the first N lines record a 0 amount; the
      // lines beyond the free mark carry the gallery price.
      const rows = [];
      for (const line of allocation) {
        if (line.photoId === null) continue;
        rows.push({
          order_id: String(orderId),
          gallery_id: gallery.id,
          photo_id: Number(line.photoId),
          buyer_email: buyerEmail,
          purchased_at: purchasedAt,
          expires_at: expiresAt,
          access_token: accessToken,
          currency: order?.currency || 'EUR',
          amount_cents: line.amountCents,
        });
      }

      if (rows.length) await trx('photo_purchases').insert(rows);
    });

    const purchaseLink = buildPurchasedDownloadUrl({
      baseUrl: await getFrontendBaseUrl(),
      accessToken,
    });
    if (buyerEmail) {
      await queueEmail(null, buyerEmail, 'photo_purchase_access', {
        buyer_email: buyerEmail,
        gallery_name: gallery.event_name || gallerySlug,
        access_link: purchaseLink,
        purchased_at: purchasedAt,
        expires_at: expiresAt,
        download_count: orderedOwned.length,
        photo_count: orderedOwned.length,
      });
      await db('photo_purchase_orders').where({ order_id: String(orderId) }).update({ email_sent: true });
    }

    logger.info(`Snipcart order ${orderId} processed: gallery ${gallerySlug}, ${orderedOwned.length} photo(s), ${chargedTotalCents}c, email ${buyerEmail || 'n/a'}`);
    return res.status(200).json({ ok: true, order_id: String(orderId), access_token: accessToken });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to process Snipcart order');
  }
}

// Photo sales: ONE static dashboard entry serves every gallery —
// the slug-less route derives the gallery from the order's item URLs. The
// per-slug path stays for compatibility with already-configured URLs.
router.post('/snipcart-webhook', express.raw({ type: '*/*', limit: '2mb' }), handleWebhook);
router.post('/:slug/snipcart-webhook', express.raw({ type: '*/*', limit: '2mb' }), handleWebhook);

module.exports = router;
