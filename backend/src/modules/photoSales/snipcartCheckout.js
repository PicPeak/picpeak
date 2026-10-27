'use strict';

const { db } = require('../../database/db');
const { quoteOf, checkoutError, OPEN } = require('./checkoutReservation');
const { signPhotoSale, sellablePhotos, isGalleryOnSale } = require('./sellable');
const { purchaseExpiry, purchaseRows, sendPurchaseEmail } = require('./fulfilment');

function reservationToken(items) {
  const tokens = (Array.isArray(items) ? items : []).map((item) => {
    try { return new URL(item.url).searchParams.get('checkout'); } catch { return null; }
  });
  if (!tokens.some(Boolean)) return null; // A pre-upgrade Snipcart cart.
  if (!tokens.length || tokens.some((token) => !/^[0-9a-f]{48}$/.test(token || '') || token !== tokens[0])) return false;
  return tokens[0];
}
async function findProviderOrder(token, conn = db) {
  return conn('photo_purchase_orders').where({ payment_provider: 'snipcart' })
    .where((q) => q.where('provider_order_id', String(token)).orWhere('order_id', String(token))).first();
}
function handoff(order) {
  if (order.payment_provider !== 'snipcart' || !OPEN.includes(order.status)) throw checkoutError('This checkout has ended. Please start again.', 409, 'CHECKOUT_ENDED');
  const quote = quoteOf(order);
  if (Date.now() >= quote.sessionExpiresAt * 1000) throw checkoutError('This checkout has ended. Please start again.', 409, 'CHECKOUT_ENDED');
  return {
    checkout_token: order.checkout_token,
    promo_code: quote.promoCode,
    expires_at: new Date(quote.sessionExpiresAt * 1000).toISOString(),
    items: quote.lines.map((line) => ({
      id: `${quote.gallerySlug}-photo-${line.photoId}`,
      name: line.name, price: line.originalAmountCents / 100, quantity: 1, maxQuantity: 1, shippable: false,
      url: `${quote.apiBase.replace(/\/+$/, '')}/gallery/${encodeURIComponent(quote.gallerySlug)}/price-check?photoId=${line.photoId}&sig=${signPhotoSale(line.photoId)}&checkout=${order.checkout_token}`,
      customFields: [{ name: 'photoId', value: String(line.photoId), type: 'hidden' }],
    })),
  };
}

// The caller authenticates the provider event and checks signed, unique photo
// lines first. A reservation is an immutable quote, never a browser price.
async function grantReservation(local, remote, gallery, photoIds) {
  const quote = quoteOf(local);
  const expectedIds = quote.lines.map((line) => line.photoId).sort((a, b) => a - b);
  const suppliedIds = [...photoIds].sort((a, b) => a - b);
  const discounts = (Array.isArray(remote.discounts) ? remote.discounts : []).map((d) => String(d?.code || '')).filter(Boolean);
  const buyerEmail = remote.email || remote.user?.email || remote.billingAddress?.email || '';
  if ((local.provider_order_id && local.provider_order_id !== String(remote.token)) || !OPEN.includes(local.status) || Number(local.gallery_id) !== Number(gallery.id)
      || JSON.stringify(expectedIds) !== JSON.stringify(suppliedIds)
      || (quote.promoCode ? discounts.length !== 1 || discounts[0] !== quote.promoCode : discounts.length > 0)
      || !buyerEmail || String(remote.currency).toUpperCase() !== quote.currency
      || Math.round(Number(remote.total) * 100) !== quote.totalCents
      || Date.parse(quote.expiresAt) <= Date.now()) return false;
  const result = await db.transaction(async (trx) => {
    // Same event-first lock as gallery pause compensation (#2296).
    const eventQuery = trx('events').where({ id: gallery.id });
    if (trx.client.config.client === 'pg') eventQuery.forUpdate();
    const event = await eventQuery.first();
    const orderQuery = trx('photo_purchase_orders').where({ id: local.id });
    if (trx.client.config.client === 'pg') orderQuery.forUpdate();
    const currentOrder = await orderQuery.first();
    if (!currentOrder || !OPEN.includes(currentOrder.status)) return currentOrder?.status === 'completed' && currentOrder.provider_order_id === String(remote.token);
    if (!isGalleryOnSale(event, { allowTemporarilyDisabled: true })) return false;
    const photos = await sellablePhotos(trx, gallery.id).whereIn('photos.id', photoIds).select('photos.id');
    if (photos.length !== photoIds.length) return false;
    const now = Date.now();
    const expiresAt = new Date(Math.min(Date.parse(quote.expiresAt), Date.parse(purchaseExpiry(event, now)))).toISOString();
    const changed = await trx('photo_purchase_orders').where({ id: local.id }).whereIn('status', OPEN)
      .modify((q) => { if (quote.promoCode) q.where({ promo_gallery_id: gallery.id }); })
      .update({ provider_order_id: String(remote.token), status: 'completed', buyer_email: buyerEmail,
        purchased_at: new Date(now).toISOString(), expires_at: expiresAt, promo_used: !!quote.promoCode,
        recovery_error: null, recovery_needs_attention: false, updated_at: new Date(now).toISOString() });
    if (!changed) return false;
    await trx('photo_purchases').insert(purchaseRows({ orderId: local.order_id, galleryId: gallery.id, buyerEmail,
      purchasedAt: new Date(now).toISOString(), expiresAt, accessToken: local.access_token, currency: quote.currency, lines: quote.lines }));
    return true;
  });
  if (result) await sendPurchaseEmail(await db('photo_purchase_orders').where({ id: local.id }).first(), quote.galleryName, quote.lines.length);
  return result;
}
module.exports = { handoff, reservationToken, findProviderOrder, grantReservation };
