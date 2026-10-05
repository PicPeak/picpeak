/**
 * A local backup destination is a path the backend resolves for itself: under
 * Docker, inside the container. A host path typed there ("/home/ubuntu/...")
 * failed the backup with a bare "EACCES: permission denied, mkdir
 * '/home/ubuntu'", and the connection test said "check server logs" for a
 * warn that production never prints to the console. The test also refused
 * every directory that did not exist yet, although the backup creates it
 * (issue 1365).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-local-dest-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(base, 'db.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-destination-test-secret';

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb } = require('../integration/helpers/crmDb');
const { findWriteBlocker } = require('../../src/utils/localBackupDestination');

// root ignores directory modes, so a read-only parent blocks nothing.
const itAsNonRoot = process.getuid && process.getuid() === 0 ? it.skip : it;

describe('local backup destination', () => {
  let db; let cleanup; let app; let superToken;

  const writable = path.join(base, 'writable');
  const readOnly = path.join(base, 'read-only');

  const testLocal = (target) => request(app).post('/api/admin/backup/test-connection')
    .set('Authorization', `Bearer ${superToken}`)
    .send({ destination_type: 'local', path: target });

  beforeAll(async () => {
    fs.mkdirSync(writable);
    fs.mkdirSync(readOnly);
    fs.chmodSync(readOnly, 0o555);

    ({ db, cleanup } = await bootCrmDb());
    const role = await db('roles').where({ name: 'super_admin' }).first();
    const inserted = await db('admin_users').insert({
      username: 'root-admin',
      email: 'root-admin-local-dest@example.com',
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

  afterAll(async () => {
    fs.chmodSync(readOnly, 0o755);
    if (cleanup) await cleanup();
  });

  describe('findWriteBlocker', () => {
    it('finds none for a writable directory', async () => {
      expect(await findWriteBlocker(writable)).toBeNull();
    });

    it('finds none for a missing directory below a writable one', async () => {
      expect(await findWriteBlocker(path.join(writable, 'not', 'yet', 'there'))).toBeNull();
    });

    itAsNonRoot('names the existing ancestor that cannot be written to', async () => {
      expect(await findWriteBlocker(path.join(readOnly, 'ubuntu', 'backups')))
        .toEqual({ path: readOnly, code: 'EACCES' });
    });

    itAsNonRoot('needs search permission on the ancestor, as mkdir does', async () => {
      const noSearch = path.join(base, 'no-search');
      fs.mkdirSync(noSearch);
      fs.chmodSync(noSearch, 0o222);
      try {
        expect(await findWriteBlocker(path.join(noSearch, 'backups')))
          .toEqual({ path: path.join(noSearch, 'backups'), code: 'EACCES' });
        await expect(fs.promises.mkdir(path.join(noSearch, 'backups'), { recursive: true })).rejects.toThrow();
      } finally {
        fs.chmodSync(noSearch, 0o755);
      }
    });

    it('does not take a writable, executable file for a directory', async () => {
      const file = path.join(writable, 'script.sh');
      fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
      try {
        expect(await findWriteBlocker(file)).toEqual({ path: file, code: 'ENOTDIR' });
        await expect(fs.promises.mkdir(file, { recursive: true })).rejects.toThrow();
      } finally {
        fs.unlinkSync(file);
      }
    });

    itAsNonRoot('resolves ".." the way the backup joins its paths', async () => {
      // "new" does not exist: stopping at the writable ancestor would miss
      // that the path leads into the read-only directory.
      const target = `${writable}/new/../../read-only/backups`;
      expect(await findWriteBlocker(target)).toEqual({ path: readOnly, code: 'EACCES' });
      await expect(fs.promises.mkdir(target, { recursive: true })).rejects.toThrow();
      fs.rmdirSync(path.join(writable, 'new'));
    });

    it('does not take a dangling symlink for a missing directory', async () => {
      const link = path.join(writable, 'dangling');
      fs.symlinkSync(path.join(writable, 'gone'), link);
      try {
        expect(await findWriteBlocker(link)).toEqual({ path: link, code: 'BROKEN_SYMLINK' });
        expect(await findWriteBlocker(path.join(link, 'backups'))).toEqual({ path: link, code: 'BROKEN_SYMLINK' });
        await expect(fs.promises.mkdir(path.join(link, 'backups'), { recursive: true })).rejects.toThrow();
      } finally {
        fs.unlinkSync(link);
      }
    });
  });

  describe('POST /test-connection (local)', () => {
    it('accepts a directory the backup would create', async () => {
      const target = path.join(writable, 'created-by-the-backup');
      const res = await testLocal(target);
      expect(res.body).toMatchObject({ success: true });
      // A test probes; it does not create the directory.
      expect(fs.existsSync(target)).toBe(false);
    });

    itAsNonRoot('says which directory blocks a path that cannot be created, and where paths are resolved', async () => {
      const target = path.join(readOnly, 'ubuntu', 'backups');
      const res = await testLocal(target);
      expect(res.body).toMatchObject({ success: false, code: 'LOCAL_PATH_NOT_WRITABLE' });
      expect(res.body.message).toContain(`${target} does not exist and the backend cannot create it: ${readOnly} is not writable (EACCES)`);
      expect(res.body.message).toContain('inside the backend container, not on the host');
      expect(res.body.message).toContain(path.join(process.env.STORAGE_PATH, 'backups'));
      expect(res.body.message).not.toMatch(/server logs/i);
    });

    itAsNonRoot('names an existing directory that is read-only', async () => {
      const res = await testLocal(readOnly);
      expect(res.body).toMatchObject({ success: false, code: 'LOCAL_PATH_NOT_WRITABLE' });
      expect(res.body.message).toContain(`The backend cannot write to ${readOnly} (EACCES).`);
    });

    itAsNonRoot('probes the trimmed path, which is the path that gets saved', async () => {
      // Untrimmed, this would be a missing sibling of the read-only
      // directory, creatable below the writable base.
      const res = await testLocal(` ${readOnly} `);
      expect(res.body).toMatchObject({ success: false, code: 'LOCAL_PATH_NOT_WRITABLE' });
      expect(res.body.message).toContain(`The backend cannot write to ${readOnly} (EACCES).`);
    });

    it('refuses an empty path without probing the working directory', async () => {
      const res = await testLocal('   ');
      expect(res.body).toMatchObject({ success: false });
      expect(res.body.code).toBeUndefined();
    });
  });

  // Issue 1780: writable is not enough when the path is one the backup copies.
  describe('POST /test-connection (local) for a backed-up folder', () => {
    it('refuses a destination that is itself a backed-up folder', async () => {
      const res = await testLocal(path.join(process.env.STORAGE_PATH, 'uploads'));
      expect(res.body).toMatchObject({ success: false, code: 'LOCAL_PATH_IS_BACKED_UP_FOLDER' });
      expect(res.body.message).toContain('the backed-up folder "uploads" itself');
    });

    it('refuses a backed-up folder that is switched off in the saved settings', async () => {
      // The form being tested is not saved yet, so its toggles are unknown
      // here; a folder the backup can copy is refused whatever they say now.
      await db('app_settings').insert({
        setting_key: 'backup_include_thumbnails', setting_value: JSON.stringify(false), setting_type: 'backup',
      }).onConflict('setting_key').merge();
      try {
        const res = await testLocal(path.join(process.env.STORAGE_PATH, 'thumbnails'));
        expect(res.body).toMatchObject({ success: false, code: 'LOCAL_PATH_IS_BACKED_UP_FOLDER' });
      } finally {
        await db('app_settings').where({ setting_key: 'backup_include_thumbnails' }).del();
      }
    });

    it('refuses the storage folder itself, where every file would be copied onto itself', async () => {
      const res = await testLocal(process.env.STORAGE_PATH);
      expect(res.body).toMatchObject({ success: false, code: 'LOCAL_PATH_IS_BACKED_UP_FOLDER' });
      expect(res.body.message).toContain('the storage folder itself');
    });

    it('accepts a destination inside a backed-up folder, which the backup skips', async () => {
      const res = await testLocal(path.join(process.env.STORAGE_PATH, 'uploads', 'own-backups'));
      expect(res.body).toMatchObject({ success: true });
    });
  });

  describe('PUT /config', () => {
    it('stores the destination trimmed, as the database dump reads it', async () => {
      const target = path.join(writable, 'padded');
      const res = await request(app).put('/api/admin/backup/config')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ backup_destination_type: 'local', backup_destination_path: `  ${target} ` });
      expect(res.status).toBe(200);
      const row = await db('app_settings').where({ setting_key: 'backup_destination_path' }).first();
      expect(JSON.parse(row.setting_value)).toBe(target);
    });

    it('refuses a destination that is only whitespace', async () => {
      const res = await request(app).put('/api/admin/backup/config')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ backup_destination_type: 'local', backup_destination_path: '   ' });
      expect(res.status).toBe(400);
    });
  });

  describe('backup run', () => {
    let backupService;

    const runBackupTo = async (target) => {
      backupService = backupService || require('../../src/services/backupService');
      // A dump the run can verify, so it reaches the file backup.
      const dump = path.join(writable, 'fake.sql.gz');
      fs.writeFileSync(dump, 'pretend dump');
      await db('database_backup_runs').del();
      await db('database_backup_runs').insert({
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        status: 'completed',
        backup_type: 'sqlite',
        file_path: dump,
        file_size_bytes: fs.statSync(dump).size,
        destination_path: dump,
      });
      await db('app_settings').where('setting_type', 'backup').del();
      await db('app_settings').insert([
        { setting_key: 'backup_destination_type', setting_value: JSON.stringify('local'), setting_type: 'backup' },
        { setting_key: 'backup_destination_path', setting_value: JSON.stringify(target), setting_type: 'backup' },
        { setting_key: 'backup_database_inline_dump', setting_value: JSON.stringify(false), setting_type: 'backup' },
      ]).onConflict('setting_key').merge();

      await backupService.runBackup(true).catch(() => {});
      return db('backup_runs').orderBy('id', 'desc').first();
    };

    itAsNonRoot('fails with the configured path and where it is resolved, not a bare mkdir error', async () => {
      const target = path.join(readOnly, 'ubuntu', 'backups');
      const run = await runBackupTo(target);
      expect(run.status).toBe('failed');
      expect(run.error_message).toContain(`Cannot create the backup directory ${target}: EACCES.`);
      expect(run.error_message).toContain('inside the backend container, not on the host');
    });

    itAsNonRoot('creates the directory the connection test probed when the path holds ".."', async () => {
      // Typed as it stands, mkdir -p would first try to create "new" in the
      // read-only directory; the files below go through path.join either way.
      const target = `${readOnly}/new/../../writable/dotdot-backups`;
      expect((await testLocal(target)).body).toMatchObject({ success: true });

      const run = await runBackupTo(target);
      expect(run.status).toBe('completed');
      expect(fs.statSync(path.join(writable, 'dotdot-backups')).isDirectory()).toBe(true);
    });

    // Issue 1780: each run used to copy the previous run's output.
    it('does not copy its own output when the destination lies inside a backed-up folder', async () => {
      const uploads = path.join(process.env.STORAGE_PATH, 'uploads');
      fs.mkdirSync(path.join(uploads, 'logos'), { recursive: true });
      fs.writeFileSync(path.join(uploads, 'logos', 'logo.png'), 'logo bytes');
      const target = path.join(uploads, 'own-backups');

      expect((await runBackupTo(target)).status).toBe('completed');
      expect(fs.existsSync(path.join(target, 'uploads', 'logos', 'logo.png'))).toBe(true);
      expect((await runBackupTo(target)).status).toBe('completed');

      expect(fs.existsSync(path.join(target, 'uploads', 'own-backups'))).toBe(false);
    });

    it('refuses to run into a destination that is itself a backed-up folder', async () => {
      const uploads = path.join(process.env.STORAGE_PATH, 'uploads');
      fs.mkdirSync(uploads, { recursive: true });

      const run = await runBackupTo(uploads);

      expect(run.status).toBe('failed');
      expect(run.error_message).toContain('the backed-up folder "uploads" itself');
      expect(fs.existsSync(path.join(uploads, 'uploads'))).toBe(false);
    });

    it('refuses to run into the storage folder itself', async () => {
      const run = await runBackupTo(process.env.STORAGE_PATH);
      expect(run.status).toBe('failed');
      expect(run.error_message).toContain('the storage folder itself');
    });
  });
});
