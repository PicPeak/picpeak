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

/** Preserve the quoted window plus pause credit, still capped by gallery expiry. */
function reservationExpiry(order, gallery, now = Date.now()) {
  const end = pauseAdjustedExpiry(order, gallery, now);
  return end ? new Date(Math.min(Date.parse(end), Date.parse(purchaseExpiry(gallery, now)))).toISOString() : null;
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

/**
 * Variables of the photo_purchase_access / photo_purchase_paused templates.
 * The names are template contracts. `paused` carries what the paused
 * template adds ({ supportEmail, expiryDate }), or is null.
 */
function purchaseEmailVariables({ order, galleryName, accessLink, expiresAt, photoCount, paused = null }) {
  return {
    buyer_email: order.buyer_email,
    gallery_name: galleryName,
    access_link: accessLink,
    purchased_at: order.purchased_at,
    expires_at: expiresAt,
    download_count: photoCount,
    photo_count: photoCount,
    ...(paused && { support_email: paused.supportEmail, expiry_date: paused.expiryDate }),
  };
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
    const variables = purchaseEmailVariables({
      order: current,
      galleryName: gallery?.event_name || galleryName,
      accessLink: buildPurchasedDownloadUrl({ baseUrl, accessToken: current.access_token }),
      expiresAt: pauseAdjustedExpiry(current, gallery),
      photoCount,
      paused: paused ? { supportEmail, expiryDate: gallery.expires_at } : null,
    });
    const claimed = await trx('photo_purchase_orders').where({ id: order.id, status: 'completed', email_sent: false })
      .update({ email_sent: true });
    if (!claimed) return;
    const queued = await queueEmail(null, current.buyer_email, paused ? 'photo_purchase_paused' : 'photo_purchase_access', variables, { trx });
    if (queued === false) throw new Error('Purchase email could not be queued');
  });
}

module.exports = { purchaseExpiry, reservationExpiry, purchaseRows, purchaseEmailVariables, sendPurchaseEmail };
