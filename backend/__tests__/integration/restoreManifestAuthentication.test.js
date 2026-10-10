const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const { bootCrmDb } = require('./helpers/crmDb');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const base = file => ({
  manifest: { version: '3.0' }, backup: { id: 'fixture', type: 'full', timestamp: new Date().toISOString() },
  system: {}, application: { version: require('../../package.json').version },
  files: { count: 1, total_size: file.size, manifest: [file] },
  database: { type: 'sqlite' }, verification: {},
});

describe('authenticated standard restore boundary', () => {
  let db; let cleanup; let root; let backupManifest; let RestoreService; let internal;
  const saved = { ...process.env };
  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    backupManifest = require('../../src/services/backupManifest');
    ({ RestoreService, _internal: internal } = require('../../src/services/restoreService'));
    root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'picpeak-auth-restore-'));
    fs.mkdirSync(path.join(root, 'events'));
    fs.writeFileSync(path.join(root, 'events/a.jpg'), 'original bytes');
  }, 120000);
  afterAll(async () => {
    process.env = { ...saved };
    if (cleanup) await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  });
  afterEach(() => {
    delete process.env.BACKUP_MANIFEST_RECOVERY_SHA256;
    delete process.env.BACKUP_MANIFEST_RECOVERY_REASON;
    jest.restoreAllMocks();
  });
  const file = () => ({ path: 'events/a.jpg', size: 14, checksum: sha('original bytes'), permissions: 0o640 });
  const writeManifest = (manifest, name = 'manifest.json') => {
    const target = path.join(root, name);
    fs.writeFileSync(target, name.endsWith('.yaml') ? yaml.dump(manifest) : JSON.stringify(manifest));
    return target;
  };

  it.each(['manifest.json', 'manifest.yaml'])('loads legitimate signed %s and retains a dry-run authenticity outcome', async name => {
    const manifest = backupManifest.signManifest(base(file()));
    const service = new RestoreService();
    const result = await service.restore({ source: root, manifestPath: writeManifest(manifest, name), restoreType: 'files', dryRun: true, force: true });
    expect(result.success).toBe(true);
    const row = await db('restore_runs').orderBy('id', 'desc').first();
    expect(JSON.parse(row.statistics).authentication).toMatchObject({ authenticated: true, recovery: false });
  });

  it('rejects forged manifests before force, safety backup and actual restore', async () => {
    const manifest = backupManifest.signManifest(base(file()));
    manifest.files.manifest[0].checksum = sha('replaced bytes');
    const service = new RestoreService();
    const safety = jest.spyOn(service, 'createPreRestoreBackup');
    const sink = jest.spyOn(service, 'performFilesRestore');
    await expect(service.restore({ source: root, manifestPath: writeManifest(manifest), restoreType: 'files', force: true }))
      .rejects.toThrow(/checksum verification failed/);
    expect(safety).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
  });

  it('refuses a signed but missing consumed digest before any restore operation', async () => {
    const manifest = backupManifest.signManifest(base(file()));
    delete manifest.files.manifest[0].checksum;
    manifest.verification.total_checksum = backupManifest.calculateManifestChecksum(manifest);
    const service = new RestoreService();
    const sink = jest.spyOn(service, 'performFilesRestore');
    await expect(service.restore({ source: root, manifestPath: writeManifest(manifest), restoreType: 'files', force: true, skipPreBackup: true }))
      .rejects.toThrow(/valid SHA-256/);
    expect(sink).not.toHaveBeenCalled();
  });

  it('selective restore ignores caller-supplied replacement digests and permissions', async () => {
    const entry = file();
    const manifest = backupManifest.signManifest(base(entry));
    const selected = { type: 'file', path: entry.path, checksum: sha('attacker bytes'), size: 1, permissions: 0o777 };
    expect(internal.resolveRestoreFiles(manifest, { restoreType: 'selective', selectedItems: [selected] })).toEqual([entry]);
    const service = new RestoreService();
    const result = await service.performFilesRestore(root, manifest, { restoreType: 'selective', selectedItems: [selected] });
    expect(result.filesRestored).toBe(1);
    const restored = path.join(process.env.STORAGE_PATH, entry.path);
    expect(fs.readFileSync(restored, 'utf8')).toBe('original bytes');
    expect(fs.statSync(restored).mode & 0o777).toBe(0o640);
  });

  it('selective restore never lets a replacement request digest authorize changed backup bytes', async () => {
    const manifest = backupManifest.signManifest(base(file()));
    fs.writeFileSync(path.join(root, 'events/a.jpg'), 'attacker bytes');
    try {
      const service = new RestoreService();
      await expect(service.performFilesRestore(root, manifest, { restoreType: 'selective', selectedItems: [
        { type: 'file', path: 'events/a.jpg', checksum: sha('attacker bytes') },
      ] })).rejects.toThrow(/Checksum verification failed/);
    } finally { fs.writeFileSync(path.join(root, 'events/a.jpg'), 'original bytes'); }
  });

