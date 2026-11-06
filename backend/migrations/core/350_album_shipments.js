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
 * studio chose not to send one or nobody could be reached. notification_id
 * is that mail's email_queue row, withdrawn while still pending when the
 * parcel is deleted (no foreign key: the queue is pruned on its own).
 *
 * customer_account_id is the order's customer when the parcel was recorded
 * (albumProducts/shipments.js orderCustomerId), kept so a later change of
 * the gallery's customers never hands the parcel to someone else: the portal
 * shows it only to that customer, and only while they are still assigned.
 * Null when nobody could be named (a PIN-only gallery). No foreign key, like
 * released_customer_id: erasure deletes the rows itself.
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
    t.integer('notification_id');
    t.integer('customer_account_id');
    t.integer('created_by')
      .unsigned()
      .references('id')
      .inTable('admin_users')
      .onDelete('SET NULL');
    t.timestamp('created_at').notNullable();
    t.index(['offer_id']);
    t.index(['customer_account_id']);
  });
};

exports.down = async (db) => {
  await db.schema.dropTableIfExists('album_shipments');
};
