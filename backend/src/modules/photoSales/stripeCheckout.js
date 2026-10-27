'use strict';

const crypto = require('crypto');
const { db } = require('../../database/db');
const { getFrontendBaseUrl } = require('../../utils/frontendUrl');
const { createPurchaseAccessToken } = require('./purchaseAccess');
const { purchaseExpiry, purchaseRows, sendPurchaseEmail } = require('./fulfilment');
const { SALES_CURRENCY, isGalleryOnSale, sellablePhotos } = require('./sellable');
const { effectivePhotoPrice } = require('./priceRules');
const { stripeClient, stripeConfiguration } = require('./stripeClient');
const { lock: lockPaymentSettings, credentials, configurationOf } = require('./paymentSettings');

const OPEN = ['pending', 'creation_unknown', 'processing'];
const REFUSING = ['refund_pending', 'refund_failed'];

function checkoutError(message, status = 400, code = 'CHECKOUT_INVALID') {
  return Object.assign(new Error(message), { statusCode: status, code });
}

function quoteOf(order) { return JSON.parse(order.checkout_quote); }
function idOf(value) { return typeof value === 'string' ? value : value?.id; }

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

function requestMatches(order, gallery, photoIds, promoCode, browserKey) {
  const quote = quoteOf(order);
  return Number(order.gallery_id) === Number(gallery.id)
    && JSON.stringify(quote.lines.map((line) => line.photoId)) === JSON.stringify(photoIds)
    && quote.promoCode === promoCode && verifyCheckoutBrowser(order, browserKey);
}

function browserHash(key) { return crypto.createHash('sha256').update(key).digest('hex'); }
function verifyCheckoutBrowser(order, key) {
  if (!order?.checkout_browser_hash || typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) return false;
  return crypto.timingSafeEqual(Buffer.from(order.checkout_browser_hash), Buffer.from(browserHash(key)));
}

