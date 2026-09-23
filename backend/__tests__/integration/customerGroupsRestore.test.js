const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

// #1586: a .picpeak archive made before a table existed never lists it in
// the manifest, so a restore that only clears manifest-listed tables leaves
// that table's LOCAL rows in place — attached to whatever restored row now
// reuses the same id. customer_groups (migration 226) is the reported case:
// an old archive left local group memberships pointing at the wrong
// restored customers. The fix generalizes accounting_change_history's
// one-off treatment (see accountingHistoryRestore.test.js) into clearing
// every table the CURRENT schema has, not just the ones the archive lists.
let db; let cleanup; let adminId; let customerId; let createPicpeak; let importFromPicpeak; let tmpDir;

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  ({ adminId, customerId } = await seedMinimal(db));
  ({ createPicpeak } = require('../../src/services/picpeakExportService'));
  ({ importFromPicpeak } = require('../../src/services/picpeakImportService'));
});
afterAll(async () => { if (cleanup) await cleanup(); });

it('clears a table the archive predates, not just the tables its manifest lists', async () => {
  // Simulate an archive made before migration 226 (customer groups): drop
  // both tables so the export below never lists them in its manifest.
  await db.schema.dropTable('customer_group_members');
  await db.schema.dropTable('customer_groups');

  const { filePath, manifest } = await createPicpeak({ includeFiles: false, outDir: `${tmpDir}/archives-groups` });
  expect(Object.hasOwn(manifest.tables, 'customer_groups')).toBe(false);
  expect(Object.hasOwn(manifest.tables, 'customer_group_members')).toBe(false);

  // This instance is on a schema that HAS the tables (the archive predates
  // them, this instance doesn't) — recreate them and seed local rows: a
  // group with the reporting customer as a member, the exact state that
  // must not survive restoring the archive above.
  await require('../../migrations/core/226_customer_groups').up(db);
  const [groupRow] = await db('customer_groups')
    .insert({ name: 'VIP', name_key: 'vip' })
    .returning('id');
  const groupId = groupRow?.id ?? groupRow;
  await db('customer_group_members').insert({ group_id: groupId, customer_account_id: customerId });

  expect(await db('customer_groups')).toHaveLength(1);
  expect(await db('customer_group_members')).toHaveLength(1);

  expect((await importFromPicpeak({ picpeakPath: filePath, currentAdminId: adminId })).restored).toBe(true);

  expect(await db('customer_groups')).toEqual([]);
  expect(await db('customer_group_members')).toEqual([]);
});
