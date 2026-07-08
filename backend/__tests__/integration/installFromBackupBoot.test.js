/**
 * Install-from-backup boot hook — pins the trigger-file convention.
 *
 * The hook itself depends on `restoreService.restore`, which is hard
 * to fully exercise in an integration test without a real PG cluster
 * (sequence resync, DROP/CREATE, etc.). So we stub the actual restore
 * and verify the BOOT HOOK logic:
 *
 *   - No trigger file → no-op, ran=false
 *   - Empty trigger file → picks newest manifest from manifests/
 *   - Non-empty trigger file → uses the path inside
 *   - DB not empty → refuses (no restore call)
 *   - DB not empty + FORCE env → proceeds
 *   - Successful restore → deletes trigger file
 *   - Failed restore → leaves trigger file in place
 *
 * These are the surfaces an admin will hit when actually using the
 * feature — the docker-compose-on-real-PG end-to-end test belongs in
 * the follow-up CI work captured as task #7 earlier today.
 */

const fs = require('fs');
const path = require('path');

const { bootCrmDb } = require('./helpers/crmDb');

// Stub the heavy lifting so the test stays fast + portable.
const mockRestore = jest.fn();
jest.mock('../../src/services/restoreService', () => ({
  restoreService: {
    restore: (...args) => mockRestore(...args),
  },
}));

jest.setTimeout(30000);