async function reserveCheckout(gallery, body) {
  const configuration = await stripeConfiguration();
  if (!configuration.checkout_configured || !configuration.webhook_configured) {
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
  const existing = await db('photo_purchase_orders').where({ checkout_key: checkoutKey }).first();
  if (existing) {
    if (!requestMatches(existing, gallery, photoIds, promoCode, browserKey)) throw checkoutError('This checkout has changed. Please start again.', 409);
    return existing;
  }
  const rows = await sellablePhotos(db, gallery.id).whereIn('photos.id', photoIds)
    .select('photos.id', 'photos.photo_price', 'photos.filename', 'photos.original_filename');
  if (rows.length !== photoIds.length) throw checkoutError('Some selected photos are no longer available.', 409, 'PHOTOS_UNAVAILABLE');
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  const base = await frontendOrigin();
  // Stripe requires at least 30 minutes until Checkout expires. Refuse a
  // last-minute purchase instead of promising access past gallery closure.
  if (gallery.expires_at && new Date(gallery.expires_at).getTime() < Date.now() + 31 * 60e3) {
    throw checkoutError('This gallery closes too soon to start a checkout.', 409, 'GALLERY_CLOSING');
  }
  const promoApplied = !!promoCode;
  if (promoApplied && (!gallery.promo_code || promoCode !== gallery.promo_code
      || Number(gallery.free_photo_count) <= 0)) {
    throw checkoutError('This promo code is not available.', 409, 'PROMO_UNAVAILABLE');
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
  const expiresAt = purchaseExpiry(gallery);
  const quote = {
    lines, promoCode, galleryName: gallery.event_name || gallery.slug, gallerySlug: gallery.slug,
    totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0), currency: SALES_CURRENCY,
    locale: typeof body.language === 'string' && body.language.startsWith('de') ? 'de' : 'en',
    expiresAt, base, testMode: configuration.test_mode,
    sessionExpiresAt: Math.floor(Math.min(Date.now() + 60 * 60e3,
      gallery.expires_at ? Date.parse(gallery.expires_at) : Infinity) / 1000),
    integrationIdentifier: `picpeak_photo_checkout_${Array.from(crypto.randomBytes(8), (b) => String.fromCharCode(97 + b % 26)).join('')}`,
  };
  const order = {
    order_id: `stripe:${crypto.randomUUID()}`, gallery_id: gallery.id,
    payment_provider: 'stripe', checkout_key: checkoutKey,
    checkout_token: createPurchaseAccessToken(), checkout_quote: JSON.stringify(quote),
    checkout_browser_hash: browserHash(browserKey),
    buyer_email: '', total_cents: quote.totalCents,
    currency: SALES_CURRENCY, status: 'pending', purchased_at: new Date().toISOString(), expires_at: expiresAt,
    access_token: createPurchaseAccessToken(), email_sent: false, promo_used: false,
    promo_gallery_id: promoApplied ? gallery.id : null,
  };
  try {
    // The unique nullable promo_gallery_id is the cross-process claim. The
    // existing Snipcart redemption is backfilled by migration 327.
    const inserted = await db.transaction(async (trx) => {
      await lockPaymentSettings(trx);
      const current = configurationOf(await credentials(trx));
      if (!current.checkout_configured || !current.webhook_configured || current.test_mode !== configuration.test_mode) {
        throw checkoutError('The payment configuration has changed. Please start again.', 409);
      }
      return trx('photo_purchase_orders').insert(order).returning('id');
    });
    return { ...order, id: inserted[0]?.id ?? inserted[0] };
  } catch (error) {
    const raced = await db('photo_purchase_orders').where({ checkout_key: checkoutKey }).first();
    if (raced && requestMatches(raced, gallery, photoIds, promoCode, browserKey)) return raced;
    if (promoApplied && await db('photo_purchase_orders').where({ promo_gallery_id: gallery.id }).first('id')) {
      throw checkoutError('This promo code is already used or reserved by another checkout.', 409, 'PROMO_UNAVAILABLE');
    }
    throw error;
  }
}

async function checkoutSession(order, client = stripeClient()) {
  client = await client;
  if (!OPEN.includes(order.status)) throw checkoutError('This checkout has ended. Please start again.', 409, 'CHECKOUT_ENDED');
  if (order.checkout_session_id) return client.checkout.sessions.retrieve(order.checkout_session_id);
  const quote = quoteOf(order);
  if ((await stripeConfiguration()).test_mode !== quote.testMode) throw checkoutError('The payment configuration has changed.', 409);
  if (Date.now() >= (quote.sessionExpiresAt - 30 * 60) * 1000) {
    // Resolve an ambiguous creation before releasing anything. Stripe's
    // idempotency cache has a retention limit, so do not recreate an old
    // checkout with the same key after a long server outage.
    let cursor;
    for (let page = 0; page < 10; page++) {
      const listed = await client.checkout.sessions.list({
        created: { gte: Math.floor(Date.parse(order.purchased_at) / 1000) - 5, lte: quote.sessionExpiresAt + 300 },
        limit: 100, ...(cursor ? { starting_after: cursor } : {}),
      });
      const found = listed.data.find((session) => session.metadata?.picpeak_order_id === order.order_id);
      if (found) {
        await db('photo_purchase_orders').where({ id: order.id }).update({ checkout_session_id: found.id });
        return client.checkout.sessions.retrieve(found.id, { expand: ['payment_intent.latest_charge'] });
      }
      if (!listed.has_more) {
        // No new session can be created with fewer than 30 minutes left.
        // Allow another five minutes for an in-flight creation to settle.
        if (Date.now() >= (quote.sessionExpiresAt - 25 * 60) * 1000) {
          await db('photo_purchase_orders').where({ id: order.id }).whereNull('checkout_session_id').whereIn('status', OPEN)
            .update({ status: 'expired', promo_gallery_id: null });
          throw checkoutError('This checkout has ended. Please start again.', 409, 'CHECKOUT_ENDED');
        }
        throw checkoutError('Checkout creation is still being confirmed. Please try again.', 503, 'CHECKOUT_RETRY');
      }
      cursor = listed.data.at(-1)?.id;
    }
    throw checkoutError('Checkout creation could not yet be confirmed.', 503, 'CHECKOUT_RETRY');
  }
  try {
    const deadline = new Intl.DateTimeFormat(quote.locale === 'de' ? 'de-DE' : 'en-GB', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
    }).format(new Date(quote.expiresAt));
    const description = quote.locale === 'de'
      ? `Volle Qualität, ohne Wasserzeichen. Download bis ${deadline} UTC.${quote.promoCode ? ' Galerie-Rabatt angewendet.' : ''}`
      : `Full quality, without watermark. Download until ${deadline} UTC.${quote.promoCode ? ' Gallery promo applied.' : ''}`;
    const session = await client.checkout.sessions.create({
      mode: 'payment',
      locale: quote.locale,
      integration_identifier: quote.integrationIdentifier,
      client_reference_id: order.order_id,
      metadata: { picpeak_order_id: order.order_id, picpeak_origin: quote.base },
      payment_intent_data: { metadata: { picpeak_order_id: order.order_id, picpeak_origin: quote.base } },
      adaptive_pricing: { enabled: false },
      line_items: quote.lines.map((line) => ({
        quantity: 1,
        price_data: {
          currency: quote.currency.toLowerCase(), unit_amount: line.amountCents, tax_behavior: 'inclusive',
          product_data: { name: line.name, description },
        },
      })),
      expires_at: quote.sessionExpiresAt,
      success_url: `${quote.base}/photo-checkout/${order.checkout_token}`,
      cancel_url: `${quote.base}/photo-checkout/${order.checkout_token}?cancelled=1`,
    }, { idempotencyKey: `picpeak-checkout:${order.order_id}` });
    await db('photo_purchase_orders').where({ id: order.id }).update({
      checkout_session_id: session.id, payment_intent_id: idOf(session.payment_intent) || null,
    });
    return session;
  } catch (error) {
    // A timeout can follow a successful creation. Keep the quote and promo
    // claim; retrying uses exactly the same Stripe idempotency key and body.
    await db('photo_purchase_orders').where({ id: order.id }).whereIn('status', ['pending', 'creation_unknown'])
      .update({ status: 'creation_unknown' });
    throw error;
  }
}

