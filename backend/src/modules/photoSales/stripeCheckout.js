'use strict';
const { db } = require('../../database/db');
const { getFrontendBaseUrl } = require('../../utils/frontendUrl');
const { purchaseExpiry, purchaseRows, sendPurchaseEmail } = require('./fulfilment');
const { isGalleryOnSale, sellablePhotos } = require('./sellable');
const { stripeClient, stripeConfiguration } = require('./stripeClient');
const { reserveCheckout, quoteOf, verifyCheckoutBrowser, checkoutError, OPEN } = require('./checkoutReservation');
const REFUSING = ['refund_pending', 'refund_failed'];
function idOf(value) { return typeof value === 'string' ? value : value?.id; }

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
    const cutoff = (quote.sessionExpiresAt + 300) * 1000;
    const restart = Date.now() >= cutoff && !(Date.parse(order.checkout_scan_started_at || '') >= cutoff);
    let cursor = restart ? null : order.checkout_scan_cursor;
    if (!cursor) await db('photo_purchase_orders').where({ id: order.id }).update({ checkout_scan_cursor: null, checkout_scan_started_at: new Date().toISOString() });
    for (let page = 0; page < 10; page++) {
      const listed = await client.checkout.sessions.list({
        created: { gte: Math.floor(Date.parse(order.purchased_at) / 1000) - 5, lte: quote.sessionExpiresAt + 300 },
        limit: 100, ...(cursor ? { starting_after: cursor } : {}),
      });
      const found = listed.data.find((session) => session.metadata?.picpeak_order_id === order.order_id);
      if (found) {
        await db('photo_purchase_orders').where({ id: order.id }).update({ checkout_session_id: found.id, checkout_scan_cursor: null });
        return client.checkout.sessions.retrieve(found.id, { expand: ['payment_intent.latest_charge'] });
      }
      if (!listed.has_more) {
        // Only a complete scan after the full payment window plus grace
        // proves absence. Before then another creation may still be in flight.
        if (Date.now() >= (quote.sessionExpiresAt + 300) * 1000) {
          await db('photo_purchase_orders').where({ id: order.id }).whereNull('checkout_session_id').whereIn('status', OPEN)
            .update({ status: 'expired', promo_gallery_id: null, checkout_scan_cursor: null });
          throw checkoutError('This checkout has ended. Please start again.', 409, 'CHECKOUT_ENDED');
        }
        await db('photo_purchase_orders').where({ id: order.id }).update({ checkout_scan_cursor: null });
        throw Object.assign(checkoutError('Checkout creation is still being confirmed. Please try again.', 503, 'CHECKOUT_RETRY'), { retryAt: new Date(cutoff).toISOString() });
      }
      const next = listed.data.at(-1)?.id;
      if (!next || next === cursor) throw checkoutError('Provider recovery needs attention.', 503, 'CHECKOUT_RETRY');
      cursor = next;
      await db('photo_purchase_orders').where({ id: order.id }).update({ checkout_scan_cursor: cursor });
    }
    throw Object.assign(checkoutError('Checkout creation could not yet be confirmed.', 503, 'CHECKOUT_RETRY'), { retryAt: new Date(Date.now() + 60000).toISOString() });
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

async function revoke(order, status, { releasePromo = false, onlyStatuses = null } = {}) {
  const now = new Date().toISOString();
  return db.transaction(async (trx) => {
    const updated = await trx('photo_purchase_orders').where({ id: order.id })
      .whereNotIn('status', ['charged_back', 'refunded'])
      .modify((q) => { if (onlyStatuses) q.whereIn('status', onlyStatuses); })
      .update({ status, updated_at: now, ...(releasePromo ? { promo_gallery_id: null } : {}) });
    if (updated) await trx('photo_purchases').where({ order_id: order.order_id }).update({ expires_at: now, updated_at: now });
    return updated;
  });
}

async function refusePaidOrder(order, client) {
  // A stale rejection must never revoke a purchase another worker fulfilled.
  if (!(await revoke(order, 'refund_pending', { onlyStatuses: [...OPEN, ...REFUSING, 'expired', 'failed', 'cancelled'] }))) return;
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
  const buyerEmail = session.customer_details?.email || session.customer_email || '';
  if (!buyerEmail || session.currency?.toUpperCase() !== quote.currency || session.amount_total !== quote.totalCents
      || (payment && (payment.currency?.toUpperCase() !== quote.currency || payment.amount_received !== quote.totalCents))) {
    return refusePaidOrder({ ...order, buyer_email: buyerEmail }, client);
  }
  // Honor the immutable quote, with any newly shortened gallery expiry as
  // an additional cap. Price edits alone never invalidate a paid order.
  const granted = await db.transaction(async (trx) => {
    // Match #2296's event-first lock order. A purchase committed after a
    // resume starts after that pause, rather than missing its compensation.
    const eventQuery = trx('events').where({ id: order.gallery_id || -1 });
    if (trx.client.config.client === 'pg') eventQuery.forUpdate();
    const current = await eventQuery.first();
    const orderQuery = trx('photo_purchase_orders').where({ id: order.id });
    if (trx.client.config.client === 'pg') orderQuery.forUpdate();
    const currentOrder = await orderQuery.first();
    if (!currentOrder || !OPEN.includes(currentOrder.status)) return true;
    if (!isGalleryOnSale(current, { allowTemporarilyDisabled: true }) || Date.parse(quote.expiresAt) <= Date.now()) return false;
    const grantedAt = Date.now();
    const now = new Date(grantedAt).toISOString();
    const expiresAt = new Date(Math.min(Date.parse(quote.expiresAt), Date.parse(purchaseExpiry(current, grantedAt)))).toISOString();
    const currentPhotos = await sellablePhotos(trx, current.id).whereIn('photos.id', quote.lines.map((line) => line.photoId)).select('photos.id');
    if (currentPhotos.length !== quote.lines.length) return false;
    const changed = await trx('photo_purchase_orders').where({ id: order.id }).whereIn('status', OPEN)
      .modify((q) => { if (quote.promoCode) q.where({ promo_gallery_id: current.id }); }).update({
        status: 'completed', buyer_email: buyerEmail, purchased_at: now, expires_at: expiresAt,
        promo_used: !!quote.promoCode, updated_at: now,
      });
    if (!changed) return (await trx('photo_purchase_orders').where({ id: order.id }).first('status'))?.status === 'completed';
    await trx('photo_purchases').insert(purchaseRows({
      orderId: order.order_id, galleryId: current.id, buyerEmail, purchasedAt: now,
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
