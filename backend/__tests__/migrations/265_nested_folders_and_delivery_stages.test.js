/**
 * Migration 265 — nested folders + delivery stages.
 *
 *   - folders.manage goes to every role holding settings.edit (folder editing
 *     needed settings.edit before) and to super_admin; nobody else gains it.
 *   - folder membership moves from category_id to folder_id; plain filter
 *     categories stay where they are.
 *   - re-running up() changes nothing.
 */
const path = require('path'), fs = require('fs'), os = require('os');
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-mig265-')), 'db.sqlite');
process.env.JWT_SECRET = 'mig';
const { bootCrmDb } = require('../integration/helpers/crmDb');
const mig = require('../../migrations/core/265_nested_folders_and_delivery_stages');

async function holders(db, perm) {
  return (await db('role_permissions')
    .join('roles', 'roles.id', 'role_permissions.role_id')
    .join('permissions', 'permissions.id', 'role_permissions.permission_id')
    .where('permissions.name', perm)
    .pluck('roles.name')).sort();
}

async function addRole(db, name, perms) {
  await db('roles').insert({ name, display_name: name, is_system: false, priority: 10, created_at: new Date(), updated_at: new Date() });
  const role = await db('roles').where({ name }).first();
  const ids = (await db('permissions').whereIn('name', perms).select('id')).map((p) => p.id);
  if (ids.length) await db('role_permissions').insert(ids.map((id) => ({ role_id: role.id, permission_id: id })));
}

const idOf = (r) => r[0]?.id ?? r[0];

describe('migration 265', () => {
  let db, cleanup, eventId;
  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    // The template is migrated to the latest; roll back what sits on top of
    // 265's columns first, as a real rollback would (SQLite rebuilds the
    // table on dropColumn and cannot re-create 285's index on parent_id).
    await require('../../migrations/core/285_folder_sibling_name_unique').down(db);
    eventId = idOf(await db('events').insert({
      slug: 'm265', event_type: 'wedding', event_name: 'M265', event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: '/gallery/m265/s', share_token: 'm265', expires_at: new Date(Date.now() + 864e5).toISOString(),
      created_at: new Date().toISOString(),
    }).returning('id'));
  }, 120000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('grants folders.manage to settings.edit holders and super_admin only', async () => {
    await mig.down(db);
    await addRole(db, 'custom_settings', ['settings.view', 'settings.edit']);
    await addRole(db, 'custom_uploader', ['photos.view', 'photos.upload']);
    const settingsEditHolders = await holders(db, 'settings.edit');

    await mig.up(db);
    const got = await holders(db, 'folders.manage');
    const expected = [...new Set([...settingsEditHolders, 'super_admin'])].sort();
    expect(got).toEqual(expected);
    expect(got).toContain('custom_settings');
    expect(got).not.toContain('custom_uploader');
    expect(got).not.toContain('team_photographer');
  });

  it('moves folder membership to folder_id and leaves filter categories alone', async () => {
    await mig.down(db);
    const folder = idOf(await db('photo_categories').insert({ name: 'Selects', slug: 'selects', is_global: 0, event_id: eventId, is_folder: 1 }).returning('id'));
    const filter = idOf(await db('photo_categories').insert({ name: 'Portraits', slug: 'portraits', is_global: 0, event_id: eventId, is_folder: 0 }).returning('id'));
    const mk = async (filename, categoryId) => idOf(await db('photos').insert({
      event_id: eventId, filename, path: `m265/${filename}`, type: 'individual', category_id: categoryId,
    }).returning('id'));
    const inFolder = await mk('a.jpg', folder);
    const inFilter = await mk('b.jpg', filter);
    const loose = await mk('c.jpg', null);

    await mig.up(db);
    const rows = Object.fromEntries((await db('photos').whereIn('id', [inFolder, inFilter, loose])
      .select('id', 'category_id', 'folder_id')).map((r) => [r.id, r]));
    expect(rows[inFolder]).toMatchObject({ category_id: null, folder_id: folder });
    expect(rows[inFilter]).toMatchObject({ category_id: filter, folder_id: null });
    expect(rows[loose]).toMatchObject({ category_id: null, folder_id: null });

    // down() puts the folder back into category_id.
    await mig.down(db);
    expect((await db('photos').where('id', inFolder).first()).category_id).toBe(folder);
    await mig.up(db);
  });

  it('leaves photos of a global is_folder category in category_id (review concern 3)', async () => {
    await mig.down(db);
    const global = idOf(await db('photo_categories').insert({ name: 'Selects', slug: `g-${Date.now()}`, is_global: 1, event_id: null, is_folder: 1 }).returning('id'));
    const photo = idOf(await db('photos').insert({
      event_id: eventId, filename: 'g.jpg', path: 'm265/g.jpg', type: 'individual', category_id: global,
    }).returning('id'));
    await mig.up(db);
    expect(await db('photos').where('id', photo).first()).toMatchObject({ category_id: global, folder_id: null });
  });

  it('defaults existing events to no folder structure and complete delivery', async () => {
    const ev = await db('events').where('id', eventId).first();
    expect(Boolean(ev.folder_structure)).toBe(false);
    expect(ev.delivery_status).toBe('complete');
  });

  it('is idempotent', async () => {
    const before = await holders(db, 'folders.manage');
    await mig.up(db);
    expect(await holders(db, 'folders.manage')).toEqual(before);
  });

  it('keeps one open request per path and event', async () => {
    await db('folder_requests').insert({ event_id: eventId, path: 'Saturday', status: 'pending' });
    await expect(db('folder_requests').insert({ event_id: eventId, path: 'Saturday', status: 'pending' })).rejects.toThrow();
    await db('folder_requests').where({ event_id: eventId }).update({ status: 'rejected' });
    await db('folder_requests').insert({ event_id: eventId, path: 'Saturday', status: 'pending' });
  });
});
