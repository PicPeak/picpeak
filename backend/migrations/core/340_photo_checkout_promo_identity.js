'use strict';

const { addColumnIfNotExists } = require('../helpers');

exports.up = async function up(knex) {
  await addColumnIfNotExists(knex, 'photo_purchase_orders', 'promo_identity_hash',
    (t) => t.string('promo_identity_hash', 64).nullable());
  await knex.raw('CREATE INDEX IF NOT EXISTS ?? ON ?? (??)',
    ['photo_orders_promo_identity', 'photo_purchase_orders', 'promo_identity_hash']);
  if (!(await knex.schema.hasTable('photo_checkout_verifications'))) {
    await knex.schema.createTable('photo_checkout_verifications', (t) => {
      t.increments('id').primary();
      t.string('challenge', 48).notNullable();
      t.integer('gallery_id').notNullable().references('events.id').onDelete('CASCADE');
      // No plaintext address, code or browser proof is retained here.
      t.string('email_hash', 64).notNullable();
      t.string('browser_hash', 64).notNullable();
      t.string('code_hash', 60).notNullable();
      t.integer('attempts').notNullable().defaultTo(0);
      t.string('created_at', 32).notNullable();
      t.string('expires_at', 32).notNullable();
      t.string('consumed_at', 32).nullable();
    });
  }
  // Explicit idempotent indexes also repair an interrupted table/index step.
  await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS ?? ON ?? (??)',
    ['photo_checkout_verifications_challenge_unique', 'photo_checkout_verifications', 'challenge']);
  for (const column of ['email_hash', 'expires_at']) {
    await knex.raw('CREATE INDEX IF NOT EXISTS ?? ON ?? (??)',
      [`photo_checkout_verifications_${column}_index`, 'photo_checkout_verifications', column]);
  }
};

exports.down = async function down(knex) {
  if (await knex('photo_purchase_orders').whereNotNull('promo_identity_hash').first('id')) {
    throw new Error('Cannot remove promo identity storage while verified checkout orders exist');
  }
  await knex.schema.dropTableIfExists('photo_checkout_verifications');
  await knex.raw('DROP INDEX IF EXISTS ??', ['photo_orders_promo_identity']);
  if (await knex.schema.hasColumn('photo_purchase_orders', 'promo_identity_hash')) {
    await knex.schema.alterTable('photo_purchase_orders', (t) => t.dropColumn('promo_identity_hash'));
  }
};
