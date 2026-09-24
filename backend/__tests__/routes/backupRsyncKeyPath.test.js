/**
 * backup_rsync_ssh_key is the path of a private key file: the rsync backup
 * hands it to `ssh -i`. The form asked for the key itself, so a pasted key
 * could be saved and every rsync backup then failed. A path is now required,
 * shown in the form, and used by the connection test; a pasted key already
 * stored stays masked and is named plainly when a backup runs.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-rsync-key-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'rsync-key-test-secret';

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb } = require('../integration/helpers/crmDb');

const PASTED_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----';

describe('rsync SSH key is a key file path', () => {
  let db; let cleanup; let app; let superToken;

  const setBackupSettings = async (settings) => {
    await db('app_settings').where({ setting_type: 'backup' }).del();
    for (const [key, value] of Object.entries(settings)) {
      await db('app_settings').insert({
        setting_key: key, setting_value: JSON.stringify(value), setting_type: 'backup',
        updated_at: new Date().toISOString(),
      });
    }
  };
  const stored = async (key) => {
    const row = await db('app_settings').where({ setting_key: key }).first();
    return row ? JSON.parse(row.setting_value) : undefined;
  };
  const as = (req) => req.set('Authorization', `Bearer ${superToken}`);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const role = await db('roles').where({ name: 'super_admin' }).first();
    const inserted = await db('admin_users').insert({
      username: 'root-admin',
      email: 'root-admin-rsync@example.com',
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id');
    const id = inserted[0]?.id ?? inserted[0];
    superToken = jwt.sign(
      { id, username: 'root-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' },
    );
    app = express();
    app.use(express.json());
    app.use('/api/admin/backup', require('../../src/routes/adminBackup'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  describe('GET /config', () => {
    it('shows a key file path, which is not a secret', async () => {
      await setBackupSettings({ backup_rsync_ssh_key: '/app/data/ssh/backup_ed25519' });
      const res = await as(request(app).get('/api/admin/backup/config'));
      expect(res.body.backup_rsync_ssh_key).toBe('/app/data/ssh/backup_ed25519');
    });

    it('keeps a pasted key masked', async () => {
      await setBackupSettings({ backup_rsync_ssh_key: PASTED_KEY });
      const res = await as(request(app).get('/api/admin/backup/config'));
      expect(res.body.backup_rsync_ssh_key).toBe('••••••••');
    });
  });

  describe('PUT /config', () => {
    beforeEach(() => setBackupSettings({ backup_destination_type: 'rsync' }));

    it('refuses a pasted key with a stable code and stores nothing', async () => {
      const res = await as(request(app).put('/api/admin/backup/config')).send({ backup_rsync_ssh_key: PASTED_KEY });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('RSYNC_SSH_KEY_NOT_PATH');
      expect(await stored('backup_rsync_ssh_key')).toBeUndefined();
    });

    it('refuses a relative path', async () => {
      const res = await as(request(app).put('/api/admin/backup/config')).send({ backup_rsync_ssh_key: 'ssh/id_ed25519' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('RSYNC_SSH_KEY_NOT_PATH');
    });

    it('stores an absolute key file path, trimmed', async () => {
      const res = await as(request(app).put('/api/admin/backup/config')).send({ backup_rsync_ssh_key: ' /app/data/ssh/id_ed25519 ' });
      expect(res.status).toBe(200);
      expect(await stored('backup_rsync_ssh_key')).toBe('/app/data/ssh/id_ed25519');
    });

    it('allows clearing it', async () => {
      await setBackupSettings({ backup_rsync_ssh_key: PASTED_KEY });
      const res = await as(request(app).put('/api/admin/backup/config')).send({ backup_rsync_ssh_key: '' });
      expect(res.status).toBe(200);
      expect(await stored('backup_rsync_ssh_key')).toBe('');
    });

    it('keeps the stored value when the mask round-trips', async () => {
      await setBackupSettings({ backup_rsync_ssh_key: PASTED_KEY });
      const res = await as(request(app).put('/api/admin/backup/config')).send({ backup_rsync_ssh_key: '••••••••' });
      expect(res.status).toBe(200);
      expect(await stored('backup_rsync_ssh_key')).toBe(PASTED_KEY);
    });
  });

  describe('POST /test-connection (rsync)', () => {
    // A public IP literal: no DNS, and the key check answers before ssh runs.
    const testRsync = (body) => as(request(app).post('/api/admin/backup/test-connection'))
      .send({ destination_type: 'rsync', host: '8.8.8.8', user: 'backup', ...body });

    it('refuses a pasted key instead of looking for a file named after it', async () => {
      const res = await testRsync({ ssh_key: PASTED_KEY });
      expect(res.body).toMatchObject({ success: false, code: 'RSYNC_SSH_KEY_NOT_PATH' });
    });

    it('uses the saved path when the form sends the mask', async () => {
      await setBackupSettings({ backup_rsync_ssh_key: '/nonexistent/picpeak/id_ed25519' });
      const res = await testRsync({ ssh_key: '••••••••' });
      expect(res.body).toMatchObject({ success: false, message: 'SSH key file not found' });
    });

    it('tests without a key when the field was emptied, not with the saved one', async () => {
      await setBackupSettings({ backup_rsync_ssh_key: '/app/data/ssh/saved_key' });
      // Stand in for ssh: record its arguments and succeed.
      const { EventEmitter } = require('events');
      const childProcess = require('child_process');
      const spawn = jest.spyOn(childProcess, 'spawn').mockImplementation(() => {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
        setImmediate(() => proc.emit('close', 0));
        return proc;
      });
      try {
        const res = await testRsync({ ssh_key: '' });
        expect(res.body.success).toBe(true);
        const [cmd, args] = spawn.mock.calls[0];
        expect(cmd).toBe('ssh');
        expect(args).not.toContain('-i');
      } finally { spawn.mockRestore(); }
    });

    it('reports a saved pasted key rather than using it', async () => {
      await setBackupSettings({ backup_rsync_ssh_key: PASTED_KEY });
      const res = await testRsync({});
      expect(res.body.code).toBe('RSYNC_SSH_KEY_NOT_PATH');
    });
  });

  describe('the rsync backup', () => {
    it('names a stored pasted key plainly', () => {
      const backupService = require('../../src/services/backupService');
      expect(() => backupService.buildRsyncArgs({
        backup_rsync_host: 'backup.example.com', backup_rsync_path: '/srv/backups', backup_rsync_ssh_key: PASTED_KEY,
      })).toThrow(/holds a pasted key, not a key file path/);
    });
  });
});
