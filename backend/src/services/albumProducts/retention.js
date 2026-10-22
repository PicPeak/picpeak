'use strict';
const { parse } = require('./validation');
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
module.exports = { retain };