describe('installFromBackupBoot', () => {
  let db;
  let cleanup;
  let storagePath;
  let backupRoot;
  let manifestsDir;
  let tryInstallFromBackup;
  let originalBackupRootEnv;
  let originalForceEnv;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    storagePath = process.env.STORAGE_PATH;
    backupRoot = path.join(storagePath, 'backup');
    manifestsDir = path.join(backupRoot, 'manifests');
    fs.mkdirSync(manifestsDir, { recursive: true });

    originalBackupRootEnv = process.env.BACKUP_ROOT;
    originalForceEnv = process.env.INSTALL_FROM_BACKUP_FORCE;
    process.env.BACKUP_ROOT = backupRoot;

    ({ tryInstallFromBackup } = require('../../src/services/_installFromBackupBoot'));
  }, 120000);

  afterAll(async () => {
    if (originalBackupRootEnv === undefined) {
      delete process.env.BACKUP_ROOT;
    } else {
      process.env.BACKUP_ROOT = originalBackupRootEnv;
    }
    if (originalForceEnv === undefined) {
      delete process.env.INSTALL_FROM_BACKUP_FORCE;
    } else {
      process.env.INSTALL_FROM_BACKUP_FORCE = originalForceEnv;
    }
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    mockRestore.mockReset();
    mockRestore.mockResolvedValue({ success: true });
    delete process.env.INSTALL_FROM_BACKUP_FORCE;

    // Clean trigger files + manifests between tests
    for (const name of ['RESTORE_ON_INSTALL', 'RESTORE_ON_INSTALL.txt']) {
      const p = path.join(backupRoot, name);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    for (const f of fs.readdirSync(manifestsDir)) {
      fs.unlinkSync(path.join(manifestsDir, f));
    }

    // Reset DB to fresh-install state
    await db('events').del();
    // Leave admin_users alone — fresh-install state has 1 row.
  });

  it('no trigger file → no-op', async () => {
    const result = await tryInstallFromBackup(db);
    expect(result.ran).toBe(false);
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it('empty trigger file picks the newest manifest from manifests/', async () => {
    const older = path.join(manifestsDir, 'backup-manifest-001.json');
    const newer = path.join(manifestsDir, 'backup-manifest-002.json');
    fs.writeFileSync(older, '{}');
    // Set the newer file's mtime slightly later so it wins the sort
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(older, past, past);
    fs.writeFileSync(newer, '{}');

    // Empty trigger
    fs.writeFileSync(path.join(backupRoot, 'RESTORE_ON_INSTALL'), '');

    const result = await tryInstallFromBackup(db);
    expect(result.ran).toBe(true);
    expect(result.manifestPath).toBe(newer);
    expect(mockRestore).toHaveBeenCalledWith(expect.objectContaining({
      source: 'local',
      manifestPath: newer,
      restoreType: 'full',
      force: true,
      skipPreBackup: true,
    }));
  });

  it('non-empty trigger file uses the path inside', async () => {
    const specific = path.join(manifestsDir, 'backup-manifest-specific.json');
    fs.writeFileSync(specific, '{}');

    // Relative to backupRoot
    fs.writeFileSync(
      path.join(backupRoot, 'RESTORE_ON_INSTALL'),
      'manifests/backup-manifest-specific.json\n',
    );

    const result = await tryInstallFromBackup(db);
    expect(result.ran).toBe(true);
    expect(result.manifestPath).toBe(specific);
  });

  it('deletes the trigger file after a successful restore', async () => {
    const manifest = path.join(manifestsDir, 'backup-manifest-001.json');
    fs.writeFileSync(manifest, '{}');
    const triggerPath = path.join(backupRoot, 'RESTORE_ON_INSTALL');
    fs.writeFileSync(triggerPath, '');

    await tryInstallFromBackup(db);
    expect(fs.existsSync(triggerPath)).toBe(false);
  });

  it('leaves the trigger file in place when restore throws', async () => {
    mockRestore.mockRejectedValueOnce(new Error('restore exploded'));
    const manifest = path.join(manifestsDir, 'backup-manifest-001.json');
    fs.writeFileSync(manifest, '{}');
    const triggerPath = path.join(backupRoot, 'RESTORE_ON_INSTALL');
    fs.writeFileSync(triggerPath, '');

    const result = await tryInstallFromBackup(db);
    expect(result.ran).toBe(false);
    expect(result.error).toMatch(/restore exploded/);
    expect(fs.existsSync(triggerPath)).toBe(true);
  });

  it('refuses to run when the install already has events', async () => {
    // Simulate an install with existing data
    await db('events').insert({
      slug: 'existing-event',
      event_name: 'Existing Event',
      event_type: 'wedding',
      event_date: new Date(),
      host_email: 'host@example.com',
      admin_email: 'host@example.com',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      share_link: 'existing-event-token',
      password_hash: 'dummy-hash-for-test',
      created_at: new Date(),
    });

    const manifest = path.join(manifestsDir, 'backup-manifest-001.json');
    fs.writeFileSync(manifest, '{}');
    fs.writeFileSync(path.join(backupRoot, 'RESTORE_ON_INSTALL'), '');

    const result = await tryInstallFromBackup(db);
    expect(result.ran).toBe(false);
    expect(result.error).toMatch(/Database not empty/);
    expect(mockRestore).not.toHaveBeenCalled();

    // Trigger file should NOT be deleted — admin needs to fix + retry
    expect(fs.existsSync(path.join(backupRoot, 'RESTORE_ON_INSTALL'))).toBe(true);
  });

  it('proceeds when INSTALL_FROM_BACKUP_FORCE=true even with existing data', async () => {
    await db('events').insert({
      slug: 'existing-event-2',
      event_name: 'Existing Event 2',
      event_type: 'wedding',
      event_date: new Date(),
      host_email: 'host@example.com',
      admin_email: 'host@example.com',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      share_link: 'existing-event-2-token',
      password_hash: 'dummy-hash-for-test-2',
      created_at: new Date(),
    });

    const manifest = path.join(manifestsDir, 'backup-manifest-001.json');
    fs.writeFileSync(manifest, '{}');
    fs.writeFileSync(path.join(backupRoot, 'RESTORE_ON_INSTALL'), '');

    process.env.INSTALL_FROM_BACKUP_FORCE = 'true';
    const result = await tryInstallFromBackup(db);

    expect(result.ran).toBe(true);
    expect(mockRestore).toHaveBeenCalled();
  });
});
