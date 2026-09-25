/**
 * A .picpeak import normalises the email queue it brings back (issue 1670).
 *
 * The import batch-inserts archived rows as they were, text timestamps
 * included, and migration 256 will not run again on a target that already
 * recorded it. Without the hook, a queue archived on an older SQLite install
 * would come back in the shape the processor never picks up.
 */
const fs = require('fs');
const path = require('path');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');
const { STALE_MESSAGE } = require('../../src/utils/queueTimestamps');

let db; let cleanup; let tmpDir;
let createPicpeak; let importFromPicpeak;
let backupFile;

const HOUR = 3600 * 1000;
const sqliteText = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.env.STORAGE_PATH = tmpDir;
  const { adminId } = await seedMinimal(db);
  ({ createPicpeak } = require('../../src/services/picpeakExportService'));
  ({ importFromPicpeak } = require('../../src/services/picpeakImportService'));

  // The queue as an older install archived it: text schedules from the
  // column default, one fresh, one from last month, plus a newsletter row
  // already in milliseconds.
  const now = Date.now();
  await db('email_queue').del();
  for (const row of [
    { email_type: 'fresh_default', scheduled_at: sqliteText(now - 60e3), created_at: sqliteText(now - 60e3) },
    { email_type: 'stale_default', scheduled_at: sqliteText(now - 30 * 24 * HOUR), created_at: sqliteText(now - 30 * 24 * HOUR) },
    { email_type: 'ms_future', scheduled_at: now + HOUR, created_at: now },
  ]) {
    await db('email_queue').insert({ recipient_email: 'a@b.c', status: 'pending', retry_count: 0, ...row });
  }
  ({ filePath: backupFile } = await createPicpeak({ includePhotos: false }));
  // Wipe the queue and bring it back through the import.
  await db('email_queue').del();
  await importFromPicpeak({ picpeakPath: backupFile, currentAdminId: adminId });
}, 120000);

afterAll(async () => {
  if (backupFile) fs.rmSync(path.dirname(backupFile), { recursive: true, force: true });
  await cleanup();
});

test('the imported rows carry the shape the processor compares against', async () => {
  const rows = await db('email_queue')
    .select('email_type', 'status', 'error_message', 'scheduled_at',
      db.raw('typeof(scheduled_at) as scheduled_type'), db.raw('typeof(created_at) as created_type'))
    .orderBy('id');
  expect(rows.map((r) => r.email_type).sort()).toEqual(['fresh_default', 'ms_future', 'stale_default']);
  for (const row of rows) {
    expect(row.scheduled_type).toBe('integer');
    expect(row.created_type).toBe('integer');
  }
});

test('a fresh stuck row is pending and due; a stale one is parked with the reason', async () => {
  const byType = Object.fromEntries((await db('email_queue')).map((r) => [r.email_type, r]));
  expect(byType.fresh_default.status).toBe('pending');
  expect(byType.fresh_default.scheduled_at).toBeLessThan(Date.now());
  expect(byType.stale_default.status).toBe('failed');
  expect(byType.stale_default.error_message).toBe(STALE_MESSAGE);
  expect(byType.ms_future.status).toBe('pending');
  expect(byType.ms_future.scheduled_at).toBeGreaterThan(Date.now());
});
