/**
 * Migration 269: team members on a gallery and review of their uploads
 * (issue 743). Guarded on every table and column, so it is a no-op on a
 * second run; down() removes exactly what up() added.
 */
const knex = require('knex');
const migration = require('../../migrations/core/269_event_admin_assignments_and_upload_review');

describe('migration 269 on SQLite', () => {
  let db;

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('admin_users', (t) => {
      t.increments('id').primary();
      t.string('username');
    });
    await db.schema.createTable('events', (t) => {
      t.increments('id').primary();
      t.string('slug');
      t.integer('created_by');
    });
    await db.schema.createTable('photos', (t) => {
      t.increments('id').primary();
      t.integer('event_id');
      t.string('filename');
      t.string('visibility');
    });
  });

  afterEach(async () => { await db.destroy(); });

  it('adds the table and columns, keeps existing events out of review, and runs again', async () => {
    await db('events').insert({ slug: 'existing', created_by: null });
    await migration.up(db);

    expect(await db.schema.hasTable('event_admin_assignments')).toBe(true);
    expect(await db.schema.hasColumn('events', 'review_contributor_uploads')).toBe(true);
    expect(await db.schema.hasColumn('photos', 'moderation_status')).toBe(true);
    expect(await db.schema.hasColumn('photos', 'uploaded_by_admin_id')).toBe(true);
    expect(Boolean((await db('events').first()).review_contributor_uploads)).toBe(false);
    await expect(migration.up(db)).resolves.toBeUndefined();

    await db('admin_users').insert({ id: 5, username: 'anna' });
    await db('event_admin_assignments').insert({ event_id: 1, admin_user_id: 5 });
    await expect(db('event_admin_assignments').insert({ event_id: 1, admin_user_id: 5 })).rejects.toThrow(/UNIQUE/);

    await db('photos').insert({ event_id: 1, filename: 'a.jpg', visibility: 'hidden', moderation_status: 'pending', uploaded_by_admin_id: 5 });
    expect(await db('photos').whereNull('moderation_status').count({ c: '*' }).first()).toEqual({ c: 0 });
  });

  it('down() removes them, and is a no-op without them', async () => {
    await migration.up(db);
    await migration.down(db);
    expect(await db.schema.hasTable('event_admin_assignments')).toBe(false);
    expect(await db.schema.hasColumn('events', 'review_contributor_uploads')).toBe(false);
    expect(await db.schema.hasColumn('photos', 'moderation_status')).toBe(false);
    expect(await db.schema.hasColumn('photos', 'uploaded_by_admin_id')).toBe(false);
    await expect(migration.down(db)).resolves.toBeUndefined();
  });

  it('grants photos.review to the roles running galleries, and the boot self-heal re-seeds it', async () => {
    await db.schema.createTable('roles', (t) => { t.increments('id').primary(); t.string('name'); });
    await db.schema.createTable('permissions', (t) => {
      t.increments('id').primary(); t.string('name'); t.string('display_name'); t.string('category'); t.text('description');
    });
    await db.schema.createTable('role_permissions', (t) => { t.integer('role_id'); t.integer('permission_id'); });
    for (const name of ['super_admin', 'editor', 'team_photographer']) await db('roles').insert({ name });
    for (const name of ['photos.edit', 'events.edit']) await db('permissions').insert({ name });
    const id = async (table, name) => (await db(table).where({ name }).first()).id;
    const grant = async (role, perm) => db('role_permissions').insert({ role_id: await id('roles', role), permission_id: await id('permissions', perm) });
    await grant('editor', 'photos.edit');
    await grant('editor', 'events.edit');
    // Holds photos.edit but not events.edit: its uploads are the reviewed ones.
    await grant('team_photographer', 'photos.edit');
    const holders = async () => (await db('role_permissions')
      .join('roles', 'roles.id', 'role_permissions.role_id')
      .join('permissions', 'permissions.id', 'role_permissions.permission_id')
      .where('permissions.name', 'photos.review')
      .pluck('roles.name')).sort();

    await migration.up(db);
    await migration.up(db);
    expect(await holders()).toEqual(['editor', 'super_admin']);

    // A restored pre-269 backup has no such permission; boot puts it back.
    await db('role_permissions').where({ permission_id: await id('permissions', 'photos.review') }).del();
    await db('permissions').where({ name: 'photos.review' }).del();
    await require('../../src/services/_permissionsBoot').seedPermissionsAtBoot(db, null);
    expect(await holders()).toEqual(['editor', 'super_admin']);
  });

  it('does nothing without the base tables', async () => {
    await db.schema.dropTable('photos');
    await db.schema.dropTable('events');
    await expect(migration.up(db)).resolves.toBeUndefined();
    expect(await db.schema.hasTable('event_admin_assignments')).toBe(false);
  });
});
