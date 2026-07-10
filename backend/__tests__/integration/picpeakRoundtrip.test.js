'use strict';

// Full .picpeak roundtrip on a temp SQLite DB:
//   1. seed a "backup" instance (admin A + a marker setting)
//   2. export → .picpeak
//   3. simulate a reinstall: wipe, create a DIFFERENT current admin B, mutate data
//   4. import the backup with currentAdminId = B
//   5. assert the backup data is restored AND the current account (B) survives,
//      while the backup's admin (A) is also present (different email → added).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const fs = require('fs');
const path = require('path');
const { bootCrmDb } = require('./helpers/crmDb');

let db;
let cleanup;
let tmpDir;
let createPicpeak;
let importFromPicpeak;
let validateManifest;
let superAdminRoleId;

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.env.STORAGE_PATH = tmpDir;
  ({ createPicpeak } = require('../../src/services/picpeakExportService'));
  ({ importFromPicpeak, validateManifest } = require('../../src/services/picpeakImportService'));
  const role = await db('roles').where({ name: 'super_admin' }).first();
  superAdminRoleId = role.id;
}, 60000);

afterAll(async () => {
  await cleanup();
});

const adminRow = (email, hash) => ({
  username: email,
  email,
  password_hash: hash,
  role_id: superAdminRoleId,
  is_active: true,
  must_change_password: false,
  created_at: new Date(),
  updated_at: new Date(),
});

async function setMarker(value) {
  await db('app_settings')
    .insert({ setting_key: 'roundtrip_marker', setting_value: JSON.stringify(value), setting_type: 'string' })
    .onConflict('setting_key').merge();
}
async function getMarker() {
  const row = await db('app_settings').where({ setting_key: 'roundtrip_marker' }).first();
  return row ? JSON.parse(row.setting_value) : null;
}

describe('.picpeak roundtrip (export → import)', () => {
  it('restores backup data and preserves the current account', async () => {
    // 1. Seed the "source" instance.
    await db('admin_users').del();
    await db('admin_users').insert(adminRow('backup-admin@old.example', 'HASH_A'));
    await setMarker('from_backup');

    // 2. Export.
    const { filePath } = await createPicpeak({ includePhotos: false });

    try {
      // 3. Simulate a reinstall: fresh current admin B, mutated data.
      await db('admin_users').del();
      const [bId] = await db('admin_users').insert(adminRow('current-admin@new.example', 'HASH_B')).returning('id');
      const currentAdminId = typeof bId === 'object' ? bId.id : bId;
      await setMarker('mutated_after_backup');

      // 4. Import, preserving the current admin.
      const result = await importFromPicpeak({ filePath: undefined, picpeakPath: filePath, currentAdminId });
      expect(result.restored).toBe(true);
      expect(result.tables).toBeGreaterThan(0);

      // 5a. Backup data restored (marker reverted to the backup value).
      expect(await getMarker()).toBe('from_backup');

      // 5b. The backup's admin is present (different email → added).
      const a = await db('admin_users').whereRaw('lower(email) = lower(?)', ['backup-admin@old.example']).first();
      expect(a).toBeTruthy();
      expect(a.password_hash).toBe('HASH_A');

      // 5c. The current account SURVIVES the override, with its own credentials.
      const b = await db('admin_users').whereRaw('lower(email) = lower(?)', ['current-admin@new.example']).first();
      expect(b).toBeTruthy();
      expect(b.password_hash).toBe('HASH_B');
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it('overwrites a backup admin that collides with the current account email', async () => {
    // Source has an admin at the SAME email the current operator will use.
    await db('admin_users').del();
    await db('admin_users').insert(adminRow('shared@example.com', 'OLD_HASH'));
    await setMarker('collision_case');
    const { filePath } = await createPicpeak({ includePhotos: false });

    try {
      // Reinstall: current admin uses the same email but a NEW password.
      await db('admin_users').del();
      const [id] = await db('admin_users').insert(adminRow('shared@example.com', 'NEW_HASH')).returning('id');
      const currentAdminId = typeof id === 'object' ? id.id : id;

      await importFromPicpeak({ picpeakPath: filePath, currentAdminId });

      // Exactly one admin at that email, and it keeps the CURRENT password.
      const rows = await db('admin_users').whereRaw('lower(email) = lower(?)', ['shared@example.com']);
      expect(rows).toHaveLength(1);
      expect(rows[0].password_hash).toBe('NEW_HASH');
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it('restores files/ and reports filesRestored', async () => {
    // A business-doc that lives in storage → travels in the backup.
    const docDir = path.join(tmpDir, 'business-docs');
    const marker = path.join(docDir, 'roundtrip-doc.txt');
    fs.mkdirSync(docDir, { recursive: true });
    fs.writeFileSync(marker, 'hello');
    await db('admin_users').del();
    const [id] = await db('admin_users').insert(adminRow('files@example.com', 'H')).returning('id');
    const currentAdminId = typeof id === 'object' ? id.id : id;

    const { filePath } = await createPicpeak({ includePhotos: false });
    try {
      fs.rmSync(marker); // delete on disk so the restore must bring it back
      const result = await importFromPicpeak({ picpeakPath: filePath, currentAdminId });
      expect(result.filesRestored).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(marker)).toBe(true);
      expect(fs.readFileSync(marker, 'utf8')).toBe('hello');
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
      fs.rmSync(docDir, { recursive: true, force: true });
    }
  });
});

describe('.picpeak manifest validation', () => {
  it('rejects a database-engine mismatch', async () => {
    // Harness runs on SQLite, so a pg manifest must be refused.
    const blockers = await validateManifest({
      kind: 'picpeak-backup', format: 1, database: { engine: 'pg' }, tables: {},
    });
    expect(blockers.some((b) => /engine/i.test(b))).toBe(true);
  });

  it('rejects a backup from a newer schema (forward-only)', async () => {
    // validateManifest reads knex_migrations for the target's latest migration;
    // the harness has none, so create it with an older migration than the backup.
    await db.schema.createTable('knex_migrations', (t) => {
      t.increments('id');
      t.string('name');
      t.integer('batch');
      t.timestamp('migration_time');
    });
    try {
      await db('knex_migrations').insert({ name: '100_baseline', batch: 1 });
      const blockers = await validateManifest({
        kind: 'picpeak-backup', format: 1,
        database: { engine: 'sqlite', latest_migration: '999_from_the_future' },
        tables: {},
      });
      expect(blockers.some((b) => /newer/i.test(b))).toBe(true);
    } finally {
      await db.schema.dropTableIfExists('knex_migrations');
    }
  });

  it('rejects a file that is not a PicPeak backup', async () => {
    const blockers = await validateManifest({ some: 'random-json' });
    expect(blockers.length).toBeGreaterThan(0);
  });
});
