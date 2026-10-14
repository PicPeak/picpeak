/**
 * Admin hard delete against a gallery team save, on PostgreSQL (issue 1979),
 * and the team save against a gallery delete and against another team save.
 *
 * Both lock event_admin_assignments rows. The delete used to take the rows of
 * the deleted admin X, then the rows X assigned, in two statements; a team
 * save locks the removed rows of its gallery in scan order. With R = X's own
 * assignment and S = an assignment X made on the same gallery, the two could
 * hold one row each and wait for the other: 40P01, a 500 on either side.
 * Both now lock their rows in id order first. SQLite runs one writer at a
 * time and cannot interleave them.
 *
 * The interleaving is pinned with a third transaction holding S2, another row
 * X assigned, so the delete parks before it reaches S while the team save
 * runs. Not run in CI: gated on PICPEAK_PG_TEST_URL.
 */
const knex = require('knex');
const { randomUUID } = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const pgUrl = process.env.PICPEAK_PG_TEST_URL;

(pgUrl ? describe : describe.skip)('admin delete vs gallery team save (pg)', () => {
  let owner; let db; let schema; let tmpDir; let cleanup; let previousClient;
  let userManagementService; let eventAdminAssignments;

  beforeAll(async () => {
    schema = `admin_delete_lock_${randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    previousClient = process.env.DATABASE_CLIENT;
    process.env.DATABASE_CLIENT = 'pg';
    process.env.JWT_SECRET = 'admin-delete-lock-pg-test-secret-at-least-32-chars';
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-admin-delete-pg-'));
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    jest.doMock('../../knexfile', () => ({ client: 'pg', connection: pgUrl, searchPath: [schema] }));
    ({ db } = require('../../src/database/db'));
    ({ cleanup } = await require('./helpers/crmDb').bootCrmDb());
    userManagementService = require('../../src/services/userManagementService');
    eventAdminAssignments = require('../../src/services/eventAdminAssignmentsService');
  }, 180000);

  afterAll(async () => {
    await require('../../src/services/serviceShutdown').stopServices();
    if (cleanup) await cleanup(); else if (db) await db.destroy();
    if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    if (previousClient === undefined) delete process.env.DATABASE_CLIENT; else process.env.DATABASE_CLIENT = previousClient;
    jest.dontMock('../../knexfile');
  });

  // Statements on the assignments table (or another table) parked on a lock.
  const waiting = async (table = 'event_admin_assignments') => {
    const { rows } = await db.raw(
      'SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() '
      + 'AND wait_event_type = ? AND query ILIKE ?',
      ['Lock', `%${table}%`],
    );
    return Number(rows[0].n);
  };
  const until = async (done) => {
    const deadline = Date.now() + 10000;
    while (!(await done()) && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
  };

  let ownerId; let editor;
  const admin = async (name) => (await db('admin_users').insert({
    username: name, email: `${name}@example.com`, password_hash: 'x',
    role_id: editor.id, is_active: true, created_at: new Date().toISOString(),
  }).returning('id'))[0].id;
  const event = async (slug) => (await db('events').insert({
    slug, event_type: 'wedding', event_name: slug, event_date: '2026-08-01',
    host_email: 'h@example.com', admin_email: 'studio@example.com', password_hash: 'x',
    share_link: `/gallery/${slug}/share`, share_token: `${slug}-share`,
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: true, is_archived: false, is_draft: false, created_by: ownerId,
    created_at: new Date().toISOString(),
  }).returning('id'))[0].id;
  const settled = (results, name, promise) => promise.then(
    () => { results[name] = 'ok'; },
    (e) => { results[name] = e; },
  );

  test('both finish when the delete and the save need the same rows', async () => {
    ({ adminId: ownerId } = await require('./helpers/crmDb').seedMinimal(db));
    await require('./helpers/crmDb').assignAdminRole(db, ownerId, 'super_admin');
    editor = await db('roles').where({ name: 'editor' }).first();
    // Ascending ids: w < z < x.
    const w = await admin('lock-w');
    const z = await admin('lock-z');
    const x = await admin('lock-x');
    const gallery = await event('admin-delete-lock');
    const other = await event('admin-delete-lock-other');
    // Inserted one by one, so heap order matches id order: S2, S, R.
    const assign = async (eventId, adminUserId, assignedBy) => (await db('event_admin_assignments')
      .insert({ event_id: eventId, admin_user_id: adminUserId, assigned_by: assignedBy })
      .returning('id'))[0].id;
    const s2 = await assign(other, w, x);
    await assign(gallery, z, x); // S
    await assign(gallery, x, ownerId); // R

    // Hold S2: the delete parks on it.
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    let holding;
    const held = new Promise((resolve) => { holding = resolve; });
    const blocker = db.transaction(async (trx) => {
      await trx('event_admin_assignments').where({ id: s2 }).forUpdate().first();
      holding();
      await released;
    });
    await held;

    const results = {};
    const deleted = settled(results, 'delete', userManagementService.deleteAdminUser(x, ownerId));
    await until(async () => (await waiting()) >= 1);
    expect(await waiting()).toBe(1);

    // The team save removes both X and Z from the gallery: rows R and S.
    const saved = settled(results, 'save', db.transaction((trx) => eventAdminAssignments.setAssignedAdmins(gallery, [], ownerId, trx)));
    // Before the fix the save parks on R behind the delete; now the delete
    // holds no assignment row yet and the save goes through.
    await until(async () => results.save !== undefined || (await waiting()) >= 2);

    release();
    await blocker;
    await Promise.all([deleted, saved]);

    expect(results).toEqual({ delete: 'ok', save: 'ok' });
    expect(await db('admin_users').where({ id: x }).first()).toBeUndefined();
    expect(await db('event_admin_assignments').where({ event_id: gallery })).toEqual([]);
    expect((await db('event_admin_assignments').where({ id: s2 }).first()).assigned_by).toBeNull();
  }, 60000);

  // Deleting a gallery (adminEvents/helpers.js deleteEventCascade,
  // adminArchives.js) locks the event row, then deletes its assignments. The
  // save used to lock its removed rows first and take the event's key-share
  // lock last, in the insert: each held what the other wanted.
  test('a team save and a gallery delete take the event row first', async () => {
    const a = await admin('gallery-lock-a');
    const b = await admin('gallery-lock-b');
    const gallery = await event('gallery-delete-lock');
    await db('event_admin_assignments').insert({ event_id: gallery, admin_user_id: a, assigned_by: ownerId });

    // The gallery delete's opening, held: the event row, FOR UPDATE.
    const del = await db.transaction();
    await del('events').where({ id: gallery }).forUpdate().first();

    const results = {};
    // Removes A, adds B. Before the fix it locks and deletes A, then parks on
    // the event row in its insert; now it parks on the event row first.
    const saved = settled(results, 'save', db.transaction((trx) => eventAdminAssignments.setAssignedAdmins(gallery, [b], ownerId, trx)));
    await until(async () => (await waiting('events')) + (await waiting()) >= 1);

    // The delete's next step. Before the fix it waits on A: 40P01.
    const cleared = settled(results, 'delete', (async () => {
      await del('event_admin_assignments').where({ event_id: gallery }).del();
      await del.commit();
    })());
    await Promise.all([cleared, saved]);

    expect(results).toEqual({ delete: 'ok', save: 'ok' });
    const ids = (await db('event_admin_assignments').where({ event_id: gallery }).pluck('admin_user_id')).map(Number);
    expect(ids).toEqual([b]);
  }, 60000);

  // Two saves adding members to the same gallery: the second waits on the
  // first's uncommitted row (ON CONFLICT DO NOTHING still waits). In
  // submitted order they could each hold a row the other was waiting on.
  test('two saves adding the same members insert them in one order', async () => {
    // Ascending ids: a < b < c.
    const a = await admin('insert-order-a');
    const b = await admin('insert-order-b');
    const c = await admin('insert-order-c');
    const gallery = await event('insert-order-lock');

    // Holds an uncommitted (gallery, C), so the first save parks on it after
    // inserting its earlier rows.
    const blocker = await db.transaction();
    await blocker('event_admin_assignments').insert({ event_id: gallery, admin_user_id: c, assigned_by: ownerId });

    const results = {};
    // Before the fix: inserts A, parks on C; then B, behind the second save.
    const first = settled(results, 'first', db.transaction((trx) => eventAdminAssignments.setAssignedAdmins(gallery, [a, c, b], ownerId, trx)));
    await until(async () => (await waiting()) >= 1);
    // Before the fix: inserts B, parks on A behind the first save.
    const second = settled(results, 'second', db.transaction((trx) => eventAdminAssignments.setAssignedAdmins(gallery, [b, a], ownerId, trx)));
    await until(async () => (await waiting()) >= 2);

    await blocker.rollback();
    await Promise.all([first, second]);

    expect(results).toEqual({ first: 'ok', second: 'ok' });
    const ids = (await db('event_admin_assignments').where({ event_id: gallery }).orderBy('admin_user_id').pluck('admin_user_id'))
      .map(Number);
    expect(ids).toEqual([a, b, c]);
  }, 60000);
});
