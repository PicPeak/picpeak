'use strict';

/**
 * Migration 254: enumeration and replay signals on the public signing
 * routes (#1446).
 *
 * - contract_signing_signals: counts per hour of the things an attacker
 *   probing signing links leaves behind — unknown links, dead links, wrong
 *   codes, rate-limit hits, a reused idempotency key, a session reaching for
 *   another contract's file. Rows are appended by each replica's flush and
 *   summed when read, so replicas never contend for a row. `ip_hash` is an
 *   HMAC of the client address with a server secret (NULL when the "store
 *   IP" setting is off); no raw address, token or code is ever stored.
 * - contract_signing_alerts: one row per kind per hour once a threshold is
 *   crossed. The unique index is the claim, so the admin is told once per
 *   window however many replicas notice.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('contract_signing_signals'))) {
    await knex.schema.createTable('contract_signing_signals', (t) => {
      t.increments('id').primary();
      t.string('hour', 13).notNullable(); // YYYY-MM-DDTHH, UTC
      t.string('kind', 40).notNullable();
      t.integer('contract_id');
      t.string('ip_hash', 64);
      t.integer('count').notNullable().defaultTo(0);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.index(['hour', 'kind']);
    });
  }
  if (!(await knex.schema.hasTable('contract_signing_alerts'))) {
    await knex.schema.createTable('contract_signing_alerts', (t) => {
      t.increments('id').primary();
      t.string('hour', 13).notNullable();
      t.string('kind', 40).notNullable();
      t.integer('count').notNullable().defaultTo(0);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.unique(['hour', 'kind']);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('contract_signing_alerts');
  await knex.schema.dropTableIfExists('contract_signing_signals');
};
