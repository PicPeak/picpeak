/**
 * Migration 383: website_contact_confirmations (issue 2618).
 *
 * The contact form's confirmation to the visitor goes at most once a day to
 * an address. Checking the mail queue first and queueing after let messages
 * sent at the same moment all pass the check (and across replicas no lock
 * helps), so each confirmation is reserved first: one row per address key
 * (trimmed, lowercased) and UTC day, UNIQUE, inserted with "ignore on
 * conflict"; only the request whose insert made the row (its own `claim`
 * token) sends. Rows older than two days are deleted as new ones come in.
 *
 * A new table: down drops it.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('website_contact_confirmations')) return;
  await knex.schema.createTable('website_contact_confirmations', (t) => {
    t.increments('id').primary();
    t.string('address_key', 254).notNullable();
    // The UTC day, YYYY-MM-DD.
    t.string('window_start', 10).notNullable();
    t.string('claim', 36).notNullable();
    // ISO 8601 text, as both engines store and compare it alike.
    t.string('created_at', 40).notNullable();
    t.unique(['address_key', 'window_start']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('website_contact_confirmations');
};
