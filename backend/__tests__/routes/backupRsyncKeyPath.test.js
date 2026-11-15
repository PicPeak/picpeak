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
const { decodeSettingValue } = require('../helpers/settingValue');

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
    return row ? decodeSettingValue(db, row.setting_value) : undefined;
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

    it('refuses a value that is not a string at all', async () => {
      const res = await as(request(app).put('/api/admin/backup/config')).send({ backup_rsync_ssh_key: ['/app/data/ssh/id_ed25519'] });
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

  describe('PUT /config (rsync port)', () => {
    beforeEach(() => setBackupSettings({ backup_destination_type: 'rsync' }));

    it('stores a whole-number port', async () => {
      const res = await as(request(app).put('/api/admin/backup/config')).send({ backup_rsync_port: 2222 });
      expect(res.status).toBe(200);
      expect(await stored('backup_rsync_port')).toBe(2222);
    });

    it.each([0, 65536, 22.5, '2222', '22 -oProxyCommand=x', null, [22]])('refuses %p and stores nothing', async (port) => {
      const res = await as(request(app).put('/api/admin/backup/config')).send({ backup_rsync_port: port });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('RSYNC_CONFIG_INVALID');
      expect(await stored('backup_rsync_port')).toBeUndefined();
    });
  });

  describe('POST /test-connection (rsync)', () => {
    let trustDir;
    beforeEach(() => {
      trustDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-rsync-trust-'));
      process.env.BACKUP_SSH_KNOWN_HOSTS = path.join(trustDir, 'known_hosts');
      fs.writeFileSync(process.env.BACKUP_SSH_KNOWN_HOSTS, 'backup.example.com ssh-ed25519 fixture-only\n');
    });
    afterEach(() => {
      delete process.env.BACKUP_SSH_KNOWN_HOSTS;
      fs.rmSync(trustDir, { recursive: true, force: true });
    });
    // A public IP literal: no DNS, and the key check answers before ssh runs.
    const testRsync = (body) => as(request(app).post('/api/admin/backup/test-connection'))
      .send({ destination_type: 'rsync', host: '8.8.8.8', user: 'backup', path: '/srv/backups', ...body });
    // The -e transport string rsync is handed, parsed back into its words.
    const shellOf = args => args[args.indexOf('-e') + 1];

    it('refuses a pasted key instead of looking for a file named after it', async () => {
      const res = await testRsync({ ssh_key: PASTED_KEY });
      expect(res.body).toMatchObject({ success: false, code: 'RSYNC_SSH_KEY_NOT_PATH' });
    });

    it('uses the saved path when the form sends the mask', async () => {
      await setBackupSettings({ backup_rsync_ssh_key: '/nonexistent/picpeak/id_ed25519' });
      const res = await testRsync({ ssh_key: '••••••••' });
      expect(res.body).toMatchObject({ success: false, code: 'RSYNC_CONFIG_INVALID' });
      expect(res.body.message).toContain('SSH key file not found');
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
        expect(cmd).toBe('rsync');
        expect(shellOf(args)).not.toContain('\'-i\'');
      } finally { spawn.mockRestore(); }
    });

    it('reports a saved pasted key rather than using it', async () => {
      await setBackupSettings({ backup_rsync_ssh_key: PASTED_KEY });
      const res = await testRsync({});
      expect(res.body.code).toBe('RSYNC_SSH_KEY_NOT_PATH');
    });

    it('pins the approved address rather than letting SSH resolve a rebound hostname', async () => {
      const dns = require('dns').promises;
      const lookup = jest.spyOn(dns, 'lookup')
        .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
        .mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
      const { EventEmitter } = require('events');
      const spawn = jest.spyOn(require('child_process'), 'spawn').mockImplementation(() => {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
        setImmediate(() => proc.emit('close', 0));
        return proc;
      });
      try {
        const res = await testRsync({ host: 'backup.example.com', ssh_key: '' });
        expect(res.body.success).toBe(true);
        const [cmd, args] = spawn.mock.calls[0];
        expect(cmd).toBe('rsync');
        expect(shellOf(args)).toContain('\'Hostname=8.8.8.8\'');
        expect(shellOf(args)).toContain('\'HostKeyAlias=backup.example.com\'');
        expect(shellOf(args)).toContain('\'StrictHostKeyChecking=yes\'');
        expect(shellOf(args)).toContain('\'-F\'');
        expect(lookup).toHaveBeenCalledTimes(1);
      } finally { lookup.mockRestore(); spawn.mockRestore(); }
    });

    it('passes the port to ssh and maps a refused host key to its code', async () => {
      const { EventEmitter } = require('events');
      const spawn = jest.spyOn(require('child_process'), 'spawn').mockImplementation(() => {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
        setImmediate(() => { proc.stderr.emit('data', 'Host key verification failed.\r\n'); proc.emit('close', 255); });
        return proc;
      });
      try {
        const res = await testRsync({ ssh_key: '', port: 2222 });
        const [, args] = spawn.mock.calls[0];
        expect(shellOf(args)).toContain('\'-p\' \'2222\'');
        expect(shellOf(args)).toContain('\'HostKeyAlias=[8.8.8.8]:2222\'');
        expect(res.body).toMatchObject({ success: false, code: 'RSYNC_SSH_HOST_KEY_UNTRUSTED' });
        expect(res.body.message).toContain('unknown or changed');
        spawn.mockClear();
        const bad = await testRsync({ ssh_key: '', port: '22;id' });
        expect(bad.body).toMatchObject({ success: false, code: 'RSYNC_CONFIG_INVALID' });
        expect(spawn).not.toHaveBeenCalled();
      } finally { spawn.mockRestore(); }
    });

    it('rejects malformed host/user instead of stripping them into another destination', async () => {
      const { EventEmitter } = require('events');
      const spawn = jest.spyOn(require('child_process'), 'spawn').mockImplementation(() => {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
        setImmediate(() => proc.emit('close', 0));
        return proc;
      });
      try {
        for (const body of [{ host: '8.8.8.8;' }, { user: 'backup;' }]) {
          const res = await testRsync({ ssh_key: '', ...body });
          expect(res.body.success).toBe(false);
        }
        expect(spawn).not.toHaveBeenCalled();
      } finally { spawn.mockRestore(); }
    });

    describe('probes with rsync itself, as a backup run does', () => {
      const { EventEmitter } = require('events');
      // Stand in for the process table: `respond(cmd, args)` answers each
      // spawn with { code, signal, stderr } or { error }.
      const mockSpawn = (respond) => jest.spyOn(require('child_process'), 'spawn').mockImplementation((cmd, args) => {
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
        const outcome = respond(cmd, args);
        setImmediate(() => {
          if (outcome.error) { proc.emit('error', outcome.error); proc.emit('close', -2, null); return; }
          if (outcome.stderr) proc.stderr.emit('data', outcome.stderr);
          proc.emit('close', outcome.code ?? null, outcome.signal ?? null);
        });
        return proc;
      });
      const failing = (stderr, code = 255) => mockSpawn(() => ({ code, stderr }));

      it('lists the remote path over the backup transport, without a shell', async () => {
        const keyPath = path.join(trustDir, 'id_ed25519');
        fs.writeFileSync(keyPath, 'fixture', { mode: 0o600 });
        const spawn = mockSpawn(() => ({ code: 0 }));
        try {
          const res = await testRsync({ ssh_key: keyPath, path: '/srv/backups/' });
          expect(res.body).toEqual({ success: true, message: 'Rsync connection successful' });
          expect(spawn).toHaveBeenCalledTimes(1);
          const [cmd, args, options] = spawn.mock.calls[0];
          expect(cmd).toBe('rsync');
          expect(options).toMatchObject({ shell: false, timeout: 15000 });
          expect(args).toEqual(['--list-only', '-e', expect.any(String), 'backup@8.8.8.8:/srv/backups']);
          const shell = shellOf(args);
          expect(shell.startsWith('\'ssh\' \'-F\' \'/dev/null\'')).toBe(true);
          for (const option of ['StrictHostKeyChecking=yes', 'BatchMode=yes', `UserKnownHostsFile=${process.env.BACKUP_SSH_KNOWN_HOSTS}`,
            'GlobalKnownHostsFile=/dev/null', 'ProxyJump=none', 'ControlMaster=no']) {
            expect(shell).toContain(`'${option}'`);
          }
          expect(shell).toContain(`'-i' '${keyPath}'`);
          // The same transport string the backup run hands rsync.
          const backupArgs = await require('../../src/services/backupService').buildRsyncArgs({
            backup_rsync_host: '8.8.8.8', backup_rsync_user: 'backup', backup_rsync_ssh_key: keyPath, backup_rsync_path: '/srv/backups',
          }, [], '/data');
          expect(shellOf(backupArgs)).toBe(shell);
        } finally { spawn.mockRestore(); }
      });

      it('succeeds on an rsync-only host that refuses `ssh … echo` (Hetzner Storage Box)', async () => {
        const spawn = mockSpawn((cmd, args) => (cmd === 'rsync' && args[0] === '--list-only'
          ? { code: 0 }
          : { code: 1, stderr: 'Command not found. Use \'help\' to get a list of available commands.\n' }));
        try {
          const res = await testRsync({ ssh_key: '', port: 23 });
          expect(res.body).toMatchObject({ success: true });
          expect(spawn.mock.calls.every(([cmd]) => cmd === 'rsync')).toBe(true);
        } finally { spawn.mockRestore(); }
      });

      it('passes when only the final directory is missing: the first backup creates it', async () => {
        const spawn = mockSpawn((cmd, args) => (args[args.length - 1].endsWith(':/srv/backups')
          ? { code: 23, stderr: 'rsync: [sender] link_stat "/srv/backups" failed: No such file or directory (2)\n' }
          : { code: 0 }));
        try {
          const res = await testRsync({ ssh_key: '' });
          expect(res.body.success).toBe(true);
          expect(res.body.message).toContain('the first backup creates it');
          expect(spawn.mock.calls.map(([, args]) => args[args.length - 1])).toEqual(['backup@8.8.8.8:/srv/backups', 'backup@8.8.8.8:/srv']);
        } finally { spawn.mockRestore(); }
      });

      it('fails when the parent is missing too', async () => {
        const spawn = failing('rsync: change_dir "/srv" failed: No such file or directory (2)\n', 23);
        try {
          const res = await testRsync({ ssh_key: '', path: '/srv/backups' });
          expect(res.body).toMatchObject({ success: false, code: 'RSYNC_REMOTE_PATH_NOT_FOUND' });
          expect(res.body.message).toContain('/srv');
        } finally { spawn.mockRestore(); }
      });

      it('requires a valid remote path and never spawns without one', async () => {
        const spawn = mockSpawn(() => ({ code: 0 }));
        try {
          for (const body of [{ path: '' }, { path: '/srv/x;id' }, { path: '/srv/$(id)' }]) {
            const res = await testRsync({ ssh_key: '', ...body });
            expect(res.body).toMatchObject({ success: false, code: 'RSYNC_CONFIG_INVALID' });
          }
          expect(spawn).not.toHaveBeenCalled();
        } finally { spawn.mockRestore(); }
      });

      it('names a missing rsync binary', async () => {
        const spawn = mockSpawn(() => ({ error: Object.assign(new Error('spawn rsync ENOENT'), { code: 'ENOENT', path: 'rsync' }) }));
        try {
          const res = await testRsync({ ssh_key: '' });
          expect(res.body).toMatchObject({ success: false, code: 'RSYNC_BINARY_MISSING' });
          expect(res.body.message).toContain('rsync program is not installed');
        } finally { spawn.mockRestore(); }
      });

      it('names a missing ssh binary', async () => {
        const spawn = failing('rsync: [sender] Failed to exec ssh: No such file or directory (2)\nrsync error: error in IPC code (code 14)\n', 14);
        try {
          const res = await testRsync({ ssh_key: '' });
          expect(res.body).toMatchObject({ success: false, code: 'RSYNC_SSH_BINARY_MISSING' });
          expect(res.body.message).toContain('openssh-client');
        } finally { spawn.mockRestore(); }
      });

      it.each([
        ['backup@8.8.8.8: Permission denied (publickey,password).\r\nrsync: connection unexpectedly closed (0 bytes received so far) [Receiver]\n', 'RSYNC_AUTH_FAILED', undefined],
        ['ssh: connect to host 8.8.8.8 port 22: Connection refused\r\n', 'RSYNC_CONNECTION_REFUSED', undefined],
        ['ssh: connect to host 8.8.8.8 port 22: Connection timed out\r\n', 'RSYNC_CONNECTION_TIMEOUT', undefined],
        ['', 'RSYNC_CONNECTION_TIMEOUT', 'SIGTERM'],
        ['ssh: connect to host 8.8.8.8 port 22: No route to host\r\n', 'RSYNC_HOST_UNREACHABLE', undefined],
        ['rsync: [sender] link_stat "/srv/backups" failed: Permission denied (13)\n', 'RSYNC_REMOTE_PATH_DENIED', undefined],
      ])('maps %j to %s', async (stderr, code, signal) => {
        const spawn = mockSpawn(() => ({ code: signal ? null : 255, signal, stderr }));
        try {
          const res = await testRsync({ ssh_key: '' });
          expect(res.body).toMatchObject({ success: false, code });
          expect(res.body.message).not.toContain('Check server logs');
        } finally { spawn.mockRestore(); }
      });

      it('answers anything else with a sanitized stderr excerpt and keeps the warn line', async () => {
        const keyPath = path.join(trustDir, 'id_ed25519');
        fs.writeFileSync(keyPath, 'fixture', { mode: 0o600 });
        const logger = require('../../src/utils/logger');
        const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
        const spawn = failing([
          `Warning: Identity file ${keyPath} not accessible: weird.`,
          '-----BEGIN OPENSSH PRIVATE KEY-----',
          'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQyNTUx',
          'protocol version mismatch -- is your shell clean?',
        ].join('\n'), 2);
        try {
          const res = await testRsync({ ssh_key: keyPath });
          expect(res.body).toMatchObject({ success: false, code: 'RSYNC_CONNECTION_FAILED' });
          expect(res.body.message).toContain('protocol version mismatch');
          expect(res.body.message).toContain('<ssh key>');
          expect(res.body.message).not.toContain(keyPath);
          expect(res.body.message).not.toMatch(/PRIVATE KEY|b3BlbnNzaC1rZXkt/);
          expect(warn).toHaveBeenCalledWith('Rsync connection test failed', expect.objectContaining({
            destination: '8.8.8.8', code: 'RSYNC_CONNECTION_FAILED',
          }));
        } finally { spawn.mockRestore(); warn.mockRestore(); }
      });
    });
  });

  describe('the rsync backup', () => {
    it('warns at service start when the destination has a key but no known_hosts file', async () => {
      const backupService = require('../../src/services/backupService');
      const logger = require('../../src/utils/logger');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-rsync-boot-'));
      const key = path.join(dir, 'backup_ed25519');
      fs.writeFileSync(key, 'fixture private key');
      await setBackupSettings({ backup_enabled: false, backup_destination_type: 'rsync',
        backup_rsync_host: 'Backup.Example.com', backup_rsync_path: '/srv/backups', backup_rsync_ssh_key: key });
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        await backupService.startBackupService();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain(`ssh-keyscan backup.example.com >> ${path.join(dir, 'known_hosts')}`);
        warn.mockClear();
        fs.writeFileSync(path.join(dir, 'known_hosts'), 'backup.example.com ssh-ed25519 fixture-only\n');
        await backupService.startBackupService();
        expect(warn).not.toHaveBeenCalled();
      } finally { warn.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('names a stored pasted key plainly', async () => {
      const backupService = require('../../src/services/backupService');
      await expect(backupService.buildRsyncArgs({
        backup_rsync_host: 'backup.example.com', backup_rsync_path: '/srv/backups', backup_rsync_ssh_key: PASTED_KEY,
      })).rejects.toThrow(/holds a pasted key, not a key file path/);
    });
  });
});
