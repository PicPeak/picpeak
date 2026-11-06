'use strict';
/**
 * Parcel tracking for an album order (issue 2422). One row per parcel the
 * studio sent for a confirmed offer, so the main album and the parents'
 * albums can travel separately.
 *
 * tracking_url is only stored for the carrier "other": the known carriers'
 * links are built from the number when read (albumProducts/shipments.js), so
 * a carrier that moves its tracking page is one edit, not a data fix.
 * notified_at is set when the customer's mail was queued; null means the
 * studio chose not to send one or nobody could be reached.
 *
 * No customer column: the customer is the offer's (released_customer_id or
 * the gallery's client), so a reassignment or an erasure is decided there.
 */
exports.up = async (db) => {
  if (!(await db.schema.hasTable('event_album_products'))) return;
  if (await db.schema.hasTable('album_shipments')) return;
  await db.schema.createTable('album_shipments', (t) => {
    t.increments('id').primary();
    t.string('offer_id', 36)
      .notNullable()
      .references('id')
      .inTable('event_album_products')
      .onDelete('CASCADE');
    t.string('carrier', 32).notNullable();
    t.string('tracking_number', 64).notNullable();
    t.string('tracking_url', 2048);
    t.timestamp('shipped_at').notNullable();
    t.timestamp('notified_at');
    t.integer('created_by')
      .unsigned()
      .references('id')
      .inTable('admin_users')
      .onDelete('SET NULL');
    t.timestamp('created_at').notNullable();
    t.index(['offer_id']);
  });
};

exports.down = async (db) => {
  await db.schema.dropTableIfExists('album_shipments');
};
