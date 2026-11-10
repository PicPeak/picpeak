'use strict';

/**
 * The date repair is wired into the real load: replaceAllTables, on the
 * migrated schema of whichever engine the run uses (SQLite by default,
 * PostgreSQL with DATABASE_CLIENT=pg).
 *
 * On a pg target, a pg archive's shifted midnight (what the export wrote
 * before it wrote plain dates) restores as the source day, and on a SQLite
 * source only an epoch number is repaired: an instant an API client stored is
 * kept as the day SQLite showed. A SQLite target keeps every value as the
 * archive has it. Postgres casts in its session zone, not the jest worker's,
 * so this needs no child process; picpeakDateOnly.test.js covers the zones.
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
const { toDateOnly } = require('../../src/utils/dateOnly');

const BERLIN_MIDNIGHT = Date.UTC(2024, 7, 10, 22); // 2024-08-11 00:00 in Berlin
const NEW_YORK_MIDNIGHT = Date.UTC(2024, 7, 11, 4); // 2024-08-11 00:00 in New York

describe('portable import repairs date columns in replaceAllTables', () => {
  let db;
  let cleanup;
  let tmpDir;
  let isPg;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    isPg = db.client.config.client === 'pg';
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-date-import-'));
  }, 120000);

  afterAll(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    if (cleanup) await cleanup();
  });

  const event = (id, eventDate) => ({
    id, slug: `date-import-${id}`, event_type: 'wedding', event_name: `Date ${id}`, event_date: eventDate,
    host_email: 'host@example.com', admin_email: 'admin@example.com', password_hash: 'x',
    share_link: `/gallery/date-import-${id}/share`, share_token: `date-import-share-${id}`,
    expires_at: '2030-01-01T00:00:00.000Z', is_active: 1, is_archived: 0, is_draft: 0,
    created_at: '2024-08-01T10:00:00.000Z',
  });

  async function importEvents(rows, { crossEngine = false } = {}) {
    const dataDir = path.join(tmpDir, `data-${rows[0].id}`);
    await fs.promises.mkdir(dataDir, { recursive: true });
    await fs.promises.writeFile(path.join(dataDir, 'events.ndjson'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const { replaceAllTables } = require('../../src/services/picpeakImportService');
    await db.transaction((trx) => replaceAllTables(['events'], dataDir, null, null, { executor: trx, allTables: ['events'], crossEngine }));
    return (await db('events').orderBy('id').select('id', 'event_date')).map((r) => toDateOnly(r.event_date));
  }

  it('finds the date columns in one query on pg', async () => {
    if (!isPg) return;
    const { dateOnlyColumnsByTable } = require('../../src/services/picpeakImportService');
    const byTable = await db.transaction((trx) => dateOnlyColumnsByTable(trx));
    expect(byTable.get('events')).toContain('event_date');
    expect(byTable.get('events')).not.toContain('created_at');
  });

  it('restores a pg archive\'s shifted midnights as the source day', async () => {
    const stored = await importEvents([
      event(101, '2024-08-10T22:00:00.000Z'), // Berlin, before the fix
      event(102, '2024-08-11T04:00:00.000Z'), // New York, before the fix
      event(103, '2024-08-11'), // after the fix
    ]);
    expect(stored).toEqual(isPg
      ? ['2024-08-11', '2024-08-11', '2024-08-11']
      // A SQLite target is never a pg archive's same-engine target and
      // gets no repair: it keeps the archive's value, as before.
      : ['2024-08-10', '2024-08-11', '2024-08-11']);
  });

  it('on a SQLite source, repairs local-midnight epochs and keeps a client\'s instants as SQLite showed them', async () => {
    // A SQLite → SQLite restore is not cross-engine, and pg → SQLite is refused.
    if (!isPg) return;
    const stored = await importEvents([
      event(201, BERLIN_MIDNIGHT),
      event(202, NEW_YORK_MIDNIGHT),
      event(203, '2024-08-11T13:00:00.000Z'),
      event(204, '2024-08-10T22:00:00.000Z'),
      event(205, '2024-08-11'),
    ], { crossEngine: true });
    expect(stored).toEqual(['2024-08-11', '2024-08-11', '2024-08-11', '2024-08-10', '2024-08-11']);
  });
});