async function revoke(order, status, { releasePromo = false } = {}) {
  const now = new Date().toISOString();
  await db.transaction(async (trx) => {
    const updated = await trx('photo_purchase_orders').where({ id: order.id })
      .whereNotIn('status', ['charged_back', 'refunded'])
      .update({ status, updated_at: now, ...(releasePromo ? { promo_gallery_id: null } : {}) });
    if (updated) await trx('photo_purchases').where({ order_id: order.order_id }).update({ expires_at: now, updated_at: now });
  });
}

async function refusePaidOrder(order, client) {
  await revoke(order, 'refund_pending');
  if (!order.payment_intent_id) {
    await revoke(order, 'cancelled', { releasePromo: !order.promo_used });
    return;
  }
  let status = 'refund_failed';
  try {
    const refund = order.payment_refund_id ? await client.refunds.retrieve(order.payment_refund_id)
      : await client.refunds.create({ payment_intent: order.payment_intent_id }, {
        idempotencyKey: `picpeak-refund:${order.order_id}`,
      });
    await db('photo_purchase_orders').where({ id: order.id }).update({ payment_refund_id: refund.id });
    status = refund.status === 'succeeded' ? 'refunded'
      : ['pending', 'requires_action'].includes(refund.status) ? 'refund_pending' : 'refund_failed';
  } finally {
    await revoke(order, status);
  }
}

