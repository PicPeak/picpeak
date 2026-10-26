'use strict';

const knex = require('knex');
const migration = require('../../migrations/core/327_stripe_photo_checkout');

// Run the same upgrade contract on PostgreSQL when its dedicated test URL
// is supplied, isolated in a fresh schema so other suites are untouched.
describe.each(['sqlite3', ...(process.env.PICPEAK_PG_TEST_URL ? ['pg'] : [])])('Stripe checkout upgrade on %s', (client) => {
  let db; let schema; let root;
  beforeEach(async () => {
    if (client === 'pg') {
      root = knex({ client, connection: process.env.PICPEAK_PG_TEST_URL });
      schema = `stripe_upgrade_${require('crypto').randomBytes(8).toString('hex')}`;
      await root.raw(`CREATE SCHEMA "${schema}"`);
      db = knex({ client, connection: process.env.PICPEAK_PG_TEST_URL, searchPath: [schema] });
    } else db = knex({ client, connection: { filename: ':memory:' }, useNullAsDefault: true });
    if (client === 'sqlite3') await db.raw('PRAGMA foreign_keys = ON');
    await db.schema.createTable('events', (t) => t.increments('id').primary());
    await db.schema.createTable('photo_purchase_orders', (t) => {
      t.increments('id').primary();
      t.string('order_id').notNullable().unique();
      t.integer('gallery_id').notNullable().references('events.id').onDelete('CASCADE');
      t.boolean('promo_used').notNullable().defaultTo(false);
    });
    await db('events').insert({ id: 1 });
    await db('photo_purchase_orders').insert({ order_id: 'historic-order', gallery_id: 1, promo_used: true });
  });
  afterEach(async () => {
    if (db) await db.destroy();
    if (root) { await root.raw(`DROP SCHEMA "${schema}" CASCADE`); await root.destroy(); root = null; }
  });

  test('backfills historical orders and promo usage, preserves financial records on deletion, and reruns safely', async () => {
    await migration.up(db);
    await migration.up(db);
    expect(await db('photo_purchase_orders').first()).toMatchObject({ payment_provider: 'snipcart', promo_gallery_id: 1 });
    await expect(db('photo_purchase_orders').insert({ order_id: 'duplicate-promo', gallery_id: 1, promo_gallery_id: 1 }))
      .rejects.toThrow();
    await db('events').where({ id: 1 }).del();
    expect(await db('photo_purchase_orders').first()).toMatchObject({ order_id: 'historic-order', gallery_id: null, promo_gallery_id: null });
  });

  test('repairs a partially applied foreign-key change', async () => {
    await db.schema.alterTable('photo_purchase_orders', (t) => t.dropForeign('gallery_id'));
    await migration.up(db);
    await db('events').where({ id: 1 }).del();
    expect(await db('photo_purchase_orders').first()).toMatchObject({ order_id: 'historic-order', gallery_id: null });
  });

  test('down preserves old orders, and refuses to discard Stripe financial state', async () => {
    await migration.up(db);
    await db('photo_purchase_orders').insert({ order_id: 'stripe:new', gallery_id: 1, payment_provider: 'stripe' });
    await expect(migration.down(db)).rejects.toThrow('Stripe orders exist');
    await db('photo_purchase_orders').where({ payment_provider: 'stripe' }).del();
    await migration.down(db);
    expect(await db('photo_purchase_orders').first()).toMatchObject({ order_id: 'historic-order', gallery_id: 1 });
    expect(await db.schema.hasColumn('photo_purchase_orders', 'checkout_quote')).toBe(false);
  });
});
