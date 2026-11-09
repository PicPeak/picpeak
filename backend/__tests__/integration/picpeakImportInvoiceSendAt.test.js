/**
 * A .picpeak import rewrites invoice send dates that an older SQLite install
 * stored as numbers or zone-less text as ISO text, as migration 356 did.
 *
 * Archived rows are batch-inserted as they were, and migration 356 does not
 * run again on a target that already recorded it. Without the hook a send
 * date stored as a number would sort below the scheduler's ISO text "now"
 * and go out on the first tick, whatever date it holds. An edited send date
 * that had passed was never sent at the source either; it comes back held as
 * a draft, as migration 356 holds it.
 */

const fs = require('fs');
const path = require('path');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

let db; let cleanup; let tmpDir; let backupFile; let customerId;

// importFromPicpeak runs the coordinated portable restore, which needs a Linux
// host (portableRestoreCapability); elsewhere it refuses before restoring.
const linuxTest = process.platform === 'linux' ? test : test.skip;
const later = Date.UTC(2030, 0, 1, 9);

async function invoiceRow(number, sendAt) {
  await db('invoices').insert({
    invoice_number: number, customer_account_id: customerId, status: 'scheduled', currency: 'CHF',
    issue_date: '2026-11-09', due_date: '2026-11-23', scheduled_send_at: sendAt,
    net_amount_minor: 1000, vat_amount_minor: 0, total_amount_minor: 1000,
  });
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.env.STORAGE_PATH = tmpDir;
  let adminId;
  ({ adminId, customerId } = await seedMinimal(db));
  const { createPicpeak } = require('../../src/services/picpeakExportService');
  const { importFromPicpeak } = require('../../src/services/picpeakImportService');

  await invoiceRow('R-SENDAT-MS', later);
  await invoiceRow('R-SENDAT-EDITOR', '2030-01-01T09:00');
  // Edited, passed, never sent: held as a draft rather than sent late.
  await invoiceRow('R-SENDAT-STUCK', '2020-01-01T09:00');
  ({ filePath: backupFile } = await createPicpeak({ includePhotos: false }));
  await db('invoices').whereIn('invoice_number', ['R-SENDAT-MS', 'R-SENDAT-EDITOR', 'R-SENDAT-STUCK']).del();
  if (process.platform === 'linux') await importFromPicpeak({ picpeakPath: backupFile, currentAdminId: adminId });
}, 120000);

afterAll(async () => {
  if (backupFile) fs.rmSync(path.dirname(backupFile), { recursive: true, force: true });
  await cleanup();
});

linuxTest('restored send dates are ISO text, and a future one is not due', async () => {
  const rows = await db('invoices').whereIn('invoice_number', ['R-SENDAT-MS', 'R-SENDAT-EDITOR'])
    .orderBy('invoice_number').select('invoice_number', 'scheduled_send_at');
  expect(rows.map((r) => r.scheduled_send_at)).toEqual(['2030-01-01T09:00:00.000Z', '2030-01-01T09:00:00.000Z']);
  const due = await db('invoices').whereIn('invoice_number', ['R-SENDAT-MS', 'R-SENDAT-EDITOR'])
    .where('scheduled_send_at', '<=', new Date().toISOString());
  expect(due).toHaveLength(0);
  const stuck = await db('invoices').where({ invoice_number: 'R-SENDAT-STUCK' }).first('status', 'scheduled_send_at');
  expect(stuck).toEqual({ status: 'scheduled', scheduled_send_at: null });
});
