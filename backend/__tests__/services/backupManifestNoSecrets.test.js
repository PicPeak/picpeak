/**
 * Backup manifests must not carry the stored backup credentials.
 *
 * `metadata.backup_settings` used to be every `setting_type = 'backup'` row
 * verbatim — including the S3 access/secret key and a pasted rsync private
 * key. The manifest is returned by the `backup.view` endpoints, which the
 * built-in non-super-admin role holds, and GET /config masks exactly those
 * values. Scanner finding 5585508b.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-manifest-secrets-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'manifest-secrets-test-secret';

const { bootCrmDb } = require('../integration/helpers/crmDb');

const ACCESS_KEY = 'AKIA-SENTINEL-ACCESS-KEY';
const SECRET_KEY = 'sentinel-s3-secret-key-value';
const SSH_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nsentinel\n-----END OPENSSH PRIVATE KEY-----';

describe('backupManifest — credentials never enter the manifest', () => {
  let db; let cleanup; let backupManifest;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    backupManifest = require('../../src/services/backupManifest');

    const upsert = async (key, value) => {
      await db('app_settings').where('setting_key', key).del();
      await db('app_settings').insert({
        setting_key: key,
        setting_value: JSON.stringify(value),
        setting_type: 'backup',
      });
    };
    await upsert('backup_s3_bucket', 'my-bucket');
    await upsert('backup_s3_access_key', ACCESS_KEY);
    await upsert('backup_s3_secret_key', SECRET_KEY);
    await upsert('backup_rsync_ssh_key', SSH_KEY);
    await upsert('backup_destination_type', 's3');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('drops the S3 keys and the SSH key from getBackupSettings()', async () => {
    const settings = await backupManifest.getBackupSettings();
    expect(settings.backup_s3_bucket).toBe('my-bucket');
    expect(settings.backup_destination_type).toBe('s3');
    expect(settings).not.toHaveProperty('backup_s3_access_key');
    expect(settings).not.toHaveProperty('backup_s3_secret_key');
    expect(settings).not.toHaveProperty('backup_rsync_ssh_key');
  });

  it('no serialised manifest field contains a sentinel credential', async () => {
    const manifest = await backupManifest.generateManifest({
      backupType: 'full',
      backupPath: os.tmpdir(),
      files: [{ path: 'uploads/a.jpg', size: 1, checksum: 'x' }],
      databaseInfo: { type: 'sqlite' },
    });
    const serialised = JSON.stringify(manifest);
    expect(serialised).not.toContain(ACCESS_KEY);
    expect(serialised).not.toContain(SECRET_KEY);
    expect(serialised).not.toContain('PRIVATE KEY');
    // Non-secret destination identifiers still travel with the backup.
    expect(manifest.metadata.backup_settings.backup_s3_bucket).toBe('my-bucket');
  });
});
