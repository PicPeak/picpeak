'use strict';

// Request-time validation, table checksums and the operator's fence reset,
// against a real migrated database (bootCrmDb).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const { bootCrmDb } = require('./helpers/crmDb');

const EXT4 = { type: 0xef53n, bsize: 4096n, bavail: 1024n * 1024n * 1024n, ffree: 1024n * 1024n };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

describe('portable restore: validate before fencing, verify tables, operator reset', () => {
  let db, cleanup, tmpDir, latest;
  beforeAll(async () => {
    ({ db, cleanup, tmpDir } = await bootCrmDb());
    tmpDir = await fsp.realpath(tmpDir);
    // The schema-version check reads knex's ledger, which the migrated test
    // template does not carry.
    latest = '250_applied_here.js';
    await db.schema.createTable('knex_migrations', table => { table.increments('id'); table.string('name'); });
    await db('knex_migrations').insert({ name: latest });
  });
  afterAll(async () => { await cleanup(); });
  afterEach(() => { jest.restoreAllMocks(); });

  async function archive(manifest, entries = []) {
    const file = path.join(tmpDir, `${crypto.randomUUID()}.picpeak`);
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
      const zip = archiver('zip');
      zip.on('error', reject); output.on('error', reject); output.on('close', resolve);
      zip.pipe(output);
      zip.append(typeof manifest === 'string' ? manifest : JSON.stringify(manifest), { name: 'manifest.json' });
      for (const [name, content] of entries) zip.append(content, { name });
      zip.finalize();
    });
    return file;
  }
  const manifest = (overrides = {}) => ({ format: 1, kind: 'picpeak-backup', created_at: new Date().toISOString(),
    database: { engine: 'sqlite', latest_migration: latest }, tables: {}, ...overrides });

  describe('preflight inside the upload request', () => {
    const preflight = file => require('../../src/services/portableImportPreflight').preflightArchive(file, { db });
    beforeEach(() => { if (process.platform !== 'linux') jest.spyOn(fsp, 'statfs').mockResolvedValue(EXT4); });

    it('accepts a valid archive and reports its census, changing nothing', async () => {
      const row = `${JSON.stringify({ id: 1 })}\n`;
      const pdf = Buffer.from('%PDF-1.4 fixture');
      const before = await db('portable_restore_control').count({ count: '*' }).first();
      await expect(preflight(await archive(manifest({ tables: { events: { rowCount: 1, checksum: sha(row) } },
        files: [{ path: 'business-docs/invoice.pdf', size: pdf.length, checksum: sha(pdf) }] }),
      [['data/events.ndjson', row], ['files/business-docs/invoice.pdf', pdf]])))
        .resolves.toMatchObject({ entries: 3, tables: 1, largestBytes: expect.any(Number) });
      expect(await db('portable_restore_control').count({ count: '*' }).first()).toEqual(before);
    });

    it.each([
      ['a file that is not a PicPeak backup', () => manifest({ kind: 'something-else' }), /not a PicPeak backup/],
      ['a backup from a newer PicPeak', () => manifest({ format: 99 }), /newer version/],
      ['a backup from a newer schema', () => manifest({ database: { engine: 'sqlite', latest_migration: '999_future.js' } }), /newer database schema/],
      ['a PostgreSQL backup on a SQLite instance', () => manifest({ database: { engine: 'pg', latest_migration: latest } }), /engine mismatch/i],
      ['a catalogue entry without its file', () => manifest({ files: [{ path: 'business-docs/missing.pdf', size: 3, checksum: sha('abc') }] }), /does not match its contents/],
      ['a catalogue with an invalid checksum', () => manifest({ files: [{ path: 'business-docs/a.pdf', size: 3, checksum: 'nope' }] }), /size\/checksum/],
    ])('refuses %s with a specific error', async (_label, build, message) => {
      await expect(preflight(await archive(build()))).rejects.toMatchObject({ code: 'RESTORE_MANIFEST_INVALID', statusCode: 400, message: expect.stringMatching(message) });
    });

    it('refuses unreadable manifests, entries outside the layout and too little free space', async () => {
      await expect(preflight(await archive('{ not json'))).rejects.toMatchObject({ code: 'RESTORE_MANIFEST_INVALID', statusCode: 400 });
      await expect(preflight(await archive(manifest(), [['evil/shell.sh', 'x']]))).rejects.toMatchObject({ statusCode: 400, code: 'PORTABLE_ARCHIVE_REFUSED' });
      jest.spyOn(fsp, 'statfs').mockResolvedValue({ ...EXT4, bavail: 1n });
      await expect(preflight(await archive(manifest()))).rejects.toMatchObject({ code: 'RESTORE_CAPACITY_LIMIT', statusCode: 507, message: expect.stringMatching(/MiB free/) });
    });

    it('checks on PostgreSQL that the role may suspend foreign keys and replace every table', async () => {
      const { assertRestorePrivileges } = require('../../src/services/portableImportPreflight');
      const pg = (raw) => ({ client: { config: { client: 'pg' } }, transaction: async run => run({ raw }) });
      await expect(assertRestorePrivileges(pg(async sql => (/SET LOCAL/.test(sql) ? {} : { rows: [{ denied: 0 }] })))).resolves.toBeUndefined();
      await expect(assertRestorePrivileges(pg(async () => { throw Object.assign(new Error('permission denied to set parameter'), { code: '42501' }); })))
        .rejects.toMatchObject({ code: 'RESTORE_PRIVILEGE_MISSING', statusCode: 400, message: expect.stringMatching(/SUPERUSER/) });
      await expect(assertRestorePrivileges(pg(async sql => (/SET LOCAL/.test(sql) ? {} : { rows: [{ denied: 2 }] }))))
        .rejects.toMatchObject({ code: 'RESTORE_PRIVILEGE_MISSING', message: expect.stringMatching(/2 table/) });
      await expect(assertRestorePrivileges(db)).resolves.toBeUndefined();
    });
  });

  describe('table files are verified against the manifest', () => {
    it('compares each table checksum and row count before trusting a row', async () => {
      const { preflightRows } = require('../../src/services/portableImportMaintenance');
      const dataDir = path.join(tmpDir, `data-${crypto.randomUUID()}`);
      await fsp.mkdir(dataDir);
      const rows = `${JSON.stringify({ id: 990001 })}\n${JSON.stringify({ id: 990002 })}\n`;
      await fsp.writeFile(path.join(dataDir, 'events.ndjson'), rows);
      const recorded = { tables: { events: { rowCount: 2, checksum: sha(rows) }, photos: { rowCount: 0, checksum: sha('') } } };
      await expect(preflightRows(['events', 'photos'], dataDir, false, recorded)).resolves.toBeUndefined();
      await fsp.writeFile(path.join(dataDir, 'events.ndjson'), rows.replace('990002', '990003'));
      await expect(preflightRows(['events'], dataDir, false, recorded))
        .rejects.toMatchObject({ code: 'RESTORE_TABLE_CHECKSUM', statusCode: 400, message: expect.stringContaining('"events"') });
      // A truncated dump that happens to carry a matching checksum of its own.
      const truncated = `${JSON.stringify({ id: 990001 })}\n`;
      await fsp.writeFile(path.join(dataDir, 'events.ndjson'), truncated);
      await expect(preflightRows(['events'], dataDir, false, { tables: { events: { rowCount: 2, checksum: sha(truncated) } } }))
        .rejects.toMatchObject({ code: 'RESTORE_TABLE_CHECKSUM', message: expect.stringContaining('1 rows') });
      // A table the manifest says has rows, with no file at all.
      await expect(preflightRows(['photos'], dataDir, false, { tables: { photos: { rowCount: 3, checksum: sha('x') } } }))
        .rejects.toMatchObject({ code: 'RESTORE_TABLE_CHECKSUM' });
    });
  });

  describe('operator fence reset', () => {
    const reset = () => require('../../src/services/portableRestoreFenceReset');
    const paths = () => require('../../src/services/portableRestorePaths');
    const leases = state => ({ probe: async () => state });
    beforeEach(async () => {
      for (const table of ['portable_restore_commits', 'portable_restore_instances', 'portable_restore_control']) await db(table).delete();
      await fsp.mkdir(path.join(process.env.STORAGE_PATH, '.picpeak-maintenance'), { recursive: true, mode: 0o700 });
    });
    async function fenced(state = 'recovery_required') {
      const attempt = crypto.randomUUID();
      await db('portable_restore_control').insert({ id: 1, storage_id: crypto.randomUUID(), state, generation: 4, revision: 7,
        epoch: crypto.randomUUID(), attempt_id: attempt, owner_instance_id: crypto.randomUUID() });
      await db('portable_restore_instances').insert({ instance_id: crypto.randomUUID(), generation: 4, storage_id: crypto.randomUUID(),
        boot_id: crypto.randomUUID(), lease_json: JSON.stringify({ path: '/gone/runtime.lease', device: '1', inode: '2', filesystem: '3' }) });
      await paths().writeFence({ fenced: true, generation: 4 });
      return attempt;
    }

    it('reports an install without a fence and leaves an open instance alone', async () => {
      await expect(reset().clearFence({ db })).resolves.toEqual({ cleared: false, state: 'absent' });
      await db('portable_restore_control').insert({ id: 1, storage_id: crypto.randomUUID(), state: 'open' });
      await expect(reset().clearFence({ db })).resolves.toEqual({ cleared: false, state: 'open' });
    });

    it('refuses while a backend still holds the fence, unless forced', async () => {
      await fenced();
      await expect(reset().clearFence({ db, leases: leases('busy') })).rejects.toMatchObject({ code: 'RESTORE_FENCE_LIVE' });
      expect((await db('portable_restore_control').first()).state).toBe('recovery_required');
      await expect(reset().clearFence({ db, leases: leases('busy'), force: true })).resolves.toMatchObject({ cleared: true });
    });

    it('opens a stuck fence, drops every registration, bumps the generation and writes the audit entry', async () => {
      const attempt = await fenced();
      const activity = await db('activity_logs').count({ count: '*' }).first();
      await expect(reset().clearFence({ db, leases: leases('free'), actor: 'test-operator' }))
        .resolves.toEqual({ cleared: true, state: 'recovery_required', outcome: 'rolled_back', files: 'none' });
      const row = await db('portable_restore_control').first();
      expect(row).toMatchObject({ state: 'open', generation: 5, owner_instance_id: null, attempt_id: attempt });
      expect(JSON.parse(row.result_json)).toMatchObject({ outcome: 'rolled_back', clearedBy: 'test-operator', error: { code: 'RESTORE_FENCE_CLEARED' } });
      expect(await db('portable_restore_instances')).toHaveLength(0);
      expect(await paths().readFence()).toMatchObject({ fenced: false, generation: 5 });
      const logged = await db('activity_logs').where({ activity_type: 'portable_restore_fence_cleared' }).orderBy('id', 'desc').first();
      expect(Number((await db('activity_logs').count({ count: '*' }).first()).count)).toBe(Number(activity.count) + 1);
      expect(String(logged.metadata)).toContain(attempt);
    });

    it('rolls a half-promoted file set back when the restore had not committed, and keeps a committed one', async () => {
      if (process.platform !== 'linux') jest.spyOn(fsp, 'statfs').mockResolvedValue(EXT4);
      const { PortableRestoreJournal } = require('../../src/services/portableRestoreJournal');
      const { importFilePathProblem } = require('../../src/services/picpeakImportService');
      const storage = await fsp.realpath(process.env.STORAGE_PATH);
      const key = 'business-docs/contract.pdf';
      const live = path.join(storage, key);
      const staged = path.join(tmpDir, `staged-${crypto.randomUUID()}`);
      await fsp.mkdir(path.dirname(live), { recursive: true });
      await fsp.mkdir(path.join(staged, 'business-docs'), { recursive: true });
      for (const committed of [false, true]) {
        for (const table of ['portable_restore_commits', 'portable_restore_instances', 'portable_restore_control']) await db(table).delete();
        const attempt = await fenced('restoring');
        await fsp.writeFile(live, 'before the restore', { mode: 0o600 });
        await fsp.writeFile(path.join(staged, key), 'from the archive', { mode: 0o600 });
        const journal = await PortableRestoreJournal.create({ storageRoot: storage, id: attempt, validateKey: importFilePathProblem });
        await journal.prepare(staged, [key]);
        await journal.promote(staged);
        expect(await fsp.readFile(live, 'utf8')).toBe('from the archive');
        if (committed) await db('portable_restore_commits').insert({ attempt_id: attempt, local_plan_checksum: journal.state.planChecksum, options_digest: sha('{}') });
        await expect(reset().clearFence({ db, leases: leases('free') })).resolves.toMatchObject({
          cleared: true, outcome: committed ? 'committed' : 'rolled_back', files: committed ? 'none' : 'rolled_back' });
        expect(await fsp.readFile(live, 'utf8')).toBe(committed ? 'from the archive' : 'before the restore');
        expect((await db('portable_restore_control').first()).state).toBe('open');
      }
    });
  });

  it('keeps the restore workspace out of file backups and rsync runs', async () => {
    const backup = require('../../src/services/backupService');
    // The pinned connection resolves the host; this test is about the excludes.
    jest.spyOn(require('../../src/utils/rsyncConnection'), 'resolveRsyncConnection')
      .mockResolvedValue({ rsyncShell: 'ssh -p 22', rsyncTarget: 'backup.example.com' });
    const args = await backup.buildRsyncArgs({ backup_rsync_host: 'backup.example.com', backup_rsync_path: '/backups' }, [], process.env.STORAGE_PATH);
    expect(args[args.indexOf('.picpeak-maintenance') - 1]).toBe('--exclude');
  });
});
