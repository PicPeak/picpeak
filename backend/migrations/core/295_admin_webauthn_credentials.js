'use strict';

/**
 * Migration 295: passkeys (WebAuthn credentials) for admin login, issue 1733.
 *
 * One row per registered passkey. `credential_id` and `public_key` are the
 * base64url values the authenticator handed over at registration; the public
 * key is not a secret. `counter` is the authenticator's signature counter
 * (bigint: PostgreSQL returns it as a string, the service coerces it).
 *
 * The FK cascades on PostgreSQL; SQLite runs without PRAGMA foreign_keys, so
 * the admin hard delete (userManagementService.js) removes the rows itself.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('admin_webauthn_credentials')) return;
  if (!(await knex.schema.hasTable('admin_users'))) return;
  await knex.schema.createTable('admin_webauthn_credentials', (t) => {
    t.increments('id').primary();
    t.integer('admin_user_id').notNullable()
      .references('id').inTable('admin_users').onDelete('CASCADE');
    t.string('credential_id', 1024).notNullable().unique();
    t.text('public_key').notNullable();
    t.bigInteger('counter').notNullable().defaultTo(0);
    // JSON array of transport hints ("internal", "usb", "hybrid", ...).
    t.text('transports').nullable();
    t.string('aaguid', 64).nullable();
    t.string('name', 100).notNullable();
    t.datetime('created_at').notNullable();
    t.datetime('last_used_at').nullable();
    t.index(['admin_user_id']);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('admin_webauthn_credentials'))) return;
  await knex.schema.dropTable('admin_webauthn_credentials');
};