async function reconcileSession(order, session, { failed = false, client = stripeClient() } = {}) {
  client = await client;
  const quote = quoteOf(order);
  if (session.metadata?.picpeak_order_id !== order.order_id || session.mode !== 'payment'
      || session.livemode !== !quote.testMode
      || (order.checkout_session_id && order.checkout_session_id !== session.id)) {
    throw checkoutError('Checkout does not match the order.', 400);
  }
  const payment = session.payment_intent && typeof session.payment_intent === 'object'
    ? session.payment_intent : session.payment_intent ? await client.paymentIntents.retrieve(session.payment_intent, { expand: ['latest_charge'] }) : null;
  const charge = payment?.latest_charge && typeof payment.latest_charge === 'object'
    ? payment.latest_charge : payment?.latest_charge ? await client.charges.retrieve(payment.latest_charge) : null;
  if (payment && payment.metadata?.picpeak_order_id !== order.order_id) throw checkoutError('Payment does not match the order.');
  await db('photo_purchase_orders').where({ id: order.id }).update({
    checkout_session_id: session.id, payment_intent_id: idOf(payment) || null,
    buyer_email: session.customer_details?.email || session.customer_email || '',
    // Keep the actual charge in the financial record, including a refused
    // payment. The agreed amount remains immutable in checkout_quote.
    ...(payment?.status === 'succeeded' && Number.isSafeInteger(payment.amount_received) ? {
      total_cents: payment.amount_received, currency: String(payment.currency).toUpperCase().slice(0, 8),
    } : {}),
  });
  order = await db('photo_purchase_orders').where({ id: order.id }).first();
  if (charge?.disputed) return revoke(order, 'charged_back');
  if (Number(charge?.amount_refunded) > 0) return revoke(order, 'refunded');
  if (REFUSING.includes(order.status)) return refusePaidOrder(order, client);
  // Stripe can mark a zero-total Checkout paid without creating a
  // PaymentIntent. Only a matching zero-total quote permits that path.
  const zeroTotal = quote.totalCents === 0 && session.amount_total === 0 && !session.payment_intent;
  const paid = session.status === 'complete' && (
    (session.payment_status === 'paid' && payment?.status === 'succeeded')
    || (['paid', 'no_payment_required'].includes(session.payment_status) && zeroTotal)
  );
  if (paid && ['expired', 'failed', 'cancelled'].includes(order.status)) return refusePaidOrder(order, client);
  if (!OPEN.includes(order.status) && order.status !== 'completed') return;
  if (!paid) {
    if (session.status === 'complete' && (session.payment_status === 'no_payment_required'
        || (session.payment_status === 'paid' && !payment))) return refusePaidOrder(order, client);
    if (session.status === 'expired' || (failed && session.status === 'complete' && payment?.status !== 'processing')) {
      return revoke(order, session.status === 'expired' ? 'expired' : 'failed', { releasePromo: !order.promo_used });
    }
    await db('photo_purchase_orders').where({ id: order.id }).whereIn('status', OPEN).update({ status: 'processing' });
    return;
  }
  if (order.status === 'completed') return sendPurchaseEmail(order, quote.galleryName, quote.lines.length);
  const gallery = order.gallery_id ? await db('events').where({ id: order.gallery_id }).first() : null;
  const photos = gallery ? await sellablePhotos(db, gallery.id)
    .whereIn('photos.id', quote.lines.map((line) => line.photoId)).select('photos.id') : [];
  const buyerEmail = session.customer_details?.email || session.customer_email || '';
  // A temporary pause stops new checkouts and downloads, but does not
  // invalidate an otherwise valid payment already in flight.
  if (!isGalleryOnSale(gallery, { allowTemporarilyDisabled: true }) || photos.length !== quote.lines.length
      || !buyerEmail || Date.parse(quote.expiresAt) <= Date.now()
      || session.currency?.toUpperCase() !== quote.currency || session.amount_total !== quote.totalCents
      || (payment && (payment.currency?.toUpperCase() !== quote.currency || payment.amount_received !== quote.totalCents))) {
    return refusePaidOrder({ ...order, buyer_email: buyerEmail }, client);
  }
  // Honor the immutable quote, with any newly shortened gallery expiry as
  // an additional cap. Price edits alone never invalidate a paid order.
  const granted = await db.transaction(async (trx) => {
    // Match #2296's event-first lock order. A purchase committed after a
    // resume starts after that pause, rather than missing its compensation.
    const eventQuery = trx('events').where({ id: gallery.id });
    if (trx.client.config.client === 'pg') eventQuery.forUpdate();
    const current = await eventQuery.first();
    if (!isGalleryOnSale(current, { allowTemporarilyDisabled: true }) || Date.parse(quote.expiresAt) <= Date.now()) return false;
    const grantedAt = Date.now();
    const now = new Date(grantedAt).toISOString();
    const expiresAt = new Date(Math.min(Date.parse(quote.expiresAt), Date.parse(purchaseExpiry(current, grantedAt)))).toISOString();
    const changed = await trx('photo_purchase_orders').where({ id: order.id }).whereIn('status', OPEN).update({
      status: 'completed', buyer_email: buyerEmail, purchased_at: now, expires_at: expiresAt,
      promo_used: !!quote.promoCode, updated_at: now,
    });
    if (!changed) return true;
    await trx('photo_purchases').insert(purchaseRows({
      orderId: order.order_id, galleryId: gallery.id, buyerEmail, purchasedAt: now,
      expiresAt, accessToken: order.access_token, currency: order.currency, lines: quote.lines,
    }));
    return true;
  });
  if (!granted) return refusePaidOrder({ ...order, buyer_email: buyerEmail }, client);
  order = await db('photo_purchase_orders').where({ id: order.id }).first();
  await sendPurchaseEmail(order, quote.galleryName, quote.lines.length);
}

