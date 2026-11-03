'use strict';
const { parse } = require('./validation');
const { formatBoolean } = require('../../utils/dbCompat');
async function retain(tx, kind, id, lines) {
  const ids = new Set();
  for (const line of lines) {
    const snapshot =
      typeof line.configuration_snapshot === 'string'
        ? parse(line.configuration_snapshot)
        : line.configuration_snapshot;
    for (const a of snapshot?.attributes || [])
      for (const o of a.options) if (o.imageId) ids.add(o.imageId);
    for (const o of [snapshot?.model, snapshot?.colour])
      if (o?.imageId) ids.add(o.imageId);
  }
  for (const imageId of ids) {
    if (!(await tx('album_product_images').where({ id: imageId }).first()))
      throw new Error('A frozen product image is missing');
    await tx('product_configuration_image_references')
      .insert({ image_id: imageId, source_kind: kind, source_id: String(id) })
      .onConflict(['image_id', 'source_kind', 'source_id'])
      .ignore();
  }
}
/**
 * Customer erasure: drops the name and session digest from the client's history
 * entries and withdraws their offers. The selection stays: it holds no personal
 * data, and a locked one is the studio's order record.
 */
async function forgetCustomer(tx, customerId) {
  if (!(await tx.schema.hasColumn('album_product_choice_history', 'customer_account_id')))
    return;
  await tx('album_product_choice_history')
    .where('actor_type', 'client')
    .where((q) =>
      q.where({ customer_account_id: customerId }).orWhereIn(
        'offer_id',
        tx('event_album_products').where({ released_customer_id: customerId }).select('id'),
      ),
    )
    .update({ actor_id: null, actor_name: null, customer_account_id: null });
  await tx('event_album_products')
    .where({ released_customer_id: customerId })
    .update({ enabled: formatBoolean(false) });
}
module.exports = { retain, forgetCustomer };
