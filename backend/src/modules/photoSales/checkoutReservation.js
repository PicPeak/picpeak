'use strict';

const crypto = require('crypto');
const { db } = require('../../database/db');
const { getApiBaseUrl, getFrontendBaseUrl } = require('../../utils/frontendUrl');
const snipcartSettings = require('./snipcartSettings');
const { configuration: providerConfiguration } = require('./providers');
const { createPurchaseAccessToken } = require('./purchaseAccess');
const { purchaseExpiry } = require('./fulfilment');
const { SALES_CURRENCY, isGalleryOnSale, sellablePhotos } = require('./sellable');
const { effectivePhotoPrice } = require('./priceRules');
const { stripeConfiguration } = require('./stripeClient');
const { lock: lockPaymentSettings, credentials, configurationOf } = require('./paymentSettings');
const promoIdentity = require('./promoIdentity');
const { browserHash } = promoIdentity;

const OPEN = ['pending', 'creation_unknown', 'processing'];

function checkoutError(message, status = 400, code = 'CHECKOUT_INVALID') {
  return Object.assign(new Error(message), { statusCode: status, code });
}

function quoteOf(order) { return JSON.parse(order.checkout_quote); }

async function frontendOrigin() {
  // Never build payment redirects from the caller-controlled Host header.
  const base = await getFrontendBaseUrl();
  let url;
  try { url = new URL(base); } catch { /* reported below */ }
  if (!url || (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && url.protocol === 'http:'))
      || url.username || url.password || url.search || url.hash) {
    throw checkoutError('Configure the public Site URL before accepting payments.', 503, 'CHECKOUT_UNAVAILABLE');
  }
  return base.replace(/\/+$/, '');
}

function requestMatches(order, gallery, photoIds, promoCode, browserKey, provider, identityHash) {
  const quote = quoteOf(order);
  return order.payment_provider === provider && Number(order.gallery_id) === Number(gallery.id)
    && JSON.stringify(quote.lines.map((line) => line.photoId)) === JSON.stringify(photoIds)
    && quote.promoCode === promoCode && verifyCheckoutBrowser(order, browserKey)
    && (!promoCode || order.promo_identity_hash === identityHash);
}

function verifyCheckoutBrowser(order, key) {
  if (!order?.checkout_browser_hash || typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) return false;
  return crypto.timingSafeEqual(Buffer.from(order.checkout_browser_hash), Buffer.from(browserHash(key)));
}

