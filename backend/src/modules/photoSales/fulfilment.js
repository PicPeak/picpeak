'use strict';

const { db } = require('../../database/db');
const { queueEmail, getSupportEmail } = require('../../services/emailProcessor');
const { getFrontendBaseUrl } = require('../../utils/frontendUrl');
const { buildPurchasedDownloadUrl } = require('./purchaseAccess');

function purchaseExpiry(gallery, now = Date.now()) {
  const days = Number(gallery.purchase_access_days || 30);
  const end = now + (Number.isFinite(days) ? days : 30) * 864e5;
  const galleryEnd = gallery.expires_at ? new Date(gallery.expires_at).getTime() : NaN;
  return new Date(Number.isFinite(galleryEnd) ? Math.min(end, galleryEnd) : end).toISOString();
}

function purchaseRows({ orderId, galleryId, buyerEmail, purchasedAt, expiresAt, accessToken, currency, lines }) {
  return lines.map((line) => ({
    order_id: orderId,
    gallery_id: galleryId,
    photo_id: Number(line.photoId),
    buyer_email: buyerEmail,
    purchased_at: purchasedAt,
    expires_at: expiresAt,
    access_token: accessToken,
    currency,
    amount_cents: line.amountCents,
  }));
}

// A failed queue operation remains retryable: payment acknowledgement must
// not permanently lose the buyer's email after the purchase was committed.
async function sendPurchaseEmail(order, galleryName, photoCount) {
  if (!order.buyer_email || order.email_sent || order.status !== 'completed') return;
  // Describe the gallery's current availability in the confirmation email.
  const gallery = order.gallery_id ? await db('events').where({ id: order.gallery_id }).first() : null;
  const paused = gallery?.temporarily_disabled === true || gallery?.temporarily_disabled === 1
    || gallery?.temporarily_disabled === '1';
  const variables = {
    buyer_email: order.buyer_email,
    gallery_name: galleryName,
    access_link: buildPurchasedDownloadUrl({ baseUrl: await getFrontendBaseUrl(), accessToken: order.access_token }),
    purchased_at: order.purchased_at,
    expires_at: order.expires_at,
    download_count: photoCount,
    photo_count: photoCount,
    ...(paused && { support_email: await getSupportEmail() }),
  };
  await db.transaction(async (trx) => {
    const claimed = await trx('photo_purchase_orders').where({ id: order.id, status: 'completed', email_sent: false })
      .update({ email_sent: true });
    if (!claimed) return;
    const queued = await queueEmail(null, order.buyer_email, paused ? 'photo_purchase_paused' : 'photo_purchase_access', variables, { trx });
    if (queued === false) throw new Error('Purchase email could not be queued');
  });
}

module.exports = { purchaseExpiry, purchaseRows, sendPurchaseEmail };
