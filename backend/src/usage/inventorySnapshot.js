'use strict';
const { MAX_INVENTORY_COUNT } = require('./schema.cjs');

// Two installation totals only. No entity rows, IDs, names, file metadata,
// groupings, logs, processing results or visitor actions reach this layer.
async function inventorySnapshot(db) {
  return db.transaction(async (tx) => {
    const [{ count: galleries }] = await tx('events').count('* as count');
    const photosQuery = tx('photos');
    if (await tx.schema.hasColumn('photos', 'media_type'))
      photosQuery.where((q) => q.whereNull('media_type').orWhereNot('media_type', 'video'));
    const [{ count: photos }] = await photosQuery.count('* as count');
    const inventory = { galleries: Number(galleries), photos: Number(photos) };
    for (const count of Object.values(inventory)) {
      if (!Number.isSafeInteger(count) || count < 0 || count > MAX_INVENTORY_COUNT)
        throw new Error('Usage inventory total is outside the supported range');
    }
    return inventory;
  }, db.client.config.client === 'pg' ? { isolationLevel: 'repeatable read', readOnly: true } : {});
}
module.exports = { inventorySnapshot };