async function reserveCheckout(gallery, body) {
  const available = await providerConfiguration();
  const provider = body?.provider || available.preferred || 'stripe';
  const configuration = provider === 'stripe' ? await stripeConfiguration() : snipcartSettings.configurationOf(await snipcartSettings.credentials());
  if (!available.available.includes(provider)) {
    throw checkoutError('Photo purchases are not configured on this server.', 503, 'CHECKOUT_UNAVAILABLE');
  }
  if (!isGalleryOnSale(gallery)) throw checkoutError('This gallery is not available for purchases.', 409);
  const { photoIds, checkoutKey, browserKey } = body || {};
  const promoCode = typeof body?.promoCode === 'string' ? body.promoCode.trim().toUpperCase() : '';
  if (!Array.isArray(photoIds) || !photoIds.length || photoIds.length > 100
      || photoIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
      || new Set(photoIds).size !== photoIds.length
      || typeof checkoutKey !== 'string' || !/^[0-9a-f-]{36}$/i.test(checkoutKey) || promoCode.length > 64
      || typeof browserKey !== 'string' || !/^[0-9a-f]{64}$/.test(browserKey)) {
    throw checkoutError('Choose between 1 and 100 different photos.');
  }
  const promoApplied = !!promoCode;
  if (promoApplied && (!gallery.promo_code || promoCode !== gallery.promo_code
      || Number(gallery.free_photo_count) <= 0)) {
    throw checkoutError('This promo code is not available.', 409, 'PROMO_UNAVAILABLE');
  }
  const identityHash = promoApplied ? promoIdentity.verifiedIdentity(body.promoGrant, gallery.id, browserKey) : null;
  if (promoApplied && !identityHash) {
    throw checkoutError('Verify your email before using the gallery promo.', 401, 'CHECKOUT_PROMO_IDENTITY_REQUIRED');
  }
  const existing = await db('photo_purchase_orders').where({ checkout_key: checkoutKey }).first();
  if (existing) {
    if (!requestMatches(existing, gallery, photoIds, promoCode, browserKey, provider, identityHash)) throw checkoutError('This checkout has changed. Please start again.', 409);
    return existing;
  }
  const rows = await sellablePhotos(db, gallery.id).whereIn('photos.id', photoIds)
    .select('photos.id', 'photos.photo_price', 'photos.filename', 'photos.original_filename');
  if (rows.length !== photoIds.length) throw checkoutError('Some selected photos are no longer available.', 409, 'PHOTOS_UNAVAILABLE');
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  const base = await frontendOrigin();
  // Stripe requires at least 30 minutes until Checkout expires. Refuse a
  // last-minute purchase instead of promising access past gallery closure.
  if (provider === 'stripe' && gallery.expires_at && new Date(gallery.expires_at).getTime() < Date.now() + 31 * 60e3) {
    throw checkoutError('This gallery closes too soon to start a checkout.', 409, 'GALLERY_CLOSING');
  }
  let discount = promoApplied
    ? Math.round(Math.max(0, Number(gallery.free_photo_count)) * Number(gallery.photo_price) * 100)
    : 0;
  const lines = photoIds.map((photoId) => {
    const photo = byId.get(photoId);
    const gross = Math.round(effectivePhotoPrice(gallery, photo) * 100);
    if (!Number.isSafeInteger(gross) || gross < 0) throw checkoutError('A photo price is invalid.', 409);
    const reduction = Math.min(discount, gross);
    discount -= reduction;
    return {
      photoId,
      name: String(photo.original_filename || photo.filename || `Photo ${photoId}`).slice(0, 120),
      originalAmountCents: gross,
      amountCents: gross - reduction,
    };
  });
  const totalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  // Reject before claiming the shared promo. Zero-total gifts remain valid.
  if (provider === 'stripe' && totalCents > 0 && totalCents < 50) {
    throw checkoutError('Stripe requires at least €0.50. Add another photo or choose another payment provider.', 400, 'CHECKOUT_MINIMUM');
  }
  if (provider === 'snipcart' && promoApplied) {
    const promos = require('./promoDiscount');
    if (!promos.isDiscountId(gallery.snipcart_discount_id)) {
      await promos.ensurePromoForEvent(gallery);
      const fresh = await db('events').where({ id: gallery.id }).first('snipcart_discount_id');
      if (!promos.isDiscountId(fresh?.snipcart_discount_id)) throw checkoutError('This promo code is not ready for Snipcart. Choose Stripe or try again later.', 409, 'PROMO_UNAVAILABLE');
    }
  }
  const expiresAt = purchaseExpiry(gallery);
  const quote = {
    lines, promoCode, galleryName: gallery.event_name || gallery.slug, gallerySlug: gallery.slug,
    totalCents, currency: SALES_CURRENCY,
    locale: typeof body.language === 'string' && body.language.startsWith('de') ? 'de' : 'en',
    expiresAt, base, apiBase: provider === 'snipcart' ? await getApiBaseUrl() : undefined, testMode: configuration.test_mode,
    sessionExpiresAt: Math.floor(Math.min(Date.now() + (promoApplied ? 31 : 60) * 60e3,
      gallery.expires_at ? Date.parse(gallery.expires_at) : Infinity) / 1000),
    integrationIdentifier: `picpeak_photo_checkout_${Array.from(crypto.randomBytes(8), (b) => String.fromCharCode(97 + b % 26)).join('')}`,
  };
  const order = {
    order_id: `${provider}:${crypto.randomUUID()}`, gallery_id: gallery.id,
    payment_provider: provider, checkout_key: checkoutKey,
    checkout_token: createPurchaseAccessToken(), checkout_quote: JSON.stringify(quote),
    checkout_browser_hash: browserHash(browserKey),
    buyer_email: '', total_cents: quote.totalCents,
    currency: SALES_CURRENCY, status: 'pending', purchased_at: new Date().toISOString(), expires_at: expiresAt,
    access_token: createPurchaseAccessToken(), email_sent: false, promo_used: false,
    promo_gallery_id: promoApplied ? gallery.id : null,
    promo_identity_hash: identityHash,
  };
  try {
    // The unique nullable promo_gallery_id is the cross-process claim. The
    // existing Snipcart redemption is backfilled by the checkout migration.
    const inserted = await db.transaction(async (trx) => {
      await lockPaymentSettings(trx);
      // A verified mailbox has one outstanding promo across galleries and
      // providers. A different browser/session proof cannot reset this cap.
      // Keep ambiguous/refunding holds while recovery resolves the payment;
      // fulfilled redemptions and confirmed terminal attempts free this cap.
      if (identityHash) {
        const held = await trx('photo_purchase_orders').where({ promo_identity_hash: identityHash, promo_used: false })
          .whereIn('status', [...OPEN, 'refund_pending', 'refund_failed']).whereNotNull('promo_gallery_id').first('gallery_id');
        if (held) {
          if (Number(held.gallery_id) === Number(gallery.id)) throw checkoutError('This promo code is already reserved by another checkout.', 409, 'PROMO_UNAVAILABLE');
          throw checkoutError('Finish your existing promo checkout or wait for it to end before starting another.', 409, 'CHECKOUT_PROMO_BUSY');
        }
      }
      if (!(await providerConfiguration(trx)).available.includes(provider)) throw checkoutError('This payment provider is no longer available.', 409);
      const current = provider === 'stripe' ? configurationOf(await credentials(trx)) : snipcartSettings.configurationOf(await snipcartSettings.credentials(trx));
      if (!current.checkout_configured || !current.webhook_configured || current.test_mode !== configuration.test_mode) {
        throw checkoutError('The payment configuration has changed. Please start again.', 409);
      }
      return trx('photo_purchase_orders').insert(order).returning('id');
    });
    return { ...order, id: inserted[0]?.id ?? inserted[0] };
  } catch (error) {
    const raced = await db('photo_purchase_orders').where({ checkout_key: checkoutKey }).first();
    if (raced && requestMatches(raced, gallery, photoIds, promoCode, browserKey, provider, identityHash)) return raced;
    if (error.code === 'CHECKOUT_PROMO_BUSY') throw error;
    if (promoApplied && await db('photo_purchase_orders').where({ promo_gallery_id: gallery.id }).first('id')) {
      throw checkoutError('This promo code is already used or reserved by another checkout.', 409, 'PROMO_UNAVAILABLE');
    }
    throw error;
  }
}

module.exports = { reserveCheckout, quoteOf, verifyCheckoutBrowser, checkoutError, OPEN };
