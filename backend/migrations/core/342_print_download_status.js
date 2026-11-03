'use strict';

// Short-lived delivery status, shared by replicas. No file paths or credentials.
exports.up = async function (db) {
  if (!await db.schema.hasTable('print_sales_downloads')) await db.schema.createTable('print_sales_downloads', t => {
    t.string('id', 36).primary();
    t.string('order_id', 36).notNullable().references('id').inTable('print_sales_orders').onDelete('CASCADE');
    t.integer('admin_id').notNullable().references('id').inTable('admin_users').onDelete('CASCADE');
    t.string('kind', 8).notNullable(); t.string('status', 16).notNullable(); t.string('error', 300);
    t.timestamp('expires_at').notNullable();
  });
  await db.raw('CREATE INDEX IF NOT EXISTS print_sales_downloads_expires_at_index ON print_sales_downloads (expires_at)');
};
exports.down = async function (db) { await db.schema.dropTableIfExists('print_sales_downloads'); };
