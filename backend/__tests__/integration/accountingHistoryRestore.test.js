const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

let db; let cleanup; let adminId; let customerId; let history; let createPicpeak; let importFromPicpeak; let tmpDir;
let sequence = 0;

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  ({ adminId, customerId } = await seedMinimal(db));
  history = require('../../src/services/accountingHistory');
  ({ createPicpeak } = require('../../src/services/picpeakExportService'));
  ({ importFromPicpeak } = require('../../src/services/picpeakImportService'));
});
afterAll(async () => { if (cleanup) await cleanup(); });

it.each([false, true])('replaces local history when the archive contains history: %s', async (withHistory) => {
  const invoiceNumber = `RESTORE-${++sequence}`;
  const [{ id }] = await history.auditedInsert(db, 'invoices', {
    invoice_number: invoiceNumber, customer_account_id: customerId,
    issue_date: '2026-09-01', due_date: '2026-09-30',
  });
  const saved = withHistory ? await history.listHistory('invoice', id) : [];
  if (!withHistory) await db.schema.dropTable('accounting_change_history');
  const { filePath, manifest } = await createPicpeak({ includeFiles: false, outDir: `${tmpDir}/archives` });
  expect(Object.hasOwn(manifest.tables, 'accounting_change_history')).toBe(withHistory);
  if (!withHistory) await require('../../migrations/core/219_accounting_change_history').up(db);
  await history.auditedUpdate(db, 'invoices', { id }, { invoice_number: `${invoiceNumber}-LATER` });
  expect((await history.listHistory('invoice', id)).at(-1).changes.invoice_number.to).toBe(`${invoiceNumber}-LATER`);
  expect((await importFromPicpeak({ picpeakPath: filePath, currentAdminId: adminId })).restored).toBe(true);
  expect((await db('invoices').where({ id }).first()).invoice_number).toBe(invoiceNumber);
  expect(await history.listHistory('invoice', id)).toEqual(saved);
});
