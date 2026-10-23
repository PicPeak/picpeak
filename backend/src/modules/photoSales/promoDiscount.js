'use strict';

/**
 * Photo sales — one-time promo code per priced gallery.
 *
 * The free quota is realised as a Snipcart discount (official checkout
 * path, no client-side cart re-pricing):
 *
 *   trigger: Code      — the buyer enters the code in the checkout
 *   type: FixedAmount  — deducts free_photo_count × photo_price
 *   maxNumberOfUsages: 1
 *
 * The code is generated when a gallery is created/edited as priced; the
 * discount is created/updated through the Snipcart REST API using the
 * SECRET key. Without a secret key the sync is skipped (the UI then hides
 * the code) — pricing still works, just without the free quota.
 */

const crypto = require('crypto');
const { db } = require('../../database/db');
const logger = require('../../utils/logger');

const SNIPCART_API = 'https://app.snipcart.com/api';

/** Random code: unambiguous alphabet, grouped for easy typing. */
function generatePromoCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const pick = (n) => Array.from(crypto.randomBytes(n))
    .map((byte) => alphabet[byte % alphabet.length])
    .join('');
  return `FOTO-${pick(4)}-${pick(4)}`;
}

/** Make sure a priced gallery has a promo code; returns the code (or null). */
async function ensurePromoCode(eventRow) {
  if (!eventRow || !eventRow.id) return null;
  const priced = eventRow.is_priced === true || eventRow.is_priced === 1 || eventRow.is_priced === '1';
  if (!priced) return null;
  if (eventRow.promo_code) return eventRow.promo_code;
  const code = generatePromoCode();
  await db('events').where({ id: eventRow.id }).update({ promo_code: code });
  return code;
}

function snipcartAuth() {
  const secret = (process.env.SNIPCART_SECRET_API_KEY || '').trim();
  if (!secret) return null;
  return Buffer.from(`${secret}:`).toString('base64');
}

/**
 * Create or update the Snipcart discount backing the gallery's promo code.
 * Returns { ok, skipped, error }.
 */
async function syncPromoDiscount(eventRow) {
  try {
    const auth = snipcartAuth();
    if (!auth) return { ok: false, skipped: true, error: 'SNIPCART_SECRET_API_KEY is not set' };

    const freeCount = Math.max(0, Math.floor(Number(eventRow.free_photo_count || 0)));
    const price = Number(eventRow.photo_price || 0);
    const amount = freeCount > 0 && Number.isFinite(price) ? freeCount * price : 0;
    const code = eventRow.promo_code;
    if (!code || amount <= 0) return { ok: false, skipped: true, error: 'No promo code or free quota value' };

    const body = {
      name: `Free photos: ${eventRow.event_name || `Gallery ${eventRow.id}`}`,
      trigger: 'Code',
      code,
      type: 'FixedAmount',
      amount,
      maxNumberOfUsages: 1,
    };

    const existingId = eventRow.snipcart_discount_id;
    const url = existingId ? `${SNIPCART_API}/discounts/${encodeURIComponent(existingId)}` : `${SNIPCART_API}/discounts`;
    const method = existingId ? 'PUT' : 'POST';
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok && response.status !== 404) {
      const text = await response.text().catch(() => '');
      return { ok: false, error: `Snipcart discount API HTTP ${response.status}: ${text.slice(0, 200)}` };
    }
    // 404 on PUT: the stored id is gone — create a fresh discount.
    if (response.status === 404) {
      const created = await fetch(`${SNIPCART_API}/discounts`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!created.ok) return { ok: false, error: `Snipcart discount create HTTP ${created.status}` };
      const createdBody = await created.json().catch(() => ({}));
      await db('events').where({ id: eventRow.id }).update({ snipcart_discount_id: createdBody.id || null });
      return { ok: true };
    }
    const data = await response.json().catch(() => ({}));
    if (data && data.id) {
      await db('events').where({ id: eventRow.id }).update({ snipcart_discount_id: data.id });
    }
    return { ok: true };
  } catch (error) {
    logger.warn(`Promo discount sync failed for event ${eventRow?.id}: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

/**
 * Ensure code + discount for a priced gallery (called on create/edit).
 * Graceful: pricing and watermarking never depend on Snipcart being up.
 */
async function ensurePromoForEvent(eventRow) {
  const code = await ensurePromoCode(eventRow);
  if (!code) return { code: null, sync: { skipped: true } };
  const fresh = await db('events').where({ id: eventRow.id }).first(
    'id', 'event_name', 'is_priced', 'free_photo_count', 'photo_price', 'promo_code', 'snipcart_discount_id'
  );
  const sync = await syncPromoDiscount(fresh);
  return { code: fresh.promo_code, sync };
}

/**
 * Startup sweep: heal priced galleries with a missing promo code or a
 * missing Snipcart discount (e.g. the secret key was added after the
 * gallery was saved, or the gallery was created before this feature
 * shipped). Generates the one-time promo and re-syncs the discount.
 */
async function startupSync() {
  try {
    const pending = await db('events')
      .where(function () {
        this.where('is_priced', true).orWhere('is_priced', 1).orWhere('is_priced', '1');
      })
      .where(function () {
        this.whereNull('promo_code').orWhereNull('snipcart_discount_id');
      })
      .select('id', 'event_name', 'is_priced', 'free_photo_count', 'photo_price', 'promo_code', 'snipcart_discount_id');
    for (const event of pending) {
      await ensurePromoForEvent(event);
    }
  } catch (error) {
    logger.warn(`Promo discount startup sync failed: ${error.message}`);
  }
}

module.exports = {
  generatePromoCode,
  ensurePromoCode,
  syncPromoDiscount,
  ensurePromoForEvent,
  startupSync,
};
