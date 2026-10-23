'use strict';

/**
 * Migration 317: photo sales for priced galleries (Snipcart).
 *
 * events:  is_priced, free_photo_count, photo_price (gallery default),
 *          purchase_access_days, and the one-time promo code with the id of
 *          the Snipcart discount behind it.
 * photos:  photo_price (NULL = the gallery default) and the persisted,
 *          watermarked sales preview (path + the fingerprint of the mark
 *          settings it was rendered with).
 * photo_purchase_orders: one row per Snipcart order. Its access_token is
 *          the buyer's link and is unique.
 * photo_purchases: one row per bought photo. Every row of an order shares
 *          the order's access_token, so it is NOT unique here.
 *
 * Idempotent: every column and table is created only when missing.
 */

const { addColumnIfNotExists } = require('../helpers');

exports.up = async function up(knex) {
  await addColumnIfNotExists(knex, 'events', 'is_priced', (table) => {
    table.boolean('is_priced').notNullable().defaultTo(false);
  });
  await addColumnIfNotExists(knex, 'events', 'free_photo_count', (table) => {
    table.integer('free_photo_count').notNullable().defaultTo(0);
  });
  await addColumnIfNotExists(knex, 'events', 'photo_price', (table) => {
    table.decimal('photo_price', 10, 2).nullable().defaultTo(null);
  });
  await addColumnIfNotExists(knex, 'events', 'purchase_access_days', (table) => {
    table.integer('purchase_access_days').notNullable().defaultTo(30);
  });
  await addColumnIfNotExists(knex, 'events', 'promo_code', (table) => {
    table.text('promo_code');
  });
  await addColumnIfNotExists(knex, 'events', 'snipcart_discount_id', (table) => {
    table.text('snipcart_discount_id');
  });

  await addColumnIfNotExists(knex, 'photos', 'photo_price', (table) => {
    table.decimal('photo_price', 10, 2).nullable().defaultTo(null);
  });
  await addColumnIfNotExists(knex, 'photos', 'photo_sales_preview_key', (table) => {
    table.text('photo_sales_preview_key');
  });
  await addColumnIfNotExists(knex, 'photos', 'photo_sales_preview_path', (table) => {
    table.text('photo_sales_preview_path');
  });

  if (!(await knex.schema.hasTable('photo_purchases'))) {
    await knex.schema.createTable('photo_purchases', (t) => {
      t.increments('id').primary();
      t.string('order_id', 191).notNullable();
      t.integer('gallery_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
      t.integer('photo_id').notNullable().references('id').inTable('photos').onDelete('CASCADE');
      t.string('buyer_email', 191).notNullable();
      t.string('purchased_at', 32).notNullable();
      t.string('expires_at', 32).notNullable();
      t.string('access_token', 191).notNullable();
      t.string('currency', 8).notNullable().defaultTo('EUR');
      t.integer('amount_cents').notNullable().defaultTo(0);
      t.boolean('email_sent').notNullable().defaultTo(false);
      t.timestamp('created_at').nullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').nullable().defaultTo(knex.fn.now());
      t.unique(['order_id', 'photo_id'], 'photo_purchases_order_photo_uniq');
    });
  }

  if (!(await knex.schema.hasTable('photo_purchase_orders'))) {
    await knex.schema.createTable('photo_purchase_orders', (t) => {
      t.increments('id').primary();
      t.string('order_id', 191).notNullable().unique();
      t.integer('gallery_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
      t.string('buyer_email', 191).notNullable();
      t.integer('total_cents').notNullable().defaultTo(0);
      t.string('currency', 8).notNullable().defaultTo('EUR');
      t.string('status', 32).notNullable().defaultTo('completed');
      t.string('purchased_at', 32).notNullable();
      t.string('expires_at', 32).nullable();
      t.string('access_token', 191).notNullable().unique();
      t.boolean('email_sent').notNullable().defaultTo(false);
      t.boolean('promo_used').notNullable().defaultTo(false);
      t.timestamp('created_at').nullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').nullable().defaultTo(knex.fn.now());
    });
  }
  // A table created before the one-time promo code existed.
  await addColumnIfNotExists(knex, 'photo_purchase_orders', 'promo_used', (table) => {
    table.boolean('promo_used').notNullable().defaultTo(false);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('photo_purchase_orders');
  await knex.schema.dropTableIfExists('photo_purchases');

  const columns = {
    events: ['is_priced', 'free_photo_count', 'photo_price', 'purchase_access_days', 'promo_code', 'snipcart_discount_id'],
    photos: ['photo_price', 'photo_sales_preview_key', 'photo_sales_preview_path'],
  };
  for (const [tableName, names] of Object.entries(columns)) {
    for (const column of names) {
      if (await knex.schema.hasColumn(tableName, column)) {
        await knex.schema.alterTable(tableName, (t) => t.dropColumn(column));
      }
    }
  }
};
