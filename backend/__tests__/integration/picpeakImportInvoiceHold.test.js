'use strict';

/**
 * A scheduled invoice whose send date passed without sending, in an archive
 * made before migration 356, comes back held as a draft and marked
 * (send_held_at, migration 358): on a SQLite target by the SQLite rewrite,
 * and on a PostgreSQL target from a SQLite archive, where the coercion has
 * already made the stored text a timestamp (issue 2459). A future send date
 * stays scheduled, and an archive from 356 on restores as it was.
 *
 * Runs on the migrated schema of whichever engine the run uses (SQLite by
 * default, PostgreSQL with DATABASE_CLIENT=pg). On PostgreSQL the archive is
 * a SQLite one, so the load is cross-engine.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// The supervised restore worker is not what this pins; the row handling is.
jest.mock('../../src/services/portableRestoreWorker', () => ({
  ...jest.requireActual('../../src/services/portableRestoreWorker'),
  assertWorkerAuthority: jest.fn(async () => ({})),
}));

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup; let tmpDir; let customerId; let isPg;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ customerId } = await seedMinimal(db));
  isPg = db.client.config.client === 'pg';
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-invoice-hold-'));
});

afterAll(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  if (cleanup) await cleanup();
});

// As a SQLite install before 356 stored them: the editor's zone-less text,
// and epoch milliseconds from the create paths.
const invoice = (id, sendAt, status = 'scheduled') => ({
  id, invoice_number: `R-HOLD-${id}`, customer_account_id: customerId, status, currency: 'CHF',
  issue_date: '2026-01-01', due_date: '2026-01-15', scheduled_send_at: sendAt,
  net_amount_minor: 1000, vat_amount_minor: 0, total_amount_minor: 1000,
});

async function restore(rows, archiveLatestMigration, history = []) {
  const dataDir = path.join(tmpDir, `data-${archiveLatestMigration}-${rows[0].id}`);
  await fs.promises.mkdir(dataDir, { recursive: true });
  const write = (table, list) => fs.promises.writeFile(path.join(dataDir, `${table}.ndjson`),
    list.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await write('invoices', rows);
  const tables = history.length ? ['accounting_change_history', 'invoices'] : ['invoices'];
  if (history.length) await write('accounting_change_history', history);
  const { replaceAllTables } = require('../../src/services/picpeakImportService');
  await db.transaction((trx) => replaceAllTables(tables, dataDir, null, null, {
    executor: trx, allTables: tables, crossEngine: isPg, archiveLatestMigration,
  }));
  return Object.fromEntries((await db('invoices').orderBy('id').select('id', 'status', 'scheduled_send_at', 'send_held_at'))
    .map((r) => [r.id, r]));
}

const rows = () => [
  invoice(501, '2026-01-05T09:00'),
  invoice(502, Date.UTC(2099, 0, 5, 9)),
  invoice(503, '2026-01-05T09:00', 'sent'),
];

test('an archive before 356 comes back with a passed send date held and marked', async () => {
  const restored = await restore(rows(), '355_booking_deposits.js');
  expect(restored[501]).toMatchObject({ status: 'scheduled', scheduled_send_at: null });
  expect(restored[501].send_held_at).not.toBeNull();
  expect(new Date(restored[502].scheduled_send_at).toISOString()).toBe('2099-01-05T09:00:00.000Z');
  expect(restored[502].send_held_at).toBeNull();
  expect(restored[503].scheduled_send_at).not.toBeNull();
  expect(restored[503].send_held_at).toBeNull();
  const history = await db('accounting_change_history')
    .where({ entity_type: 'invoice', entity_id: 501, source: 'invoice.sendAt.holdStuck' }).first('actor_name');
  expect(history.actor_name).toBe('import');
});

// On PostgreSQL the archive's history rows take ids the target's sequence
// has not handed out yet, and the hold's history row comes from that
// sequence before the post-commit resync.
test('a hold restores when the archive history holds the next sequence ids', async () => {
  let next = 1;
  if (isPg) {
    const { rows: [seq] } = await db.raw(`SELECT COALESCE(pg_sequence_last_value(
      pg_get_serial_sequence('accounting_change_history', 'id')::regclass), 0) AS last`);
    next = Number(seq.last) + 1;
  }
  const history = [0, 1, 2].map((i) => ({
    id: next + i, document_type: 'invoice', document_id: 532, entity_type: 'invoice', entity_id: 532,
    action: 'updated', changes: JSON.stringify({ notes: { from: null, to: `n${i}` } }),
    actor_type: 'system', actor_id: null, actor_name: 'upgrade', source: null, created_at: '2026-01-01T00:00:00.000Z',
  }));
  const restored = await restore([invoice(531, '2026-01-05T09:00'), invoice(532, null)], '355_booking_deposits.js', history);
  expect(restored[531]).toMatchObject({ status: 'scheduled', scheduled_send_at: null });
  expect(restored[531].send_held_at).not.toBeNull();
  const hold = await db('accounting_change_history')
    .where({ entity_type: 'invoice', entity_id: 531, source: 'invoice.sendAt.holdStuck' }).first('id');
  expect(Number(hold.id)).toBeGreaterThan(next + 2);
});

test('an archive from 356 on restores its scheduled invoices as they were', async () => {
  const restored = await restore([invoice(511, '2026-01-05T09:00:00.000Z')], '357_backup_verifications.js');
  expect(new Date(restored[511].scheduled_send_at).toISOString()).toBe('2026-01-05T09:00:00.000Z');
  expect(restored[511].send_held_at).toBeNull();
});

test('an archive from 356 but before 358 marks the invoices its history shows held', async () => {
  const heldAt = '2026-11-01T08:00:00.000Z';
  const restored = await restore([invoice(521, null), invoice(522, null)], '357_backup_verifications.js', [{
    id: 9001, document_type: 'invoice', document_id: 521, entity_type: 'invoice', entity_id: 521, action: 'updated',
    changes: JSON.stringify({ scheduled_send_at: { from: '2026-01-05T09:00', to: null } }),
    actor_type: 'system', actor_id: null, actor_name: 'upgrade', source: 'invoice.sendAt.holdStuck', created_at: heldAt,
  }]);
  expect(new Date(restored[521].send_held_at).toISOString()).toBe(heldAt);
  expect(restored[522].send_held_at).toBeNull();
});
