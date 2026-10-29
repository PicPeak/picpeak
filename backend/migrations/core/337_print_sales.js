'use strict';
exports.up = async function (db) {
  if (!await db.schema.hasTable('print_sales_settings')) {
    await db.schema.createTable('print_sales_settings', t => {
      t.integer('id').primary(); t.integer('revision').notNullable();
      t.text('configuration').notNullable(); t.timestamp('updated_at').notNullable();
    });
  }
  await db('print_sales_settings').insert({ id: 1, revision: 0,
    configuration: JSON.stringify({ profiles: [], countries: [], policy: '', shippingPresetId: null }),
    updated_at: new Date().toISOString() }).onConflict('id').ignore();
  if (!await db.schema.hasColumn('events', 'print_sales_enabled'))
    await db.schema.alterTable('events', t => {
      t.boolean('print_sales_enabled').notNullable().defaultTo(false);
    });
  if (!await db.schema.hasColumn('events', 'print_sales_admin_id'))
    await db.schema.alterTable('events', t => t.integer('print_sales_admin_id').references('id').inTable('admin_users').onDelete('SET NULL'));
  if (!await db.schema.hasTable('print_sales_orders')) await db.schema.createTable('print_sales_orders', t => {
    t.string('id', 36).primary(); t.string('request_hash', 64).notNullable();
    t.integer('event_id').references('id').inTable('events').onDelete('SET NULL');
    t.integer('customer_account_id').notNullable().references('id').inTable('customer_accounts').onDelete('RESTRICT');
    t.integer('created_by_admin_id').references('id').inTable('admin_users').onDelete('SET NULL');
    t.integer('invoice_id').unique().references('id').inTable('invoices').onDelete('RESTRICT');
    t.text('snapshot'); t.text('contact'); t.boolean('purge_requested').notNullable().defaultTo(false);
    t.string('snapshot_hash', 64); t.string('invoice_hash', 64);
    t.string('status', 24).notNullable(); t.string('render_status', 24).notNullable().defaultTo('pending');
    t.integer('attempts').notNullable().defaultTo(0); t.string('claim', 36); t.timestamp('heartbeat');
    t.string('artwork_version', 64); t.string('reviewed_version', 64); t.integer('reviewed_by');
    t.timestamp('accepted_at'); t.timestamp('reviewed_at'); t.timestamp('submitted_at'); t.timestamp('dispatched_at');
    t.text('supplier_reference'); t.text('tracking'); t.text('error');
    t.timestamp('created_at').notNullable(); t.timestamp('expires_at').notNullable();
    t.timestamp('purged_at'); t.timestamp('closed_at');
    t.index(['customer_account_id', 'created_at']); t.index(['render_status', 'created_at']);
  });
  if (!await db.schema.hasTable('print_sales_assets')) await db.schema.createTable('print_sales_assets', t => {
    t.string('id', 36).primary(); t.string('order_id', 36).notNullable().references('id').inTable('print_sales_orders').onDelete('CASCADE');
    t.string('storage_key', 512).notNullable().unique(); t.string('sha256', 64).notNullable();
    t.integer('size').notNullable(); t.string('kind', 16).notNullable(); t.string('claim', 36);
    t.timestamp('created_at').notNullable();
  });
  // Accepted commercial/source snapshots cannot be rewritten by a later catalogue edit.
  if (db.client.config.client === 'pg') {
    await db.raw(`CREATE OR REPLACE FUNCTION print_sales_snapshot_guard() RETURNS trigger AS $$ BEGIN
      IF OLD.status <> 'capturing' AND (NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash
        OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id AND OLD.invoice_id IS NOT NULL
        OR NEW.customer_account_id IS DISTINCT FROM OLD.customer_account_id) THEN RAISE EXCEPTION 'Print order snapshot is immutable'; END IF;
      RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await db.raw('DROP TRIGGER IF EXISTS print_sales_snapshot_guard ON print_sales_orders');
    await db.raw('CREATE TRIGGER print_sales_snapshot_guard BEFORE UPDATE ON print_sales_orders FOR EACH ROW EXECUTE FUNCTION print_sales_snapshot_guard()');
  } else await db.raw(`CREATE TRIGGER IF NOT EXISTS print_sales_snapshot_guard BEFORE UPDATE ON print_sales_orders
    WHEN OLD.status <> 'capturing' AND (NEW.snapshot IS NOT OLD.snapshot OR NEW.snapshot_hash IS NOT OLD.snapshot_hash
      OR (OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS NOT OLD.invoice_id) OR NEW.customer_account_id IS NOT OLD.customer_account_id)
    BEGIN SELECT RAISE(ABORT, 'Print order snapshot is immutable'); END`);
  await db('feature_flags').insert({ key: 'printSales', value: false }).onConflict('key').ignore();
  await db('backup_paths').insert({ path: '.print-sales', include_in_default: true,
    feature_flag: null, display_order: 115, description: 'Retained print order originals and production artwork' }).onConflict('path').ignore();
};
exports.down = async function (db) {
  if (await db('print_sales_orders').first()) throw new Error('Retained print orders prevent destructive rollback');
  await db.schema.dropTableIfExists('print_sales_assets');
  await db.schema.dropTableIfExists('print_sales_orders');
  if (db.client.config.client === 'pg') await db.raw('DROP FUNCTION IF EXISTS print_sales_snapshot_guard()');
  await db.schema.dropTableIfExists('print_sales_settings');
  await db.schema.alterTable('events', t => { t.dropColumn('print_sales_enabled'); t.dropColumn('print_sales_admin_id'); });
  await db('feature_flags').where({ key: 'printSales' }).del();
  await db('backup_paths').where({ path: '.print-sales' }).del();
};