async function reconcileWebhook(event, client = stripeClient()) {
  client = await client;
  const object = event.data?.object;
  let order;
  let session;
  if (event.type.startsWith('checkout.session.')) {
    order = await db('photo_purchase_orders').where({ payment_provider: 'stripe' })
      .where((q) => q.where('checkout_session_id', object.id).orWhere('order_id', object.metadata?.picpeak_order_id || '')).first();
    if (!order) {
      if (object.metadata?.picpeak_origin === await getFrontendBaseUrl()) throw new Error('PicPeak checkout order is unavailable');
      return;
    }
    session = await client.checkout.sessions.retrieve(object.id, { expand: ['payment_intent.latest_charge'] });
  } else {
    let paymentId = idOf(object.payment_intent);
    if (!paymentId && object.charge) paymentId = idOf((await client.charges.retrieve(idOf(object.charge))).payment_intent);
    if (!paymentId) return;
    const payment = await client.paymentIntents.retrieve(paymentId);
    order = await db('photo_purchase_orders').where({ payment_provider: 'stripe' })
      .where((q) => q.where('payment_intent_id', paymentId).orWhere('order_id', payment.metadata?.picpeak_order_id || '')).first();
    if (!order) {
      if (payment.metadata?.picpeak_origin === await getFrontendBaseUrl()) throw new Error('PicPeak payment order is unavailable');
      return;
    }
    if (!order.checkout_session_id) {
      const sessions = await client.checkout.sessions.list({ payment_intent: paymentId, limit: 1 });
      if (!sessions.data.length) throw new Error('Checkout for payment is not available yet');
      session = sessions.data[0];
    } else session = await client.checkout.sessions.retrieve(order.checkout_session_id, { expand: ['payment_intent.latest_charge'] });
  }
  await reconcileSession(order, session, { failed: event.type === 'checkout.session.async_payment_failed', client });
}

module.exports = { reserveCheckout, checkoutSession, reconcileSession, reconcileWebhook, quoteOf, verifyCheckoutBrowser, checkoutError, OPEN };
