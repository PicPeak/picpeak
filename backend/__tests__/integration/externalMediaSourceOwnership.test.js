const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');
const sharp = require('sharp');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('./helpers/crmDb');
const { formatBoolean } = require('../../src/utils/dbCompat');

describe('external media source ownership', () => {
  let db, cleanup, tmp, app, rootId, aliceId, bobId, rootToken, aliceToken, bobToken, access, importer, watcher;
  let sequence = 0;
  const call = (method, url, token = aliceToken, body) => {
    const req = request(app)[method](url).set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  const source = (folder, owner, token = rootToken) => call('put', '/external/sources', token, { path: folder, owner_id: owner });
  const event = async (created_by, overrides = {}) => {
    const row = {
      slug: `acl-${++sequence}`, event_type: 'wedding', event_name: 'ACL fixture', event_date: '2026-10-08',
      host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid', password_hash: 'x',
      share_link: `/acl/${sequence}`, expires_at: new Date(Date.now() + 3600000).toISOString(),
      is_active: 1, is_archived: 0, created_by, ...overrides,
    };
    for (const key of ['is_active', 'is_archived', 'external_watch']) {
      if (Object.prototype.hasOwnProperty.call(row, key)) row[key] = formatBoolean(Boolean(row[key]));
    }
    const [{ id }] = await db('events').insert(row).returning('id');
    return id;
  };
  const importInto = (id, external_path, token = aliceToken) => call('post', `/external/events/${id}/import-external`, token, { external_path });

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-owned-source-acl-'));
    process.env.EXTERNAL_MEDIA_ROOT = path.join(tmp, 'media');
    await fs.mkdir(process.env.EXTERNAL_MEDIA_ROOT, { recursive: true });
    process.env.JWT_SECRET = 'owned-external-source-test-secret-32-characters';
    process.env.EXTERNAL_MEDIA_WATCH_SWEEP_INTERVAL_MS = '0';
    process.env.EXTERNAL_MEDIA_WATCH_RECONCILE_INTERVAL_MS = '3600000';
    process.env.EXTERNAL_MEDIA_WATCH_STABILITY_MS = '0';
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId: rootId } = await seedMinimal(db));
    await assignAdminRole(db, rootId);
    const [{ id: roleId }] = await db('roles').insert({ name: 'external_source_test', display_name: 'External source test' }).returning('id');
    const permissions = await db('permissions').whereIn('name', ['photos.view', 'photos.upload', 'photos.download', 'events.edit', 'events.manage_all']).select('id');
    for (const p of permissions) await db('role_permissions').insert({ role_id: roleId, permission_id: p.id });
    const addAdmin = async (username) => {
      const [{ id }] = await db('admin_users').insert({
        username, email: `${username}@fixture.invalid`, password_hash: 'x', role_id: roleId, is_active: formatBoolean(true), must_change_password: formatBoolean(false),
      }).returning('id');
      return id;
    };
    aliceId = await addAdmin('acl-alice'); bobId = await addAdmin('acl-bob');
    rootToken = mintAdminToken(rootId); aliceToken = mintAdminToken(aliceId); bobToken = mintAdminToken(bobId);
    app = express(); app.use(express.json());
    app.use('/external', require('../../src/routes/adminExternalMedia'));
    app.use('/events', require('../../src/routes/adminEvents'));
    access = require('../../src/services/externalMediaAccess');
    importer = require('../../src/services/externalImportService');
    watcher = require('../../src/services/externalMediaWatcher');
    const jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'white' } }).jpeg().toBuffer();
    for (const name of ['alice', 'bob', 'unassigned']) {
      await fs.mkdir(path.join(process.env.EXTERNAL_MEDIA_ROOT, 'tenants', name, 'batch'), { recursive: true });
      await fs.writeFile(path.join(process.env.EXTERNAL_MEDIA_ROOT, 'tenants', name, 'batch', 'control.jpg'), jpeg);
    }
    await access.assignSource(rootId, 'tenants/alice', aliceId);
    await access.assignSource(rootId, 'tenants/bob', bobId);
  });

  afterAll(async () => {
    if (watcher) await watcher.stopExternalMediaWatcher();
    if (cleanup) await cleanup();
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  test('scoped virtual root shows only approved roots, not global ancestors or siblings', async () => {
    const result = await call('get', '/external/list');
    expect(result.status).toBe(200);
    expect(result.body.entries).toEqual([{ name: 'tenants/alice', path: 'tenants/alice', type: 'dir' }]);
    expect((await call('get', '/external/list?path=tenants')).status).toBe(403);
    expect((await call('get', '/external/list?path=tenants/bob')).status).toBe(403);
    expect((await call('get', '/external/list?path=tenants/alice')).status).toBe(200);
  });

  test('original foreign-source trigger cannot add another owner’s original to an owned gallery', async () => {
    const id = await event(aliceId);
    expect((await importInto(id, 'tenants/bob')).status).toBe(403);
    expect(await db('photos').where({ event_id: id })).toEqual([]);
    expect((await importInto(id, 'tenants/unassigned')).status).toBe(403);
  });

  test('approved ordinary import keeps originals, thumbnail generation and root-relative second-folder semantics', async () => {
    const id = await event(aliceId);
    const imported = await importInto(id, 'tenants/alice');
    expect(imported.status).toBe(200); expect(imported.body.imported).toBe(1);
    const photo = await db('photos').where({ event_id: id }).first();
    expect(photo.external_relpath).toBe(path.join('tenants', 'alice', 'batch', 'control.jpg'));
    expect(photo.width).toBe(16); expect(photo.height).toBe(16); expect(photo.thumbnail_path).toBeTruthy();
    const before = require('../../src/services/photoResolver').resolvePhotoFilePath(await db('events').where({ id }).first(), photo);
    expect((await importInto(id, 'tenants/alice/batch')).body.imported).toBe(0);
    const after = require('../../src/services/photoResolver').resolvePhotoFilePath(await db('events').where({ id }).first(), photo);
    expect(after).toBe(before); expect((await fs.stat(after)).size).toBeGreaterThan(0);
  });

  test('gallery-wide management and ownerless destination fallback cannot forward source originals', async () => {
    expect((await importInto(await event(bobId), 'tenants/alice')).status).toBe(403);
    expect((await importInto(await event(null), 'tenants/alice')).status).toBe(403);
    expect((await importInto(await event(bobId), 'tenants/alice', rootToken)).status).toBe(200);
  });

  test('untrusted actor roleName and missing manual actor cannot elevate the shared service', async () => {
    const id = await event(aliceId);
    await expect(importer.importExternalFolder({ eventId: id, externalPath: 'tenants/bob', actor: { type: 'admin', id: aliceId, roleName: 'super_admin' } }))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(importer.importExternalFolder({ eventId: id, externalPath: 'tenants/alice' })).rejects.toMatchObject({ statusCode: 403 });
  });

  test('only SuperAdmin can assign/transfer/revoke, and overlapping grants are refused atomically', async () => {
    expect((await source('tenants/unassigned', aliceId, aliceToken)).status).toBe(403);
    expect((await source('tenants', aliceId)).status).toBe(409);
    const outcomes = await Promise.all([source('tenants/unassigned', aliceId), source('tenants/unassigned/batch', bobId)]);
    expect(outcomes.map((r) => r.status).sort()).toEqual([200, 409]);
    const rows = await db('external_media_sources').where('path', 'like', 'tenants/unassigned%');
    expect(rows).toHaveLength(1);
    expect((await call('delete', `/external/sources/${rows[0].id}`, aliceToken)).status).toBe(403);
    expect((await call('delete', `/external/sources/${rows[0].id}`, rootToken)).status).toBe(200);
  });

  test('alternate representations and symlinks cannot cross the approved source boundary inside the global mount', async () => {
    for (const value of ['tenants/alice/../bob', '/tenants/alice', 'tenants\\bob', ['tenants/alice']]) {
      await expect(access.authorizeSource(aliceId, value)).rejects.toMatchObject({ statusCode: 400 });
    }
    const link = path.join(process.env.EXTERNAL_MEDIA_ROOT, 'tenants', 'alice', 'link');
    await fs.symlink(path.join(process.env.EXTERNAL_MEDIA_ROOT, 'tenants', 'bob'), link);
    try {
      expect((await call('get', '/external/list?path=tenants/alice/link')).status).toBe(400);
      expect((await importInto(await event(aliceId), 'tenants/alice/link')).status).toBe(400);
      const result = await call('get', '/external/list?path=tenants/alice');
      expect(result.body.entries.some((entry) => entry.name === 'link')).toBe(false);
    } finally { await fs.unlink(link); }
  });

  test('source configuration and watcher activation enforce source access before the event write', async () => {
    const id = await event(aliceId);
    const denied = await call('put', `/events/${id}`, aliceToken, { source_mode: 'reference', external_path: 'tenants/bob', external_watch: true });
    expect(denied.status).toBe(403);
    expect((await db('events').where({ id }).first()).external_path).toBeFalsy();
    const allowed = await call('put', `/events/${id}`, aliceToken, { source_mode: 'reference', external_path: 'tenants/alice', external_watch: true });
    expect(allowed.status).toBe(200);
    await watcher.reconcile();
    expect(watcher.watchedEventIds()).toContain(id);
    expect(await db('photos').where({ event_id: id })).toHaveLength(1);
    await watcher.stopExternalMediaWatcher();
  });

  test('automatic imports derive the live destination owner, not a claimed system/root actor', async () => {
    const id = await event(aliceId, { source_mode: 'reference', external_path: 'tenants/bob', external_watch: 1 });
    await expect(importer.importExternalFolder({ eventId: id, externalPath: 'tenants/bob', automatic: true, actor: { type: 'admin', id: rootId } }))
      .rejects.toMatchObject({ statusCode: 403 });
    await watcher.reconcile();
    expect(watcher.watchedEventIds()).not.toContain(id);
    await watcher.stopExternalMediaWatcher();
  });

  test('revoking or transferring a source stops later imports and watcher registration without deleting existing galleries', async () => {
    const id = await event(aliceId, { source_mode: 'reference', external_path: 'tenants/alice', external_watch: 1 });
    expect((await importInto(id, 'tenants/alice')).status).toBe(200);
    await watcher.reconcile(); expect(watcher.watchedEventIds()).toContain(id);
    expect((await source('tenants/alice', bobId)).status).toBe(200);
    try {
      expect((await importInto(id, 'tenants/alice')).status).toBe(403);
      await watcher.reconcile(); expect(watcher.watchedEventIds()).not.toContain(id);
      expect(await db('photos').where({ event_id: id })).toHaveLength(1);
      expect((await call('get', '/external/list', bobToken)).body.entries).toHaveLength(2);
    } finally {
      await source('tenants/alice', aliceId);
      await watcher.stopExternalMediaWatcher();
    }
  });

  test('guarded migration repeats without granting historical source paths', async () => {
    const migration = require('../../migrations/core/269_external_media_source_owners');
    const before = await db('external_media_sources').orderBy('id');
    await migration.up(db); await migration.up(db);
    expect(await db('external_media_sources').orderBy('id')).toEqual(before);
  });

  test('assignments reseed serialization after an older backup clears the migration-seeded lock', async () => {
    await db('external_media_source_lock').del();
    const outcomes = await Promise.all([source('tenants/unassigned', aliceId), source('tenants/unassigned/batch', bobId)]);
    expect(outcomes.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db('external_media_source_lock').where({ id: 1 })).toHaveLength(1);
    const rows = await db('external_media_sources').where('path', 'like', 'tenants/unassigned%');
    expect(rows).toHaveLength(1);
    await access.revokeSource(rootId, rows[0].id);
  });

  test('alternate-case source columns cannot bypass the source configuration guard on SQLite', async () => {
    const id = await event(aliceId);
    const result = await call('put', `/events/${id}`, aliceToken, { External_Path: 'tenants/bob', External_Watch: true, Source_Mode: 'reference' });
    expect(result.status).toBe(200);
    const current = await db('events').where({ id }).first();
    expect(current.external_path).toBeFalsy(); expect(Boolean(current.external_watch)).toBe(false);
    expect(current.source_mode).not.toBe('reference');
  });

  test('a granted root replaced with a symlink into another tenant fails closed', async () => {
    const eventId = await event(aliceId);
    expect((await importInto(eventId, 'tenants/alice')).status).toBe(200);
    const photo = await db('photos').where({ event_id: eventId }).first();
    const gallery = await db('events').where({ id: eventId }).first();
    const original = path.join(process.env.EXTERNAL_MEDIA_ROOT, 'tenants', 'alice');
    const parked = path.join(tmp, 'parked-alice');
    await fs.rename(original, parked);
    await fs.symlink(path.join(process.env.EXTERNAL_MEDIA_ROOT, 'tenants', 'bob'), original);
    try {
      expect((await call('get', '/external/list?path=tenants/alice')).status).toBe(403);
      expect((await importInto(await event(aliceId), 'tenants/alice')).status).toBe(403);
      expect(() => require('../../src/services/photoResolver').resolvePhotoFilePath(gallery, photo)).toThrow();
    } finally { await fs.unlink(original); await fs.rename(parked, original); }
  });

  test('live permission and account revocation prevent background imports despite an unchanged source grant', async () => {
    const id = await event(aliceId, { source_mode: 'reference', external_path: 'tenants/alice', external_watch: 1 });
    const upload = await db('permissions').where({ name: 'photos.upload' }).first();
    const account = await db('admin_users').where({ id: aliceId }).first();
    await db('role_permissions').where({ role_id: account.role_id, permission_id: upload.id }).del();
    try {
      await expect(access.authorizeImport(id, 'tenants/alice', { automatic: true })).rejects.toMatchObject({ statusCode: 403 });
    } finally { await db('role_permissions').insert({ role_id: account.role_id, permission_id: upload.id }); }
    await db('admin_users').where({ id: aliceId }).update({ is_active: formatBoolean(false) });
    try {
      await expect(access.authorizeImport(id, 'tenants/alice', { automatic: true })).rejects.toMatchObject({ statusCode: 403 });
    } finally { await db('admin_users').where({ id: aliceId }).update({ is_active: formatBoolean(true) }); }
  });

});
