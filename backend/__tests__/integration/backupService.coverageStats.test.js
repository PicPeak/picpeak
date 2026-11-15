/**
 * The Backup → Dashboard "Backup coverage" card reads database_backed_up,
 * photos_backed_up, total_photos and archives_backed_up from the last
 * successful run's statistics. Nothing wrote them, so every install showed
 * "Database: Excluded, Photos: 0 of 0, Archives: 0 files". These pin what a
 * run records for local and rsync destinations, with and without the
 * database.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { bootCrmDb } = require('./helpers/crmDb');

jest.setTimeout(120000);

describe('backupService — backup coverage statistics', () => {
  let db;
  let cleanup;
  let storagePath;
  let backupService;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    storagePath = process.env.STORAGE_PATH;
    backupService = require('../../src/services/backupService');
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  function mkFile(rel, content = 'x'.repeat(100)) {
    const abs = path.join(storagePath, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  async function setting(key, value) {
    await db('app_settings').insert({ setting_key: key, setting_value: JSON.stringify(value), setting_type: 'backup' })
      .onConflict('setting_key').merge();
  }

  async function event(slug, fields = {}) {
    const [row] = await db('events').insert({ slug, event_name: slug, event_type: 'wedding',
      event_date: '2026-10-07', host_email: 'host@example.com', admin_email: 'admin@example.com',
      password_hash: 'fixture', share_link: `${slug}-share`, expires_at: '2027-10-07', ...fields }).returning('id');
    return row?.id || row;
  }

  async function statsOfLastRun() {
    const run = await db('backup_runs').orderBy('id', 'desc').first();
    expect(run.status).toBe('completed');
    return typeof run.statistics === 'string' ? JSON.parse(run.statistics) : run.statistics;
  }

  beforeEach(async () => {
    await db('backup_runs').del();
    await db('backup_file_states').del();
    await db('database_backup_runs').del();
    await db('photos').del();
    await db('events').del();
    await db('app_settings').where('setting_type', 'backup').del();
    for (const [key, value] of Object.entries({
      backup_destination_type: 'local',
      backup_destination_path: path.join(storagePath, 'destination'),
      backup_enabled: true,
      backup_email_on_failure: false,
      backup_include_archived: true,
      // No pg_dump in tests: a seeded dump row satisfies the guard.
      backup_database_inline_dump: false,
      backup_rsync_host: 'backup.example.com',
      backup_rsync_path: '/backups',
    })) await setting(key, value);
    fs.mkdirSync(path.join(storagePath, 'destination'), { recursive: true });

    const { DEFAULT_PATHS } = require('../../migrations/core/109_add_backup_paths');
    await db('backup_paths').del();
    await db('backup_paths').insert(DEFAULT_PATHS.map((row) => ({
      ...row, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    })));

    for (const dir of ['events', 'business-docs', 'thumbnails', 'previews', 'heroes', 'uploads']) {
      fs.rmSync(path.join(storagePath, dir), { recursive: true, force: true });
    }

    const fakeDump = path.join(storagePath, 'destination', 'fake.sql.gz');
    fs.writeFileSync(fakeDump, 'pretend dump');
    await db('database_backup_runs').insert({
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      status: 'completed',
      backup_type: 'pg',
      file_path: fakeDump,
      checksum: crypto.createHash('sha256').update(fs.readFileSync(fakeDump)).digest('hex'),
      file_size_bytes: fs.statSync(fakeDump).size,
      destination_path: fakeDump,
    });

    // Gallery A: two photos on disk, one row whose file is gone, one trashed.
    const active = await event('wedding');
    mkFile('events/active/wedding/a.jpg');
    mkFile('events/active/wedding/b.jpg');
    mkFile('events/active/wedding/trashed.jpg');
    await db('photos').insert([
      { event_id: active, filename: 'a.jpg', path: 'wedding/a.jpg', type: 'individual' },
      { event_id: active, filename: 'b.jpg', path: 'wedding/b.jpg', type: 'individual' },
      { event_id: active, filename: 'missing.jpg', path: 'wedding/missing.jpg', type: 'individual' },
      { event_id: active, filename: 'trashed.jpg', path: 'wedding/trashed.jpg', type: 'individual',
        deleted_at: new Date().toISOString() },
    ]);
    // Archived gallery: its photos live in the zip, not as originals.
    const archived = await event('old', { is_archived: 1, archive_path: 'events/archived/old.zip' });
    mkFile('events/archived/old.zip');
    await db('photos').insert({ event_id: archived, filename: 'gone.jpg', path: 'old/gone.jpg', type: 'individual' });
    // External gallery: the original is not PicPeak's to back up.
    const external = await event('ext', { source_mode: 'reference' });
    await db('photos').insert({ event_id: external, filename: 'ext.jpg', path: 'ext/ext.jpg',
      type: 'individual', source_origin: 'external', external_relpath: 'library/ext.jpg' });
  });

  it('local: records the database, photos in the restore point and archive files', async () => {
    await backupService.runBackup(true);
    const stats = await statsOfLastRun();

    expect(stats.database_backed_up).toBe(true);
    expect(stats.photos_backed_up).toBe(2);
    expect(stats.total_photos).toBe(3);
    expect(stats.archives_backed_up).toBe(1);
    // Existing keys stay.
    expect(stats.files_processed).toBeGreaterThan(0);
    expect(stats.per_path['events/active'].count).toBe(3);
  });

  it('local: records database_backed_up false when the database is left out', async () => {
    await setting('backup_include_database', false);
    await backupService.runBackup(true);
    const stats = await statsOfLastRun();

    expect(stats.database_backed_up).toBe(false);
    expect(stats.photos_backed_up).toBe(2);
  });

  it('local: an exclude pattern does not drop the dump, and leaves matching photos out', async () => {
    await setting('backup_exclude_patterns', ['*.gz', 'a.jpg']);
    await backupService.runBackup(true);
    const stats = await statsOfLastRun();

    expect(stats.database_backed_up).toBe(true);
    expect(stats.photos_backed_up).toBe(1);
  });

  it('local: photos left out of the selection count as not backed up', async () => {
    await setting('backup_include_photos', false);
    await setting('backup_include_archived', false);
    await backupService.runBackup(true);
    const stats = await statsOfLastRun();

    expect(stats.photos_backed_up).toBe(0);
    expect(stats.total_photos).toBe(3);
    expect(stats.archives_backed_up).toBe(0);
  });

  describe('rsync', () => {
    let spawn;
    let network;

    beforeEach(async () => {
      await setting('backup_destination_type', 'rsync');
      network = jest.spyOn(require('../../src/utils/rsyncConnection'), 'resolveRsyncConnection')
        .mockResolvedValue({ rsyncShell: 'ssh', rsyncTarget: 'backup.example.com' });
      // An incremental sync: only one file changed since the last run.
      spawn = jest.spyOn(require('../../src/utils/safeExec'), 'spawnAsync')
        .mockResolvedValue({ stdout: 'Number of files transferred: 1\nTotal file size: 400 bytes' });
    });

    afterEach(() => {
      spawn.mockRestore();
      network.mockRestore();
    });

    it('counts what the mirror holds, not what this run transferred', async () => {
      await backupService.runBackup(true);
      const stats = await statsOfLastRun();

      // The mirror, then the manifest upload.
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(stats.files_processed).toBe(1);
      expect(stats.database_backed_up).toBe(true);
      expect(stats.photos_backed_up).toBe(2);
      expect(stats.total_photos).toBe(3);
      expect(stats.archives_backed_up).toBe(1);
    });

    it('records the database as included although an exclude pattern matches the dump', async () => {
      await setting('backup_exclude_patterns', ['*.gz']);
      await backupService.runBackup(true);
      const stats = await statsOfLastRun();

      // The dump is included ahead of the excludes, so it reaches the mirror.
      const args = spawn.mock.calls[0][1];
      expect(args.indexOf('/database/')).toBeGreaterThan(-1);
      expect(args.indexOf('/database/')).toBeLessThan(args.indexOf('*.gz'));
      expect(stats.database_backed_up).toBe(true);
      expect(stats.photos_backed_up).toBe(2);
      expect(stats.archives_backed_up).toBe(1);
    });

    it('counts photos an exclude pattern keeps out of the mirror as not backed up', async () => {
      await setting('backup_exclude_patterns', ['*.jpg', '*.zip']);
      await backupService.runBackup(true);
      const stats = await statsOfLastRun();

      expect(stats.database_backed_up).toBe(true);
      expect(stats.photos_backed_up).toBe(0);
      expect(stats.total_photos).toBe(3);
      expect(stats.archives_backed_up).toBe(0);
    });

    it('surfaces the new keys through getBackupStatus', async () => {
      await backupService.runBackup(true);
      const status = await backupService.getBackupStatus();
      const run = status.lastSuccessfulBackup;
      expect(run.statistics).toEqual(expect.objectContaining({
        database_backed_up: true, photos_backed_up: 2, total_photos: 3, archives_backed_up: 1,
      }));
    });
  });
});
