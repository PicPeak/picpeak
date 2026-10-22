'use strict';
exports.up = async (db) => {
  await db.schema.alterTable('invoices', (t) =>
    t.integer('product_items_revision').notNullable().defaultTo(0),
  );
  for (const table of ['quote_line_items', 'invoice_line_items']) {
    await db.schema.alterTable(table, (t) => {
      t.boolean('configuration_locked').notNullable().defaultTo(false);
    });
  }
  await db.schema.alterTable('event_album_products', (t) => {
    t.integer('catalogue_preset_id');
    t.integer('billing_customer_id');
    t.boolean('show_prices').notNullable().defaultTo(false);
  });
  // Financial snapshots deliberately outlive gallery deletion. The source UUID
  // is not an FK to a gallery offer, which is erased with its client history.
  await db.schema.createTable('product_billable_items', (t) => {
    t.increments('id').primary();
    t.string('offer_id', 36).notNullable();
    t.integer('offer_revision').notNullable();
    t.integer('customer_account_id')
      .notNullable()
      .references('id')
      .inTable('customer_accounts')
      .onDelete('RESTRICT');
    t.integer('project_id')
      .references('id')
      .inTable('projects')
      .onDelete('SET NULL');
    t.integer('event_id')
      .references('id')
      .inTable('events')
      .onDelete('SET NULL');
    t.string('currency', 3).notNullable();
    t.string('vat_code', 16);
    t.decimal('vat_rate', 5, 2).notNullable();
    t.text('line_item').notNullable();
    t.integer('invoice_id')
      .references('id')
      .inTable('invoices')
      .onDelete('RESTRICT');
    t.integer('invoice_line_item_id')
      .references('id')
      .inTable('invoice_line_items')
      .onDelete('RESTRICT');
    t.integer('created_by_admin_id');
    t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
    t.unique(['offer_id', 'offer_revision']);
    t.index(['customer_account_id', 'invoice_id']);
    t.index(['event_id']);
  });
  await db.schema.createTable('product_configuration_image_references', (t) => {
    t.string('image_id', 36)
      .notNullable()
      .references('id')
      .inTable('album_product_images')
      .onDelete('RESTRICT');
    t.string('source_kind', 32).notNullable();
    t.string('source_id', 64).notNullable();
    t.primary(['image_id', 'source_kind', 'source_id']);
  });
  // SQLite FK cascades may be disabled. Enforce retention independently, so a
  // later unused-image cleanup cannot accidentally erase financial evidence.
  if (db.client.config.client === 'pg') {
    await db.raw(`CREATE FUNCTION protect_product_configuration_image() RETURNS trigger AS $$ BEGIN
      IF EXISTS (SELECT 1 FROM product_configuration_image_references WHERE image_id = OLD.id) THEN
        RAISE EXCEPTION 'Image belongs to a frozen product specification';
      END IF; RETURN OLD; END; $$ LANGUAGE plpgsql`);
    await db.raw(
      'CREATE TRIGGER protect_product_configuration_image BEFORE DELETE ON album_product_images FOR EACH ROW EXECUTE FUNCTION protect_product_configuration_image()',
    );
  } else {
    await db.raw(`CREATE TRIGGER protect_product_configuration_image BEFORE DELETE ON album_product_images
      WHEN EXISTS (SELECT 1 FROM product_configuration_image_references WHERE image_id = OLD.id)
      BEGIN SELECT RAISE(ABORT, 'Image belongs to a frozen product specification'); END`);
  }
  const { retain } = require('../../src/services/albumProducts/retention');
  const parse = require('../../src/services/albumProducts/validation').parse;
  for (const row of await db('contracts').whereNotNull('rendered_content')) {
    const content =
      typeof row.rendered_content === 'string'
        ? parse(row.rendered_content)
        : row.rendered_content;
    await retain(db, 'contract', row.id, content?.quote?.lineItems || []);
  }
  for (const [table, kind, owner] of [
    ['quote_line_items', 'quote', 'quote_id'],
    ['invoice_line_items', 'invoice', 'invoice_id'],
  ]) {
    const rows = await db(table).whereNotNull('configuration_snapshot');
    for (const row of rows) {
      if (kind === 'quote') {
        const quote = await db('quotes').where({ id: row.quote_id }).first();
        if (!['accepted', 'converted'].includes(quote?.status)) continue;
      }
      await retain(db, kind, row[owner], [row]);
    }
  }
};
exports.down = async (db) => {
  await db.schema.alterTable('invoices', (t) =>
    t.dropColumn('product_items_revision'),
  );
  if (db.client.config.client === 'pg') {
    await db.raw(
      'DROP TRIGGER IF EXISTS protect_product_configuration_image ON album_product_images',
    );
    await db.raw(
      'DROP FUNCTION IF EXISTS protect_product_configuration_image()',
    );
  } else
    await db.raw('DROP TRIGGER IF EXISTS protect_product_configuration_image');
  await db.schema.dropTableIfExists('product_configuration_image_references');
  await db.schema.dropTableIfExists('product_billable_items');
  await db.schema.alterTable('event_album_products', (t) => {
    t.dropColumn('catalogue_preset_id');
    t.dropColumn('billing_customer_id');
    t.dropColumn('show_prices');
  });
  for (const table of ['quote_line_items', 'invoice_line_items'])
    await db.schema.alterTable(table, (t) =>
      t.dropColumn('configuration_locked'),
    );
};
