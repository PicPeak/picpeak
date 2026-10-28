'use strict';

const { db } = require('../../database/db');
const { queueEmail, getSupportEmail } = require('../../services/emailProcessor');
const { getFrontendBaseUrl } = require('../../utils/frontendUrl');
const { buildPurchasedDownloadUrl, pauseAdjustedExpiry } = require('./purchaseAccess');
const { lockGallery } = require('../../services/galleryPauseService');
const { isTrue } = require('../../utils/galleryLifecycle');

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
  // Read configuration before taking the SQLite connection / event lock.
  const baseUrl = await getFrontendBaseUrl();
  const supportEmail = await getSupportEmail();
  await db.transaction(async (trx) => {
    // Match grant and pause/resume ordering. The template and effective
    // deadline must describe one locked availability snapshot, not a stale
    // read made while another transaction resumes and compensates the order.
    const gallery = order.gallery_id ? await lockGallery(trx, order.gallery_id) : null;
    const query = trx('photo_purchase_orders').where({ id: order.id });
    if (trx.client.config.client === 'pg') query.forUpdate();
    const current = await query.first();
    if (!current || current.status !== 'completed' || current.email_sent || !current.buyer_email) return;
    const paused = isTrue(gallery?.temporarily_disabled);
    const variables = {
      buyer_email: current.buyer_email,
      gallery_name: gallery?.event_name || galleryName,
      access_link: buildPurchasedDownloadUrl({ baseUrl, accessToken: current.access_token }),
      purchased_at: current.purchased_at,
      expires_at: pauseAdjustedExpiry(current, gallery),
      download_count: photoCount,
      photo_count: photoCount,
      ...(paused && { support_email: supportEmail, expiry_date: gallery.expires_at }),
    };
    const claimed = await trx('photo_purchase_orders').where({ id: order.id, status: 'completed', email_sent: false })
      .update({ email_sent: true });
    if (!claimed) return;
    const queued = await queueEmail(null, current.buyer_email, paused ? 'photo_purchase_paused' : 'photo_purchase_access', variables, { trx });
    if (queued === false) throw new Error('Purchase email could not be queued');
  });
}

module.exports = { purchaseExpiry, purchaseRows, sendPurchaseEmail };
