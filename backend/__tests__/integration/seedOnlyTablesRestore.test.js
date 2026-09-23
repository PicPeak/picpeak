const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

// #1600 follow-up: the "clear every table the archive doesn't list" fix
// generalizes correctly for genuine user-data tables (customer_groups —
// see customerGroupsRestore.test.js) but is WRONG for a table a migration
// seeds with mandatory rows only at table-creation time and never reseeds
// (product_usage_state, ledger_accounts, vat_codes, …) — see
// SEED_ONLY_TABLES in picpeakImportService.js. An archive made before one
// of those migrations ran never lists the table in its manifest, so the
// blanket clear would wipe it and, since migrations never re-run, nothing
// would ever put the seed rows back:
//   - product_usage_state: UsageService.status() dereferences the row
//     unguarded — an empty table is a hard crash on a live endpoint.
//   - ledger_accounts / vat_codes: the accounting feature silently loses
//     its whole chart of accounts / VAT codes with no in-app recovery.
let db; let cleanup; let adminId; let customerId; let createPicpeak; let importFromPicpeak; let tmpDir;

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  ({ adminId, customerId } = await seedMinimal(db));
  ({ createPicpeak } = require('../../src/services/picpeakExportService'));
  ({ importFromPicpeak } = require('../../src/services/picpeakImportService'));
});
afterAll(async () => { if (cleanup) await cleanup(); });

it('preserves seed-only tables the archive predates, while still clearing a genuine user-data table', async () => {
  // Simulate an archive made before migration 201 (product_usage), 129
  // (ledger_accounts/vat_codes) and 226 (customer_groups): drop all of them
  // so the export below never lists them in its manifest.
  await db.schema.dropTable('product_usage_state');
  await db.schema.dropTable('vat_codes');
  await db.schema.dropTable('ledger_accounts');
  await db.schema.dropTable('customer_group_members');
  await db.schema.dropTable('customer_groups');

  const { filePath, manifest } = await createPicpeak({ includeFiles: false, outDir: `${tmpDir}/archives-seed-only` });
  expect(Object.hasOwn(manifest.tables, 'product_usage_state')).toBe(false);
  expect(Object.hasOwn(manifest.tables, 'ledger_accounts')).toBe(false);
  expect(Object.hasOwn(manifest.tables, 'vat_codes')).toBe(false);
  expect(Object.hasOwn(manifest.tables, 'customer_groups')).toBe(false);

  // This instance is on a schema that HAS all of these tables (the archive
  // predates them, this instance doesn't) — recreate them via their
  // migrations, exactly what a real install on a newer schema looks like.
  await require('../../migrations/core/201_product_usage').up(db);
  await require('../../migrations/core/129_create_ledger_accounts_and_vat_codes').up(db);
  await require('../../migrations/core/226_customer_groups').up(db);

  // Also seed a local customer_groups row — the genuine user-data case
  // that must still be cleared by the restore (no regression on #1586).
  const [groupRow] = await db('customer_groups')
    .insert({ name: 'VIP', name_key: 'vip' })
    .returning('id');
  const groupId = groupRow?.id ?? groupRow;
  await db('customer_group_members').insert({ group_id: groupId, customer_account_id: customerId });

  const usageRowBefore = await db('product_usage_state').where({ id: 1 }).first();
  const ledgerAccountsBefore = await db('ledger_accounts');
  const vatCodesBefore = await db('vat_codes');
  expect(usageRowBefore).toBeTruthy();
  expect(ledgerAccountsBefore.length).toBeGreaterThan(0);
  expect(vatCodesBefore.length).toBeGreaterThan(0);
  expect(await db('customer_groups')).toHaveLength(1);
  expect(await db('customer_group_members')).toHaveLength(1);

  expect((await importFromPicpeak({ picpeakPath: filePath, currentAdminId: adminId })).restored).toBe(true);

  // Seed-only tables: the migration-seeded rows survive the restore.
  const usageRowAfter = await db('product_usage_state').where({ id: 1 }).first();
  expect(usageRowAfter).toBeTruthy();
  expect(usageRowAfter.id).toBe(1);
  expect(await db('ledger_accounts')).toHaveLength(ledgerAccountsBefore.length);
  expect(await db('vat_codes')).toHaveLength(vatCodesBefore.length);

  // Genuine user-data table: still correctly cleared (not regressed).
  expect(await db('customer_groups')).toEqual([]);
  expect(await db('customer_group_members')).toEqual([]);
});
