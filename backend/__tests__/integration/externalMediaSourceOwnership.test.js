const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');
const sharp = require('sharp');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('./helpers/crmDb');
const { formatBoolean } = require('../../src/utils/dbCompat');

describe('external media source ownership', () => {
  let db, cleanup, tmp, app, rootId, aliceId, bobId, danaId, rootToken, aliceToken, bobToken, danaToken, access, importer, watcher;
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
    // Dana holds no source grant.
    danaId = await addAdmin('acl-dana');
    rootToken = mintAdminToken(rootId); aliceToken = mintAdminToken(aliceId); bobToken = mintAdminToken(bobId); danaToken = mintAdminToken(danaId);
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
    await fs.mkdir(path.join(process.env.EXTERNAL_MEDIA_ROOT, 'tenants', 'unassigned', '2026-05-01 12:00'), { recursive: true });
    await fs.writeFile(path.join(process.env.EXTERNAL_MEDIA_ROOT, 'tenants', 'unassigned', '2026-05-01 12:00', 'late.jpg'), jpeg);
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

  test('whoever may manage a gallery may import from the folder it is already bound to, never bind a foreign one', async () => {
    const bobs = await event(bobId, { source_mode: 'reference', external_path: 'tenants/bob' });
    expect((await importInto(bobs, 'tenants/bob')).status).toBe(403);
    await expect(access.authorizeImport(bobs, 'tenants/bob', { actor: { type: 'admin', id: aliceId } })).rejects.toMatchObject({ statusCode: 403 });
    expect((await importInto(bobs, 'tenants/bob', rootToken)).status).toBe(200);
    // An ownerless gallery is everyone's to manage, as on the event routes.
    const ownerless = await event(null, { source_mode: 'reference', external_path: 'tenants/bob' });
    expect((await importInto(ownerless, 'tenants/bob', danaToken)).status).toBe(200);
    expect((await importInto(ownerless, 'tenants/unassigned', danaToken)).status).toBe(403);
    expect((await db('events').where({ id: ownerless }).first()).external_path).toBe('tenants/bob');
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
    for (const value of ['tenants/alice/../bob', 'tenants\\bob', ['tenants/alice']]) {
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

  test('a gallery keeps watching and importing the folder it was bound to before source grants', async () => {
    // Nobody holds a grant on tenants/unassigned: the binding predates them.
    const owned = await event(danaId, { source_mode: 'reference', external_path: 'tenants/unassigned/batch', external_watch: 1 });
    const ownerless = await event(null, { source_mode: 'reference', external_path: 'tenants/unassigned/batch', external_watch: 1 });
    await expect(importer.importExternalFolder({ eventId: owned, externalPath: 'tenants/unassigned/batch', automatic: true }))
      .resolves.toMatchObject({ imported: 1 });
    await watcher.reconcile();
    expect(watcher.watchedEventIds()).toEqual(expect.arrayContaining([owned, ownerless]));
    expect(await db('photos').where({ event_id: ownerless })).toHaveLength(1);
    expect((await importInto(owned, 'tenants/unassigned/batch', danaToken)).status).toBe(200);
    await watcher.stopExternalMediaWatcher();
  });

  test('an automatic import of any other folder still needs the owner’s grant, whatever actor is claimed', async () => {
    const id = await event(aliceId, { source_mode: 'reference', external_path: 'tenants/alice', external_watch: 1 });
    await expect(importer.importExternalFolder({ eventId: id, externalPath: 'tenants/bob', automatic: true, actor: { type: 'admin', id: rootId } }))
      .rejects.toMatchObject({ statusCode: 403 });
    const ownerless = await event(null, { source_mode: 'reference', external_path: 'tenants/alice', external_watch: 1 });
    await expect(importer.importExternalFolder({ eventId: ownerless, externalPath: 'tenants/bob', automatic: true }))
      .rejects.toMatchObject({ statusCode: 403 });
    // A managed gallery has no binding to fall back on.
    const managed = await event(danaId, { source_mode: 'managed', external_path: 'tenants/unassigned' });
    await expect(access.authorizeImport(managed, 'tenants/unassigned', { automatic: true })).rejects.toMatchObject({ statusCode: 403 });
  });

  test('a refused watcher is reported once, at warn, with the gallery and the folder', async () => {
    const logger = require('../../src/utils/logger');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const id = await event(aliceId, { slug: 'acl-refused-watch', source_mode: 'reference', external_path: 'tenants/alice/../bob', external_watch: 1 });
    try {
      await watcher.reconcile();
      await watcher.reconcile();
      expect(watcher.watchedEventIds()).not.toContain(id);
      const lines = warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes(`event ${id} (acl-refused-watch)`));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('\'tenants/alice/../bob\'');
      expect(lines[0]).toContain('Invalid external media path');
    } finally {
      await db('events').where({ id }).update({ external_watch: formatBoolean(false) });
      warn.mockRestore();
      await watcher.stopExternalMediaWatcher();
    }
  });

  test('revoking or transferring a source stops browsing and new bindings, not the galleries already bound to it', async () => {
    const id = await event(aliceId, { source_mode: 'reference', external_path: 'tenants/alice', external_watch: 1 });
    expect((await importInto(id, 'tenants/alice')).status).toBe(200);
    await watcher.reconcile(); expect(watcher.watchedEventIds()).toContain(id);
    expect((await source('tenants/alice', bobId)).status).toBe(200);
    try {
      expect((await call('get', '/external/list?path=tenants/alice')).status).toBe(403);
      expect((await importInto(await event(aliceId), 'tenants/alice')).status).toBe(403);
      expect((await importInto(id, 'tenants/alice/batch')).status).toBe(403);
      expect((await importInto(id, 'tenants/alice')).status).toBe(200);
      await watcher.reconcile(); expect(watcher.watchedEventIds()).toContain(id);
      expect(await db('photos').where({ event_id: id })).toHaveLength(1);
      expect((await call('get', '/external/list', bobToken)).body.entries).toHaveLength(2);
    } finally {
      await source('tenants/alice', aliceId);
      await watcher.stopExternalMediaWatcher();
    }
  });

  test('guarded migration repeats without granting historical source paths', async () => {
    const migration = require('../../migrations/core/243_external_media_source_owners');
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
    const original = path.join(process.env.EXTERNAL_MEDIA_ROOT, 'tenants', 'alice');
    const parked = path.join(tmp, 'parked-alice');
    await fs.rename(original, parked);
    await fs.symlink(path.join(process.env.EXTERNAL_MEDIA_ROOT, 'tenants', 'bob'), original);
    try {
      expect((await call('get', '/external/list?path=tenants/alice')).status).toBe(403);
      expect((await importInto(await event(aliceId), 'tenants/alice')).status).toBe(403);
    } finally { await fs.unlink(original); await fs.rename(parked, original); }
  });

  test('a bound gallery keeps importing when its creator loses photos.upload or is deactivated; interactive actions do not', async () => {
    const id = await event(aliceId, { source_mode: 'reference', external_path: 'tenants/alice', external_watch: 1 });
    const upload = await db('permissions').where({ name: 'photos.upload' }).first();
    const account = await db('admin_users').where({ id: aliceId }).first();
    await db('role_permissions').where({ role_id: account.role_id, permission_id: upload.id }).del();
    try {
      await expect(access.authorizeImport(id, 'tenants/alice', { automatic: true })).resolves.toMatchObject({ relativePath: 'tenants/alice' });
      await expect(access.authorizeImport(id, 'tenants/alice', { actor: { type: 'admin', id: aliceId } })).rejects.toMatchObject({ statusCode: 403 });
    } finally { await db('role_permissions').insert({ role_id: account.role_id, permission_id: upload.id }); }
    await db('admin_users').where({ id: aliceId }).update({ is_active: formatBoolean(false) });
    try {
      await expect(importer.importExternalFolder({ eventId: id, externalPath: 'tenants/alice', automatic: true })).resolves.toMatchObject({ imported: 1 });
      await watcher.reconcile();
      expect(watcher.watchedEventIds()).toContain(id);
      await expect(access.authorizeImport(id, 'tenants/alice', { actor: { type: 'admin', id: aliceId } })).rejects.toMatchObject({ statusCode: 403 });
      // Any other folder is a new binding and still needs a live creator.
      await expect(access.authorizeImport(id, 'tenants/alice/batch', { automatic: true })).rejects.toMatchObject({ statusCode: 403 });
    } finally {
      await db('admin_users').where({ id: aliceId }).update({ is_active: formatBoolean(true) });
      await watcher.stopExternalMediaWatcher();
    }
  });

  test('saving a reference gallery without changing its folder needs no source grant', async () => {
    const id = await event(danaId, { source_mode: 'reference', external_path: 'tenants/unassigned', external_watch: 1 });
    const expires = new Date(Date.now() + 7 * 86400000).toISOString();
    // What the event form sends: the source fields ride along on every save.
    const saved = await call('put', `/events/${id}`, danaToken, {
      event_name: 'Renamed', expires_at: expires, source_mode: 'reference', external_path: 'tenants/unassigned', external_watch: true,
    });
    expect(saved.status).toBe(200);
    let row = await db('events').where({ id }).first();
    expect(row.event_name).toBe('Renamed');
    expect(new Date(row.expires_at).toISOString()).toBe(expires);
    expect(row.external_path).toBe('tenants/unassigned'); expect(Boolean(row.external_watch)).toBe(true);

    const moved = await call('put', `/events/${id}`, danaToken, { event_name: 'Moved', source_mode: 'reference', external_path: 'tenants/bob', external_watch: true });
    expect(moved.status).toBe(403);
    row = await db('events').where({ id }).first();
    expect(row.event_name).toBe('Renamed'); expect(row.external_path).toBe('tenants/unassigned');

    // Switching a managed gallery to a folder is a new binding, even to a path left on the row.
    const managed = await event(danaId, { source_mode: 'managed', external_path: 'tenants/unassigned' });
    expect((await call('put', `/events/${managed}`, danaToken, { source_mode: 'reference', external_path: 'tenants/unassigned' })).status).toBe(403);
    // Back to managed uploads asks for nothing.
    expect((await call('put', `/events/${id}`, danaToken, { source_mode: 'managed' })).status).toBe(200);
    expect((await db('events').where({ id }).first()).external_path).toBeNull();
  });

  test('a leading slash and a colon in a folder name are accepted, stored or new', async () => {
    expect(access.normalizeSourcePath('/tenants//unassigned/')).toBe('tenants/unassigned');
    expect(access.normalizeSourcePath('tenants/unassigned/2026-05-01 12:00')).toBe('tenants/unassigned/2026-05-01 12:00');
    for (const value of ['tenants\\bob', 'C:\\tenants', 'tenants/../bob', '/../tenants', 'tenants/\u0007bob']) {
      expect(() => access.normalizeSourcePath(value)).toThrow('Invalid external media path');
    }

    const stored = '/tenants/unassigned/2026-05-01 12:00';
    const id = await event(danaId, { source_mode: 'reference', external_path: stored, external_watch: 1 });
    // The form re-sends the stored spelling; the watcher reads it off the row.
    expect((await call('put', `/events/${id}`, danaToken, { event_name: 'Colon', source_mode: 'reference', external_path: stored, external_watch: true })).status).toBe(200);
    expect((await db('events').where({ id }).first()).external_path).toBe(stored);
    await expect(importer.importExternalFolder({ eventId: id, externalPath: stored, automatic: true })).resolves.toMatchObject({ imported: 1 });
    expect((await db('photos').where({ event_id: id }).first()).external_relpath).toBe(path.join('tenants', 'unassigned', '2026-05-01 12:00', 'late.jpg'));
    expect((await importInto(id, stored, danaToken)).status).toBe(200);
    // As new input the same spelling is accepted too, and still needs a grant.
    expect((await importInto(await event(danaId), stored, danaToken)).status).toBe(403);
    const fresh = await event(danaId);
    expect((await importInto(fresh, stored, rootToken)).status).toBe(200);
    expect((await db('events').where({ id: fresh }).first()).external_path).toBe('tenants/unassigned/2026-05-01 12:00');
    expect((await call('get', `/external/list?path=${encodeURIComponent(stored)}`, rootToken)).status).toBe(200);
  });

  test('an import authorises its source per run, not per file', async () => {
    const folder = path.join(process.env.EXTERNAL_MEDIA_ROOT, 'tenants', 'alice', 'many');
    await fs.mkdir(folder, { recursive: true });
    const jpeg = await fs.readFile(path.join(process.env.EXTERNAL_MEDIA_ROOT, 'tenants', 'alice', 'batch', 'control.jpg'));
    for (let i = 0; i < 6; i += 1) await fs.writeFile(path.join(folder, `many-${i}.jpg`), jpeg);
    const authorize = jest.spyOn(access, 'authorizeImport');
    try {
      const id = await event(aliceId);
      await expect(importer.importExternalFolder({ eventId: id, externalPath: 'tenants/alice/many', actor: { type: 'admin', id: aliceId } }))
        .resolves.toMatchObject({ imported: 6 });
      // Once at the start, once before the event row is written.
      expect(authorize).toHaveBeenCalledTimes(2);

      // Past the time budget it is checked again, and a refusal stops the run.
      authorize.mockClear();
      const realNow = Date.now;
      let skew = 0;
      const now = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + (skew += 31000));
      try {
        const again = await event(aliceId);
        await expect(importer.importExternalFolder({ eventId: again, externalPath: 'tenants/alice/many', actor: { type: 'admin', id: aliceId } }))
          .resolves.toMatchObject({ imported: 6 });
      } finally { now.mockRestore(); }
      expect(authorize.mock.calls.length).toBeGreaterThan(2);
    } finally {
      authorize.mockRestore();
      await fs.rm(folder, { recursive: true, force: true });
    }
  });

  test('source assignment routes stop a non-SuperAdmin before the service is reached', async () => {
    const assign = jest.spyOn(access, 'assignSource');
    const revoke = jest.spyOn(access, 'revokeSource');
    try {
      expect((await source('tenants/unassigned', aliceId, aliceToken)).status).toBe(403);
      expect((await call('delete', '/external/sources/1', aliceToken)).status).toBe(403);
      expect(assign).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
    } finally { assign.mockRestore(); revoke.mockRestore(); }
  });
});
