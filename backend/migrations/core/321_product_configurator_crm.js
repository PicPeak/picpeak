'use strict';
async function addColumn(db, table, column, build) {
  if (
    (await db.schema.hasTable(table)) &&
    !(await db.schema.hasColumn(table, column))
  )
    await db.schema.alterTable(table, build);
}
async function dropColumn(db, table, column) {
  if (
    (await db.schema.hasTable(table)) &&
    (await db.schema.hasColumn(table, column))
  )
    await db.schema.alterTable(table, (t) => t.dropColumn(column));
}
exports.up = async (db) => {
  await addColumn(db, 'album_product_catalogue', 'library', (t) =>
    t.text('library').notNullable().defaultTo('[]'),
  );
  await addColumn(db, 'album_product_catalogue', 'types', (t) =>
    t.text('types').notNullable().defaultTo('[]'),
  );
  await db('album_product_catalogue')
    .where({ id: 1, library: '[]' })
    .update({
      library: JSON.stringify(
        require('../../src/services/albumProducts/library').presets(),
      ),
    });
  await addColumn(db, 'quote_line_item_presets', 'product_id', (t) =>
    t.string('product_id', 36),
  );
  await addColumn(db, 'quote_line_item_presets', 'product_surcharges', (t) =>
    t.text('product_surcharges'),
  );
  for (const table of ['quote_line_items', 'invoice_line_items']) {
    await addColumn(db, table, 'catalogue_preset_id', (t) =>
      t.integer('catalogue_preset_id'),
    );
    await addColumn(db, table, 'configuration_definition', (t) =>
      t.text('configuration_definition'),
    );
    await addColumn(db, table, 'configuration_snapshot', (t) =>
      t.text('configuration_snapshot'),
    );
    await addColumn(db, table, 'configuration_base_details', (t) =>
      t.text('configuration_base_details'),
    );
  }
};
exports.down = async (db) => {
  await dropColumn(db, 'album_product_catalogue', 'types');
  await dropColumn(db, 'album_product_catalogue', 'library');
  for (const table of ['quote_line_items', 'invoice_line_items'])
    for (const column of [
      'catalogue_preset_id',
      'configuration_definition',
      'configuration_snapshot',
      'configuration_base_details',
    ])
      await dropColumn(db, table, column);
  await dropColumn(db, 'quote_line_item_presets', 'product_surcharges');
  await dropColumn(db, 'quote_line_item_presets', 'product_id');
};