it.each([false, true])('changed signed file bytes never reach a live target (existing=%s)', async existing => {
    const entry = { ...file(), path: 'events/tampered-target.jpg' };
    const source = path.join(root, entry.path);
    const target = path.join(process.env.STORAGE_PATH, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(source, 'replacement malicious bytes');
    fs.rmSync(target, { force: true });
    if (existing) fs.writeFileSync(target, 'untouched live bytes');
    const manifest = backupManifest.signManifest(base(entry));
    const service = new RestoreService();
    await expect(service.performFilesRestore(root, manifest, { restoreType: 'files' })).rejects.toThrow(/Checksum verification failed/);
    if (existing) expect(fs.readFileSync(target, 'utf8')).toBe('untouched live bytes');
    else expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(target + '.restore-backup')).toBe(false);
  });

it('the public selective workflow verifies manifest metadata and records successful authentication', async () => {
    const entry = { ...file(), path: 'events/public-selective.jpg' };
    fs.writeFileSync(path.join(root, entry.path), 'original bytes');
    const manifest = backupManifest.signManifest(base(entry));
    const result = await new RestoreService().restore({
      source: root, manifestPath: writeManifest(manifest), restoreType: 'selective',
      selectedItems: [{ type: 'file', path: entry.path, checksum: sha('forged request bytes'), permissions: 0o777 }],
      skipPreBackup: true, force: true,
    });
    expect(result.success).toBe(true);
    expect(result.verification.checksums[entry.path]).toMatchObject({ expected: entry.checksum, match: true });
    const row = await db('restore_runs').orderBy('id', 'desc').first();
    expect(JSON.parse(row.statistics).authentication).toMatchObject({ authenticated: true, recovery: false });
  });

  it('publishes captured authenticated file bytes even if the store changes after staging', async () => {
    const entry = { ...file(), path: 'events/mutable-source.jpg' };
    const source = path.join(root, entry.path);
    fs.writeFileSync(source, 'original bytes');
    const service = new RestoreService();
    const calculate = service.calculateChecksum.bind(service);
    jest.spyOn(service, 'calculateChecksum').mockImplementation(async target => {
      const checksum = await calculate(target);
      expect(target).not.toBe(source);
      expect(fs.statSync(path.dirname(target)).mode & 0o777).toBe(0o700);
      fs.writeFileSync(source, 'replacement malicious bytes');
      return checksum;
    });
    await service.performFilesRestore(root, backupManifest.signManifest(base(entry)), { restoreType: 'files' });
    expect(fs.readFileSync(path.join(process.env.STORAGE_PATH, entry.path), 'utf8')).toBe('original bytes');
  });

  it('successful host-approved legacy recovery retains the unauthenticated reason in history', async () => {
    const entry = { ...file(), path: 'events/legacy-success.jpg' };
    delete entry.checksum;
    fs.writeFileSync(path.join(root, entry.path), 'original bytes');
    const manifest = base(entry);
    manifest.manifest.version = '2.0';
    manifest.verification.checksum_algorithm = 'sha256';
    manifest.verification.total_checksum = backupManifest.calculateManifestChecksum(manifest, { keyed: false });
    process.env.BACKUP_MANIFEST_RECOVERY_SHA256 = require('../../src/utils/manifestCanonical').recoveryDigest(manifest);
    process.env.BACKUP_MANIFEST_RECOVERY_REASON = 'Offline inspected isolated one-artifact legacy fixture recovery';
    const result = await new RestoreService().restore({
      source: root, manifestPath: writeManifest(manifest), restoreType: 'files', skipPreBackup: true, force: true,
    });
    expect(result.success).toBe(true);
    const statistics = JSON.parse((await db('restore_runs').orderBy('id', 'desc').first()).statistics);
    expect(statistics.authentication).toMatchObject({ authenticated: false, recovery: true, reason: process.env.BACKUP_MANIFEST_RECOVERY_REASON });
    expect(statistics.log.some(entry => entry.message === 'Backup manifest authentication outcome')).toBe(true);
  });

  it('database replay preserves an older colliding history row and appends the authenticated outcome', async () => {
    const manifest = backupManifest.signManifest(base(file()));
    manifest.database.checksum = sha('stubbed verified dump');
    backupManifest.signManifest(manifest);
    const service = new RestoreService();
    let oldId;
    const replay = jest.spyOn(service, 'performDatabaseRestore').mockImplementation(async () => {
      const running = await db('restore_runs').orderBy('id', 'desc').first();
      oldId = running.id;
      await db('restore_runs').where('id', oldId).del();
      await db('restore_runs').insert({
        ...running, started_at: '2024-01-01T00:00:00.000Z', status: 'completed',
        statistics: JSON.stringify({ olderHistory: true }),
      });
      expect((await db('restore_runs').where('id', oldId).first()).started_at).toBe('2024-01-01T00:00:00.000Z');
      return { databaseRestored: true };
    });
    await service.restore({
      source: root, manifestPath: writeManifest(manifest), restoreType: 'database', skipPreBackup: true, force: true,
    });
    expect(replay).toHaveBeenCalled();
    expect(JSON.parse((await db('restore_runs').where('id', oldId).first()).statistics)).toEqual({ olderHistory: true });
    const newest = await db('restore_runs').orderBy('id', 'desc').first();
    expect(newest.id).not.toBe(oldId);
    expect(JSON.parse(newest.statistics).authentication).toMatchObject({ authenticated: true, recovery: false });
  });

  it('refuses selections absent from the authenticated manifest', () => {
    expect(() => internal.resolveRestoreFiles(base(file()), { restoreType: 'selective', selectedItems: [
      { type: 'file', path: 'events/not-signed.jpg', checksum: sha('x') },
    ] })).toThrow(/not present/);
  });

  it('captures verified dump bytes privately so store mutation cannot change replay input', async () => {
    const source = path.join(root, 'original.sql.gz');
    fs.writeFileSync(source, 'original dump bytes');
    const stage = await internal.stageDatabaseDump(source, sha('original dump bytes'), root);
    try {
      expect(stage.dump).not.toBe(source);
      expect(fs.statSync(path.dirname(stage.dump)).mode & 0o777).toBe(0o700);
      fs.writeFileSync(source, 'replacement malicious dump');
      expect(fs.readFileSync(stage.dump, 'utf8')).toBe('original dump bytes');
    } finally { await stage.cleanup(); }
    expect(fs.existsSync(stage.dump)).toBe(false);
  });

  // restore_max_file_size_mb caps one media object; a database dump larger
  // than it restored before the dump was staged, and must still.
  it('does not apply the per-file media cap to the database dump', async () => {
    const where = { setting_key: 'restore_max_file_size_mb', setting_type: 'restore' };
    const before = await db('app_settings').where(where).first();
    if (before) await db('app_settings').where(where).update({ setting_value: '0.000001' });
    else await db('app_settings').insert({ ...where, setting_value: '0.000001' });
    try {
      expect(await internal.getRestoreMaxFileBytes()).toBe(1);
      const source = path.join(root, 'large.sql.gz');
      fs.writeFileSync(source, 'a dump far above one byte');
      const stage = await internal.stageDatabaseDump(source, sha('a dump far above one byte'), root);
      expect(fs.readFileSync(stage.dump, 'utf8')).toBe('a dump far above one byte');
      await stage.cleanup();
    } finally {
      if (before) await db('app_settings').where(where).update({ setting_value: before.setting_value });
      else await db('app_settings').where(where).del();
    }
  });

  it('shows a pre-authentication manifest to inspection and health as legacy, and names the override when restore refuses it', async () => {
    const backupService = require('../../src/services/backupService');
    // The fixture carries only what authentication reads, not the report's fields.
    jest.spyOn(backupManifest, 'generateSummaryReport').mockReturnValue('summary');
    const manifest = base(file());
    manifest.manifest.version = '2.0';
    manifest.verification.checksum_algorithm = 'sha256';
    manifest.verification.total_checksum = backupManifest.calculateManifestChecksum(manifest, { keyed: false });
    const target = writeManifest(manifest, 'legacy-manifest.json');
    const inserted = await db('backup_runs').insert({
      started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
      status: 'completed', backup_type: 'manual', manifest_path: target,
    }).returning('id');
    const runId = inserted[0]?.id || inserted[0];
    try {
      const shown = await backupService.getBackupManifest(runId);
      expect(shown.authenticated).toBe(false);
      expect(shown.manifest.files.manifest[0].path).toBe('events/a.jpg');
      expect(await backupService.validateBackupManifest(target)).toMatchObject({
        valid: false, authentication: { authenticated: false, state: 'legacy' },
      });
      const service = new RestoreService();
      const sink = jest.spyOn(service, 'performFilesRestore');
      await expect(service.restore({ source: root, manifestPath: target, restoreType: 'files', force: true }))
        .rejects.toThrow(/BACKUP_MANIFEST_RECOVERY_SHA256/);
      expect(sink).not.toHaveBeenCalled();
      // A signed manifest is shown as authenticated through the same call.
      await db('backup_runs').where('id', runId).update({ manifest_path: writeManifest(backupManifest.signManifest(base(file())), 'signed-manifest.json') });
      expect((await backupService.getBackupManifest(runId)).authenticated).toBe(true);
    } finally {
      await db('backup_runs').where('id', runId).del();
    }
  });

  it('writes both restore run timestamps as ISO text', async () => {
    const manifest = backupManifest.signManifest(base(file()));
    await new RestoreService().restore({ source: root, manifestPath: writeManifest(manifest), restoreType: 'files', dryRun: true, force: true });
    const row = await db('restore_runs').orderBy('id', 'desc').first();
    for (const column of ['started_at', 'completed_at']) {
      expect(row[column]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    }
  });

  it('cleans up a captured dump with a bad checksum before decompression/replay', async () => {
    const source = path.join(root, 'bad.sql.gz');
    fs.writeFileSync(source, 'wrong dump');
    await expect(internal.stageDatabaseDump(source, sha('expected dump'), root)).rejects.toThrow(/does not match/);
    expect(fs.readdirSync(root).filter(name => name.startsWith('verified-dump-'))).toEqual([]);
  });

  it('audits the explicitly approved unauthenticated outcome without claiming health/inspection authenticity', async () => {
    const manifest = base(file());
    manifest.manifest.version = '2.0';
    manifest.verification.checksum_algorithm = 'sha256';
    manifest.verification.total_checksum = backupManifest.calculateManifestChecksum(manifest, { keyed: false });
    process.env.BACKUP_MANIFEST_RECOVERY_SHA256 = require('../../src/utils/manifestCanonical').recoveryDigest(manifest);
    process.env.BACKUP_MANIFEST_RECOVERY_REASON = 'Offline inspected isolated legacy recovery by fixture operator';
    const target = writeManifest(manifest);
    await expect(backupManifest.loadManifest(target)).rejects.toThrow(/unkeyed/);
    const result = await new RestoreService().restore({ source: root, manifestPath: target, restoreType: 'files', dryRun: true, force: true });
    expect(result.success).toBe(true);
    const row = await db('restore_runs').orderBy('id', 'desc').first();
    expect(JSON.parse(row.statistics).authentication).toMatchObject({ authenticated: false, recovery: true, reason: process.env.BACKUP_MANIFEST_RECOVERY_REASON });
  });
});
