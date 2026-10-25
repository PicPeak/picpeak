'use strict';
const crypto = require('crypto');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const migration = require('../../migrations/core/322_product_configuration_billing');
let db, cleanup, adminId, customerId;
beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId, customerId } = await seedMinimal(db));
});
afterAll(async () => { await cleanup?.(); });

test('a partial retention backfill and schema change can be retried without losing references', async () => {
  const id = crypto.randomUUID();
  await db('album_product_images').insert({ id, storage_key: `album-products/${id}.png`, sha256: 'a'.repeat(64),
    width: 1, height: 1, created_by: adminId, created_at: new Date().toISOString() });
  const quoteId = await require('../../src/services/quoteService').createQuote({ customerAccountId: customerId,
    currency: 'EUR', vatRate: 0, lineItems: [{ position: 1, quantity: 1, description: 'Frozen print', unit_price_minor: 100 }] }, adminId);
  await db('quotes').where({ id: quoteId }).update({ status: 'accepted' });
  await db('quote_line_items').where({ quote_id: quoteId }).update({ configuration_snapshot: JSON.stringify({
    attributes: [{ id: 'size', options: [{ id: 'large', imageId: id }] }],
  }) });
  await migration.down(db);
  const retention = require('../../src/services/albumProducts/retention');
  const original = retention.retain;
  const failure = jest.spyOn(retention, 'retain').mockImplementationOnce(async (...args) => {
    await original(...args);
    throw new Error('Interrupted after retaining one image');
  });
  try { await expect(migration.up(db)).rejects.toThrow('Interrupted'); }
  finally { failure.mockRestore(); }
  // A retry must also handle a partially completed multi-column alteration.
  await db.schema.alterTable('event_album_products', (t) => t.dropColumn('show_prices'));
  await migration.up(db);
  await migration.up(db);
  expect(await db.schema.hasColumn('event_album_products', 'show_prices')).toBe(true);
  const references = await db('product_configuration_image_references').where({ image_id: id });
  expect(references).toHaveLength(1);
  expect(references[0]).toMatchObject({ source_kind: 'quote', source_id: String(quoteId) });
  if (db.client.config.client === 'sqlite3') await db.raw('PRAGMA foreign_keys = OFF');
  await expect(db('album_product_images').where({ id }).del()).rejects.toThrow(/frozen product specification/);
  await migration.down(db);
  await migration.down(db);
  await migration.up(db);
  expect(await db('product_configuration_image_references').where({ image_id: id })).toHaveLength(1);
});

test('unreleased configurator migrations seed the final permission names and categories', async () => {
  expect(await db('permissions').where({ name: 'albums.edit' })).toHaveLength(0);
  const permissions = await db('permissions').whereIn('name', ['products.view', 'products.manage', 'products.configure']);
  expect(permissions).toHaveLength(3);
  expect(permissions.every((permission) => permission.category === 'products')).toBe(true);
  const configure = permissions.find((permission) => permission.name === 'products.configure');
  const roles = await db('roles').whereIn('name', ['super_admin', 'admin']);
  expect(await db('role_permissions').where({ permission_id: configure.id }).whereIn('role_id', roles.map((role) => role.id))).toHaveLength(roles.length);
});
