/**
 * Restore path containment must not break the normal restore wizard
 * (GHSA-fw4c, codex round 2).
 *
 * `source` is usually a SOURCE TYPE, not a path: RestoreWizard posts
 * 'local' | 's3' | 'upload', and restoreService.restore() branches on those
 * literals before deriving a directory. The first version of the containment
 * check treated `source` as a path, so path.resolve('local') landed outside
 * the configured backup roots and BOTH /validate and /start returned 400 —
 * blocking every normal restore.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restorepath-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'restorepath-test-secret';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('restore path allowlist (GHSA-fw4c)', () => {
  let db; let cleanup; let checkRestorePathsAllowed;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    // Configure a backup root so the allowlist is actually active.
    for (const [key, value] of [['backup_destination_path', '/backup']]) {
      const existing = await db('app_settings').where({ setting_key: key }).first();
      if (existing) {
        await db('app_settings').where({ setting_key: key }).update({ setting_value: JSON.stringify(value) });
      } else {
        await db('app_settings').insert({
          setting_key: key, setting_value: JSON.stringify(value), setting_type: 'backup',
        });
      }
    }

    ({ checkRestorePathsAllowed } = require('../../src/routes/adminRestore')._internal);
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('allows the wizard\'s source TYPE tokens', async () => {
    for (const source of ['local', 's3', 'upload']) {
      const err = await checkRestorePathsAllowed({
        source, manifestPath: '/backup/manifests/backup-manifest-1.json',
      });
      expect(err).toBeNull();
    }
  });

  it('allows an s3:// source URL', async () => {
    const err = await checkRestorePathsAllowed({
      source: 's3://bucket/key/backup.tar.gz',
      manifestPath: '/backup/manifests/backup-manifest-1.json',
    });
    expect(err).toBeNull();
  });

  it('still rejects a manifestPath outside the configured roots', async () => {
    const err = await checkRestorePathsAllowed({
      source: 'local', manifestPath: '/etc/passwd',
    });
    expect(err).toMatch(/inside a configured backup location/i);
  });

  it('still rejects a traversal manifestPath', async () => {
    const err = await checkRestorePathsAllowed({
      source: 'local', manifestPath: '/backup/../etc/shadow',
    });
    expect(err).toBeTruthy();
  });

  it('accepts a real path source inside the roots', async () => {
    const err = await checkRestorePathsAllowed({
      source: '/backup/run-1', manifestPath: '/backup/run-1/manifest.json',
    });
    expect(err).toBeNull();
  });
});
