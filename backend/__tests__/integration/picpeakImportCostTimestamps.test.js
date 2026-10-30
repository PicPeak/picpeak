/**
 * A .picpeak import rewrites epoch-ms cost timestamps it brings back as ISO
 * text, the way it already canonicalises events.expires_at.
 *
 * Archived rows are batch-inserted as they were, and migration 337 does not
 * run again on a target that already recorded it; without the hook expenses
 * and undated incoming invoices from an older SQLite install would come back
 * as numbers and fall out of every tax report and journal period.
 */

const fs = require('fs');
const path = require('path');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

let db; let cleanup; let tmpDir; let backupFile;

// importFromPicpeak runs the coordinated portable restore, which needs a Linux
// host (portableRestoreCapability); elsewhere it refuses before restoring.
const linuxTest = process.platform === 'linux' ? test : test.skip;
const at = Date.UTC(2026, 9, 13, 12);

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.env.STORAGE_PATH = tmpDir;
  const { adminId } = await seedMinimal(db);
  const { createPicpeak } = require('../../src/services/picpeakExportService');
  const { importFromPicpeak } = require('../../src/services/picpeakImportService');

  await db('expenses').insert({
    disposition: 'eigener_aufwand', tax_treatment: 'domestic', kind: 'amount', description: 'Parking',
    chf_amount_minor: 2000, gross_amount_minor: 2000, status: 'open', created_at: at, updated_at: at,
  });
  await db('inbound_documents').insert({
    source: 'upload', status: 'categorized', parse_status: 'manual', supplier_name: 'Lab AG',
    disposition: 'eigener_aufwand', tax_treatment: 'domestic', currency: 'CHF', invoice_date: null,
    net_amount_minor: 1000, vat_amount_minor: 81, total_amount_minor: 1081, created_at: at, updated_at: at,
  });
  ({ filePath: backupFile } = await createPicpeak({ includePhotos: false }));
  await db('expenses').del();
  await db('inbound_documents').del();
  if (process.platform === 'linux') await importFromPicpeak({ picpeakPath: backupFile, currentAdminId: adminId });
}, 120000);

afterAll(async () => {
  if (backupFile) fs.rmSync(path.dirname(backupFile), { recursive: true, force: true });
  await cleanup();
});

linuxTest('the imported costs carry ISO text timestamps, inside their period', async () => {
  const expense = await db('expenses').where({ description: 'Parking' }).first('created_at', 'updated_at');
  const inbound = await db('inbound_documents').where({ supplier_name: 'Lab AG' }).first('created_at');
  expect(expense).toEqual({ created_at: '2026-10-13T12:00:00.000Z', updated_at: '2026-10-13T12:00:00.000Z' });
  expect(inbound.created_at).toBe('2026-10-13T12:00:00.000Z');

  const report = await require('../../src/services/taxReportService')
    .getTaxReport({ from: '2026-10-01', to: '2026-10-31', currency: 'CHF' });
  expect(report.costs.rows.map((r) => r.source).sort()).toEqual(['expense', 'incoming']);
});
