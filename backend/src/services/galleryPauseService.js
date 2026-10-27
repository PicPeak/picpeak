const { db } = require('../database/db');
const { isTrue } = require('../utils/galleryLifecycle');
const { pauseCompensatedExpiry } = require('../modules/photoSales/purchaseAccess');

async function lockGallery(trx, id) {
  const query = trx('events').where({ id });
  if (trx.client.config.client === 'pg') query.forUpdate();
  return query.first();
}

async function writeExpiries(trx, table, rows, gallery, now) {
  const changes = rows.map((row) => ({ id: row.id, expiry: pauseCompensatedExpiry(row, gallery, now) }))
    .filter((change, i) => change.expiry && change.expiry !== rows[i].expires_at);
  // CASE + ids takes three bindings per row, below SQLite's 999 limit.
  // Batch writes avoid one database round trip for every purchased photo.
  for (let i = 0; i < changes.length; i += 200) {
    const batch = changes.slice(i, i + 200);
    await trx(table).whereIn('id', batch.map((row) => row.id)).update({
      expires_at: trx.raw(`case id ${batch.map(() => 'when ? then ?').join(' ')} else expires_at end`,
        batch.flatMap((row) => [row.id, row.expiry])),
      updated_at: new Date(now).toISOString(),
    });
  }
}

async function compensatePurchases(trx, gallery, now) {
  const query = trx('photo_purchase_orders').where({ gallery_id: gallery.id, status: 'completed' });
  if (trx.client.config.client === 'pg') query.forUpdate();
  const orders = await query.select('id', 'expires_at', 'purchased_at');
  // The completed order is the revocation boundary for both payment providers.
  // Holding its lock also serializes refunds while the photo rows are updated.
  const photos = await trx('photo_purchases as p')
    .join('photo_purchase_orders as o', 'o.order_id', 'p.order_id')
    .where({ 'o.gallery_id': gallery.id, 'p.gallery_id': gallery.id, 'o.status': 'completed' })
    .select('p.id', 'p.expires_at', 'p.purchased_at');
  await writeExpiries(trx, 'photo_purchase_orders', orders, gallery, now);
  await writeExpiries(trx, 'photo_purchases', photos, gallery, now);
}

/** Save the pause transition and buyer compensation in the same transaction. */
async function updateGalleryAvailability(id, updates, write) {
  return db.transaction(async (trx) => {
    const current = await lockGallery(trx, id);
    if (!current) return 0;
    const now = Date.now();
    const wasPaused = isTrue(current.temporarily_disabled);
    const paused = isTrue(updates.temporarily_disabled);
    const patch = { ...updates, temporarily_disabled_at: paused
      ? (wasPaused && current.temporarily_disabled_at) || new Date(now).toISOString() : null };
    const updated = await write(trx, patch);
    if (updated && wasPaused && !paused) {
      // Persist earned time independently of the gallery's mutable cutoff;
      // authorization and display still cap it at the current gallery expiry.
      await compensatePurchases(trx, current, now);
    }
    return updated;
  });
}

module.exports = { lockGallery, updateGalleryAvailability };
