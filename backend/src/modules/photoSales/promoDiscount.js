'use strict';

/** Gallery promo codes. Redemption is reserved atomically on a PicPeak
 * pending order; no third-party coupons or background API sync are needed. */

const crypto = require('crypto');
const { db } = require('../../database/db');
const logger = require('../../utils/logger');

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
  // Conditional: two replicas healing the same gallery at startup must end
  // up with ONE code — the one the discount is then created for.
  await db('events').where({ id: eventRow.id }).whereNull('promo_code').update({ promo_code: generatePromoCode() });
  const row = await db('events').where({ id: eventRow.id }).first('promo_code');
  return row?.promo_code || null;
}

// Kept for historical Snipcart orders whose cart carries a discount id.
function isDiscountId(value) {
  return !!value && !String(value).startsWith('pending:');
}

async function ensurePromoForEvent(eventRow) {
  return { code: await ensurePromoCode(eventRow), sync: { skipped: true } };
}

async function startupSync() {
  try {
    const pending = await db('events').where({ is_priced: true }).whereNull('promo_code')
      .select('id', 'is_priced', 'promo_code');
    for (const event of pending) await ensurePromoCode(event);
  } catch (error) {
    logger.warn('Photo promo initialization failed', { type: error.name });
  }
}

module.exports = { isDiscountId, generatePromoCode, ensurePromoCode, ensurePromoForEvent, startupSync };
