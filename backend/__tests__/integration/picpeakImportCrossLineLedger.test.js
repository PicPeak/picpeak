'use strict';

/**
 * A .picpeak carries the runner's ledger (`migrations`), and the import writes
 * it verbatim. stable backports main's migrations under its own numbers with
 * the same name after the number, so an archive from the other release line
 * puts foreign filenames into this ledger (issue 2480):
 * - a name this code ships stays;
 * - a twin (same name after the number as a file this code ships) is dropped,
 *   so this code's own counterpart runs on the next start;
 * - any other name is refused before anything is deleted.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');

// The supervised restore worker is not what this pins; the ledger handling is.
jest.mock('../../src/services/portableRestoreWorker', () => ({
  ...jest.requireActual('../../src/services/portableRestoreWorker'),
  assertWorkerAuthority: jest.fn(async () => ({})),
}));

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');
const { classifyLedger, shippedMigrationNames, latestMigration } = require('../../src/utils/schemaLevel');

const EXT4 = { type: 0xef53n, bsize: 4096n, bavail: 1024n * 1024n * 1024n, ffree: 1024n * 1024n };
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

// main's numbers for two of this line's migrations (main 256 = stable 236,
// main 366 = stable 254), and a main-only migration in stable's number range:
// the hazard of issue 2480 (a main archive at ledger level 236-247 passes the
// numeric check here, and the promote would then skip main's 236).
const MAIN_TWINS = {
  '256_email_queue_scheduled_at_sqlite.js': '236_email_queue_scheduled_at_sqlite.js',
  '366_fix_translated_email_template_placeholders.js': '254_fix_translated_email_template_placeholders.js',
};
const FOREIGN = '236_customer_documents_purge_claimed_at.js';

describe('cross-line migration ledger on a portable restore (issue 2480)', () => {
  let db;
  let cleanup;
  let tmpDir;
  let shipped;
  let run = 0;

  beforeAll(async () => {
    ({ db, cleanup, tmpDir } = await bootCrmDb());
    tmpDir = await fsp.realpath(tmpDir);
    await seedMinimal(db);
    shipped = Array.from(await db('migrations').orderBy('id').select('filename'), (r) => r.filename);
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    // Every test starts from this code's own, complete ledger.
    await db('migrations').del();
    await db('migrations').insert(shipped.map((filename) => ({ filename })));
  });

  describe('classifyLedger', () => {
    it('stores names as the runner does: the bare basename with .js', () => {
      const names = shippedMigrationNames();
      expect(names.has('001_init.js')).toBe(true);
      expect(names.has('254_fix_translated_email_template_placeholders.js')).toBe(true);
      // legacy/ files are shipped too (existing deployments record them).
      expect(names.has('008_add_language_support_to_email_templates.js')).toBe(true);
      for (const name of shipped) expect(names.has(name)).toBe(true);
    });

    it('keeps the names this code ships', () => {
      expect(classifyLedger(shipped)).toEqual({ keep: shipped, twins: [], unknown: [] });
    });

    it('drops the twins of the other line and refuses names without a counterpart', () => {
      const result = classifyLedger(['001_init.js', ...Object.keys(MAIN_TWINS), FOREIGN, '900_newer.js', 'init.js']);
      expect(result.keep).toEqual(['001_init.js', 'init.js']);
      expect(result.twins).toEqual(Object.keys(MAIN_TWINS));
      expect(result.unknown).toEqual([FOREIGN, '900_newer.js']);
    });

    it('only matches the whole name after the number', () => {
      const own = new Set(['010_add_thing.js']);
      expect(classifyLedger(['011_add_thing.js', '011_add_thing_more.js', 'add_thing.js'], own))
        .toEqual({ keep: [], twins: ['011_add_thing.js'], unknown: ['add_thing.js', '011_add_thing_more.js'] });
    });
  });

  const event = (id) => ({
    id, slug: `ledger-${id}`, event_type: 'wedding', event_name: `Ledger ${id}`, event_date: '2026-08-01',
    host_email: 'host@example.com', admin_email: 'admin@example.com', password_hash: 'x',
    share_link: `/gallery/ledger-${id}/share`, share_token: `ledger-${id}-share`,
    expires_at: new Date(Date.now() + 86400000).toISOString(), is_active: 1, is_archived: 0, is_draft: 0,
    created_at: new Date().toISOString(),
  });

  async function replace(data) {
    run += 1;
    const dataDir = path.join(tmpDir, `ledger-data-${run}`);
    await fsp.mkdir(dataDir, { recursive: true });
    for (const [table, rows] of Object.entries(data)) {
      await fsp.writeFile(path.join(dataDir, `${table}.ndjson`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
    const { replaceAllTables } = require('../../src/services/picpeakImportService');
    await db.transaction((trx) => replaceAllTables(Object.keys(data).sort(), dataDir, null, null,
      { executor: trx, allTables: ['events', 'migrations'] }));
  }

  // This code's ledger as main would have it: this line's twins under main's
  // numbers (the shape of a main archive restored on stable).
  const mainShapedLedger = () => {
    const ownNames = new Set(Object.values(MAIN_TWINS));
    return [...shipped.filter((name) => !ownNames.has(name)), ...Object.keys(MAIN_TWINS)]
      .map((filename, i) => ({ id: i + 1, filename, applied_at: new Date().toISOString() }));
  };

  describe('replace step', () => {
    it('keeps a same-line ledger as it is', async () => {
      await replace({ events: [event(1)], migrations: shipped.map((filename, i) => ({ id: i + 1, filename })) });
      expect(Array.from(await db('migrations').orderBy('id').pluck('filename'))).toEqual(shipped);
    });

    it('drops the twins of a main-shaped ledger, so the runner runs this line\'s counterparts', async () => {
      await replace({ events: [event(2)], migrations: mainShapedLedger() });
      const ledger = new Set(await db('migrations').pluck('filename'));
      for (const [mainName, ownName] of Object.entries(MAIN_TWINS)) {
        expect(ledger.has(mainName)).toBe(false);
        expect(ledger.has(ownName)).toBe(false);
      }
      // Exactly what the runner and reconcileRestart see as not applied yet.
      const { pendingCoreMigrations } = require('../../src/services/portableRestoreCoordinator');
      expect((await pendingCoreMigrations(db)).sort()).toEqual(Object.values(MAIN_TWINS).sort());
      expect(Array.from(await db('events').pluck('id'))).toEqual([2]);
    });

    it('refuses an unknown name and rolls the whole replace back', async () => {
      await db('events').del();
      await db('events').insert(event(3));
      const ledger = [...mainShapedLedger(), { id: 9999, filename: FOREIGN }];
      await expect(replace({ events: [event(4)], migrations: ledger }))
        .rejects.toMatchObject({ code: 'RESTORE_LEDGER_UNKNOWN_MIGRATIONS', message: expect.stringContaining(FOREIGN) });
      expect(Array.from(await db('events').pluck('id'))).toEqual([3]);
      expect(Array.from(await db('migrations').orderBy('id').pluck('filename'))).toEqual(shipped);
    });
  });

  describe('preflight, before anything is touched', () => {
    async function archive(ledgerRows) {
      const file = path.join(tmpDir, `${crypto.randomUUID()}.picpeak`);
      const rows = ledgerRows.map((r) => JSON.stringify(r)).join('\n') + '\n';
      const manifest = { format: 1, kind: 'picpeak-backup', created_at: new Date().toISOString(),
        database: { engine: 'sqlite', latest_migration: await latestMigration(db) },
        tables: { migrations: { rowCount: ledgerRows.length, checksum: sha(rows) } } };
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
        const zip = archiver('zip');
        zip.on('error', reject); output.on('error', reject); output.on('close', resolve);
        zip.pipe(output);
        zip.append(JSON.stringify(manifest), { name: 'manifest.json' });
        zip.append(rows, { name: 'data/migrations.ndjson' });
        zip.finalize();
      });
      return file;
    }
    const preflight = (file) => require('../../src/services/portableImportPreflight').preflightArchive(file, { db });
    beforeEach(() => { if (process.platform !== 'linux') jest.spyOn(fsp, 'statfs').mockResolvedValue(EXT4); });

    it('accepts a same-line and a main-shaped ledger', async () => {
      await expect(preflight(await archive(shipped.map((filename, i) => ({ id: i + 1, filename }))))).resolves.toMatchObject({ tables: 1 });
      await expect(preflight(await archive(mainShapedLedger()))).resolves.toMatchObject({ tables: 1 });
    });

    it('refuses a ledger with a migration this code does not ship, naming the first one', async () => {
      await db('events').del();
      await db('events').insert(event(5));
      const before = await db('portable_restore_control').count({ count: '*' }).first();
      const ledger = [...mainShapedLedger(), { id: 9998, filename: '900_newer_line.js' }, { id: 9999, filename: FOREIGN }];
      await expect(preflight(await archive(ledger))).rejects.toMatchObject({
        code: 'RESTORE_LEDGER_UNKNOWN_MIGRATIONS',
        statusCode: 400,
        message: expect.stringContaining(`includes ${FOREIGN}`),
      });
      expect(Array.from(await db('events').pluck('id'))).toEqual([5]);
      expect(await db('portable_restore_control').count({ count: '*' }).first()).toEqual(before);
    });

    it('refuses a ledger that is not NDJSON', async () => {
      const file = path.join(tmpDir, `${crypto.randomUUID()}.picpeak`);
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
        const zip = archiver('zip');
        zip.on('error', reject); output.on('error', reject); output.on('close', resolve);
        zip.pipe(output);
        zip.append(JSON.stringify({ format: 1, kind: 'picpeak-backup', database: { engine: 'sqlite' }, tables: {} }), { name: 'manifest.json' });
        zip.append('{ not json', { name: 'data/migrations.ndjson' });
        zip.finalize();
      });
      await expect(preflight(file)).rejects.toMatchObject({ code: 'PORTABLE_ARCHIVE_REFUSED', statusCode: 400 });
    });
  });
});
