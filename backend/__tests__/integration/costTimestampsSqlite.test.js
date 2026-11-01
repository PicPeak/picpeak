/**
 * Expenses and incoming invoices in the tax report and the journal on SQLite.
 *
 * expenseService wrote created_at as a Date, which SQLite stores as epoch
 * milliseconds; both reports select costs by comparing created_at with ISO
 * text bounds, and SQLite sorts every number before every text, so those rows
 * fell in no period. Pins:
 *  - migration 337 turns stored epoch numbers into ISO text, and a second run
 *    changes nothing
 *  - the writers now store ISO text
 *  - a cost on the last day of the period is in it, in both text shapes
 *    SQLite holds ('YYYY-MM-DD HH:MM:SS' and ISO with a 'T'), up to its last
 *    millisecond
 * The portable import's rerun of the rewrite is in picpeakImportCostTimestamps.
 */

const fs = require('fs');
const path = require('path');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('cost timestamps on SQLite (tax report, journal)', () => {
  let db; let cleanup; let tmpDir; let adminId;
  let expenseService; let taxReportService; let ledgerService; let migration;
  const PERIOD = { from: '2026-10-01', to: '2026-10-31', currency: 'CHF' };
  const unwrap = (r) => (typeof r[0] === 'object' ? r[0].id : r[0]);

  beforeAll(async () => {
    ({ db, cleanup, tmpDir } = await bootCrmDb());
    require('../../src/database/db').logActivity = async () => {};
    ({ adminId } = await seedMinimal(db));
    expenseService = require('../../src/services/expenseService');
    taxReportService = require('../../src/services/taxReportService');
    ledgerService = require('../../src/services/ledgerService');
    migration = require('../../migrations/core/337_cost_timestamps_iso');
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });
  afterEach(async () => { await db('expenses').del(); await db('inbound_documents').del(); });

  const expense = (createdAt, description) => db('expenses').insert({
    disposition: 'eigener_aufwand', tax_treatment: 'domestic', kind: 'amount', description,
    chf_amount_minor: 2000, gross_amount_minor: 2000, status: 'open',
    created_at: createdAt, updated_at: createdAt,
  }).returning('id').then(unwrap);

  const inbound = (createdAt, supplier) => db('inbound_documents').insert({
    source: 'upload', status: 'categorized', parse_status: 'manual', supplier_name: supplier,
    disposition: 'eigener_aufwand', tax_treatment: 'domestic', currency: 'CHF', invoice_date: null,
    net_amount_minor: 1000, vat_amount_minor: 81, total_amount_minor: 1081,
    created_at: createdAt, updated_at: createdAt,
  }).returning('id').then(unwrap);

  const costIds = async () => {
    const report = await taxReportService.getTaxReport(PERIOD);
    return report.costs.rows.map((r) => `${r.source}-${r.id}`).sort();
  };

  it('migration 337 brings epoch-ms rows into the period, and is a no-op on a second run', async () => {
    const e = await expense(Date.UTC(2026, 9, 13, 12), 'Parking');
    const i = await inbound(Date.UTC(2026, 9, 14, 9), 'Lab AG');
    expect(await costIds()).toEqual([]);

    await migration.up(db);
    const stored = await db('expenses').where({ id: e }).first('created_at');
    expect(stored.created_at).toBe('2026-10-13T12:00:00.000Z');
    expect(await costIds()).toEqual([`expense-${e}`, `incoming-${i}`].sort());
    const { postings } = await ledgerService.buildPostings(PERIOD);
    expect(postings.map((p) => p.source).sort()).toEqual(['expense', 'incoming']);

    await migration.up(db);
    expect((await db('expenses').where({ id: e }).first('created_at')).created_at).toBe('2026-10-13T12:00:00.000Z');
  });

  it('counts a cost on the last day of the period in both text shapes', async () => {
    const iso = await expense('2026-10-31T18:30:00.000Z', 'ISO');
    const plain = await expense('2026-10-31 18:30:00', 'database default');
    const lastMs = await expense('2026-10-31T23:59:59.999Z', 'last millisecond');
    await expense('2026-11-01T00:00:00.000Z', 'next month');
    await expense('2026-11-01 00:00:00', 'next month, database default');
    expect(await costIds()).toEqual([`expense-${iso}`, `expense-${plain}`, `expense-${lastMs}`].sort());
    const { postings } = await ledgerService.buildPostings(PERIOD);
    expect(postings.filter((p) => p.source === 'expense')).toHaveLength(3);
  });

  it('new expenses and incoming invoices are stored as ISO text', async () => {
    const created = await expenseService.createExpense(
      { disposition: 'eigener_aufwand', kind: 'amount', chfAmountMinor: 1500, description: 'Taxi' }, adminId,
    );
    const filePath = path.join(tmpDir, 'invoice.txt');
    await fs.promises.writeFile(filePath, 'supplier invoice');
    const doc = await expenseService.recordInboundDocument(
      { source: 'upload', filePath, originalFilename: 'invoice.txt', mimeType: 'text/plain' }, adminId,
    );
    const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    expect((await db('expenses').where({ id: created.id }).first('created_at')).created_at).toMatch(ISO);
    expect((await db('inbound_documents').where({ id: doc.id }).first('created_at')).created_at).toMatch(ISO);
  });
});
