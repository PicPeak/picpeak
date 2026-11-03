'use strict';
/**
 * Guided album order (issue 2320). Catalogue settings (hero image, photo
 * roles, option dependencies) live in the catalogue JSON and the photo roles
 * in the frozen selection, so this only adds who an offer belongs to:
 *
 * - released_customer_id limits an offer to one assigned customer. Null is
 *   the gallery's client (PIN or the only customer). Deliberately no foreign
 *   key: ON DELETE SET NULL would hand a private selection to the gallery's
 *   client, and billing_customer_id beside it has none either.
 * - album_product_choice_history.customer_account_id names the portal customer
 *   behind a client entry, whose actor_id is only a session digest, so a
 *   customer erasure can find the entry.
 *
 * Several customers can hold their own offer for one product, so uniqueness
 * moves from (event, product) to (event, product, customer).
 */
const SCOPED_INDEX = 'event_album_products_customer_scope_unique';
const OLD_UNIQUE = 'event_album_products_event_id_product_id_unique';

async function addColumn(db, table, column, build) {
  if (await db.schema.hasTable(table) && !(await db.schema.hasColumn(table, column)))
    await db.schema.alterTable(table, build);
}
async function dropColumn(db, table, column) {
  if (await db.schema.hasTable(table) && await db.schema.hasColumn(table, column))
    await db.schema.alterTable(table, (t) => t.dropColumn(column));
}
const isPg = (db) => db.client.config.client === 'pg';

exports.up = async (db) => {
  if (!(await db.schema.hasTable('event_album_products'))) return;
  await addColumn(db, 'event_album_products', 'released_customer_id', (t) =>
    t.integer('released_customer_id'),
  );
  await addColumn(db, 'album_product_choice_history', 'customer_account_id', (t) =>
    t.integer('customer_account_id'),
  );
  if (isPg(db))
    await db.raw(`ALTER TABLE event_album_products DROP CONSTRAINT IF EXISTS ${OLD_UNIQUE}`);
  else await db.raw(`DROP INDEX IF EXISTS ${OLD_UNIQUE}`);
  await db.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${SCOPED_INDEX} ON event_album_products (event_id, product_id, COALESCE(released_customer_id, 0))`,
  );
};

exports.down = async (db) => {
  if (!(await db.schema.hasTable('event_album_products'))) return;
  // Two customers' offers for one product cannot go back under the old
  // constraint, and dropping either would delete a customer's choice.
  const duplicate = await db('event_album_products')
    .select('event_id', 'product_id')
    .groupBy('event_id', 'product_id')
    .havingRaw('COUNT(*) > 1')
    .first();
  if (duplicate)
    throw new Error('Several customers hold offers for one product; remove them before rolling back');
  await db.raw(`DROP INDEX IF EXISTS ${SCOPED_INDEX}`);
  if (isPg(db))
    await db.raw(`ALTER TABLE event_album_products DROP CONSTRAINT IF EXISTS ${OLD_UNIQUE}`);
  else await db.raw(`DROP INDEX IF EXISTS ${OLD_UNIQUE}`);
  await db.schema.alterTable('event_album_products', (t) =>
    t.unique(['event_id', 'product_id']),
  );
  await dropColumn(db, 'album_product_choice_history', 'customer_account_id');
  await dropColumn(db, 'event_album_products', 'released_customer_id');
};
