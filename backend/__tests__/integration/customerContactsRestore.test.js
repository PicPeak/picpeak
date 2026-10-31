const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

// A .picpeak archive made before migration 342 never lists customer_contacts
// or customer_logins. Restoring one must clear them, and the holder has to keep
// logging in: migrations do not run again after a restore, which is why the
// holder's password never moved to these tables.
let db; let cleanup; let adminId; let customerId; let createPicpeak; let importFromPicpeak; let tmpDir;

// importFromPicpeak runs the coordinated portable restore, which needs a Linux
// host (portableRestoreCapability); elsewhere it refuses before restoring.
const linuxIt = process.platform === 'linux' ? it : it.skip;

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  ({ adminId, customerId } = await seedMinimal(db));
  ({ createPicpeak } = require('../../src/services/picpeakExportService'));
  ({ importFromPicpeak } = require('../../src/services/picpeakImportService'));
});
afterAll(async () => { if (cleanup) await cleanup(); });

linuxIt('an archive older than contacts clears them and leaves the holder working', async () => {
  await db('customer_accounts').where({ id: customerId }).update({ password_hash: 'holder-hash' });
  await db.schema.dropTable('customer_logins');
  await db.schema.dropTable('customer_contacts');

  const { filePath, manifest } = await createPicpeak({ includeFiles: false, outDir: `${tmpDir}/archives-contacts` });
  expect(Object.hasOwn(manifest.tables, 'customer_contacts')).toBe(false);
  expect(Object.hasOwn(manifest.tables, 'customer_logins')).toBe(false);

  await require('../../migrations/core/342_customer_contacts').up(db);
  await db('customer_contacts').insert({ customer_account_id: customerId, email: 'local@example.test' });
  await db('customer_logins').insert({ email: 'local@example.test', password_hash: 'x' });

  expect((await importFromPicpeak({ picpeakPath: filePath, currentAdminId: adminId })).restored).toBe(true);

  expect(await db('customer_contacts')).toEqual([]);
  expect(await db('customer_logins')).toEqual([]);
  const holder = await db('customer_accounts').where({ id: customerId }).first();
  expect(holder.password_hash).toBe('holder-hash');
  const contacts = require('../../src/services/customerContactsService');
  expect(await contacts.membershipsFor(holder.email)).toHaveLength(1);
});
