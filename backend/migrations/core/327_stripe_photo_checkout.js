'use strict';

const { addColumnIfNotExists } = require('../helpers');

exports.up = async function up(knex) {
  const fields = {
    payment_provider: (t) => t.string('payment_provider', 16).notNullable().defaultTo('snipcart'),
    checkout_key: (t) => t.string('checkout_key', 64).nullable().unique(),
    checkout_session_id: (t) => t.string('checkout_session_id', 191).nullable().unique(),
    payment_intent_id: (t) => t.string('payment_intent_id', 191).nullable().unique(),
    payment_refund_id: (t) => t.string('payment_refund_id', 191).nullable(),
    checkout_token: (t) => t.string('checkout_token', 64).nullable().unique(),
    checkout_browser_hash: (t) => t.string('checkout_browser_hash', 64).nullable(),
    checkout_quote: (t) => t.text('checkout_quote').nullable(),
    // NULL for ordinary orders; UNIQUE reserves a gallery's promo across
    // pending Stripe checkouts and completed purchases from either provider.
    promo_gallery_id: (t) => t.integer('promo_gallery_id').nullable().unique(),
  };
  for (const [column, define] of Object.entries(fields)) {
    await addColumnIfNotExists(knex, 'photo_purchase_orders', column, define);
  }

  // Keep paid/pending financial records when the gallery goes away. A
  // Stripe payment may arrive after deletion and still needs refunding.
  const sqlite = knex.client.config.client === 'sqlite3';
  const oldForeignKey = sqlite
    ? (await knex.raw('PRAGMA foreign_key_list(photo_purchase_orders)'))
      .some((fk) => fk.from === 'gallery_id' && fk.on_delete !== 'SET NULL')
    : (await knex.raw(`SELECT 1 FROM information_schema.referential_constraints
        WHERE constraint_schema = current_schema()
        AND constraint_name = 'photo_purchase_orders_gallery_id_foreign'
        AND delete_rule <> 'SET NULL'`)).rows.length > 0;
  if (oldForeignKey) {
    await knex.schema.alterTable('photo_purchase_orders', (t) => {
      t.dropForeign('gallery_id');
      t.integer('gallery_id').nullable().alter();
      t.foreign('gallery_id').references('events.id').onDelete('SET NULL');
    });
  }

  // A historical redemption stays spent, including a refunded purchase.
  const used = await knex('photo_purchase_orders').where({ promo_used: true })
    .whereNotNull('gallery_id').select('gallery_id').min('id as id').groupBy('gallery_id');
  for (const row of used) {
    const reserved = await knex('photo_purchase_orders').where({ promo_gallery_id: row.gallery_id }).first('id');
    if (!reserved) await knex('photo_purchase_orders').where({ id: row.id }).update({ promo_gallery_id: row.gallery_id });
  }
};

exports.down = async function down(knex) {
  if (await knex('photo_purchase_orders').where({ payment_provider: 'stripe' }).first('id')) {
    throw new Error('Cannot remove Stripe checkout storage while Stripe orders exist');
  }
  for (const column of ['promo_gallery_id', 'checkout_quote', 'checkout_browser_hash', 'checkout_token', 'payment_refund_id', 'payment_intent_id', 'checkout_session_id', 'checkout_key', 'payment_provider']) {
    if (await knex.schema.hasColumn('photo_purchase_orders', column)) {
      await knex.schema.alterTable('photo_purchase_orders', (t) => t.dropColumn(column));
    }
  }
  // Deliberately retain SET NULL: restoring CASCADE would destroy financial
  // history, and orphaned historical orders cannot regain a deleted gallery.
};
