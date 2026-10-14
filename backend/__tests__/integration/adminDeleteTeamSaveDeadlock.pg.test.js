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
 * Each interleaving is pinned with a held transaction, and every step waits
 * for the backends parked behind it, so a test cannot pass by running the
 * two sides one after the other. Not run in CI: gated on PICPEAK_PG_TEST_URL.
 */
const knex = require('knex');
const { randomUUID } = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const pgUrl = process.env.PICPEAK_PG_TEST_URL;

(pgUrl ? describe : describe.skip)('admin delete vs gallery team save (pg)', () => {
  let owner; let db; let schema; let tmpDir; let cleanup; let previousClient;
  let userManagementService; let eventAdminAssignments; let ownerId; let editor;

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
    ({ adminId: ownerId } = await require('./helpers/crmDb').seedMinimal(db));
    await require('./helpers/crmDb').assignAdminRole(db, ownerId, 'super_admin');
    editor = await db('roles').where({ name: 'editor' }).first();
  }, 180000);

  afterAll(async () => {
    await require('../../src/services/serviceShutdown').stopServices();
    if (cleanup) await cleanup(); else if (db) await db.destroy();
    if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    if (previousClient === undefined) delete process.env.DATABASE_CLIENT; else process.env.DATABASE_CLIENT = previousClient;
    jest.dontMock('../../knexfile');
  });

  // How many backends wait, directly or through another waiter, on `pid`.
  const behind = async (pid) => {
    const { rows } = await db.raw(
      'WITH RECURSIVE w(pid) AS ('
      + ' SELECT pid FROM pg_stat_activity WHERE CAST(? AS int) = ANY(pg_blocking_pids(pid))'
      + ' UNION SELECT a.pid FROM pg_stat_activity a JOIN w ON w.pid = ANY(pg_blocking_pids(a.pid))'
      + ') SELECT count(*) AS n FROM w',
      [pid],
    );
    return Number(rows[0].n);
  };
  const backendPid = async (trx) => (await trx.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  // True once `done` holds, false after ten seconds.
  const until = async (done) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await done()) return true;
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    return false;
  };
  const rollback = async (trx) => { if (!trx.isCompleted()) await trx.rollback(); };

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
  const save = (gallery, ids) => db.transaction((trx) => eventAdminAssignments.setAssignedAdmins(gallery, ids, ownerId, trx));

  test('both finish when the delete and the save need the same rows', async () => {
    // Ascending ids: w < z < x.
    const w = await admin('lock-w');
    const z = await admin('lock-z');
    const x = await admin('lock-x');
    const gallery = await event('admin-delete-lock');
    const other = await event('admin-delete-lock-other');
    // Inserted one by one: ids S2 < S < R.
    const assign = async (eventId, adminUserId, assignedBy) => (await db('event_admin_assignments')
      .insert({ event_id: eventId, admin_user_id: adminUserId, assigned_by: assignedBy })
      .returning('id'))[0].id;
    const s2 = await assign(other, w, x);
    await assign(gallery, z, x); // S
    await assign(gallery, x, ownerId); // R

    // Hold S2: the delete parks on it.
    const blocker = await db.transaction();
    const results = {};
    const pending = [];
    try {
      await blocker('event_admin_assignments').where({ id: s2 }).forUpdate().first();
      const pid = await backendPid(blocker);
      pending.push(settled(results, 'delete', userManagementService.deleteAdminUser(x, ownerId)));
      expect(await until(async () => (await behind(pid)) >= 1)).toBe(true);

      // The team save removes both X and Z from the gallery: rows R and S.
      // Before the fix it parks on R behind the delete; now the delete holds
      // no assignment row yet, and the save finishes while S2 is still held.
      pending.push(settled(results, 'save', save(gallery, [])));
      expect(await until(async () => results.save !== undefined)).toBe(true);
      expect(results.save).toBe('ok');
    } finally {
      await rollback(blocker);
      await Promise.all(pending);
    }

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
    const results = {};
    const pending = [];
    try {
      await del('events').where({ id: gallery }).forUpdate().first();
      const pid = await backendPid(del);
      // Removes A, adds B. Before the fix it locks and deletes A, then parks
      // on the event row in its insert; now it parks on the event row first.
      pending.push(settled(results, 'save', save(gallery, [b])));
      expect(await until(async () => (await behind(pid)) >= 1)).toBe(true);

      // The delete's next step. Before the fix it waits on A: 40P01.
      pending.push(settled(results, 'delete', (async () => {
        await del('event_admin_assignments').where({ event_id: gallery }).del();
        await del.commit();
      })()));
      await Promise.all(pending);
    } finally {
      await rollback(del);
      await Promise.all(pending);
    }

    expect(results).toEqual({ delete: 'ok', save: 'ok' });
    const ids = (await db('event_admin_assignments').where({ event_id: gallery }).pluck('admin_user_id')).map(Number);
    expect(ids).toEqual([b]);
  }, 60000);

  // Two saves adding members to the same gallery: the second used to wait on
  // the first's uncommitted row (ON CONFLICT DO NOTHING still waits), and in
  // submitted order each could hold a row the other was waiting on. Saves of
  // one gallery now run one at a time.
  test('two saves adding the same members both finish', async () => {
    // Ascending ids: a < b < c.
    const a = await admin('insert-order-a');
    const b = await admin('insert-order-b');
    const c = await admin('insert-order-c');
    const gallery = await event('insert-order-lock');

    // Holds an uncommitted (gallery, C), so the first save parks on it after
    // inserting A.
    const blocker = await db.transaction();
    const results = {};
    const pending = [];
    try {
      await blocker('event_admin_assignments').insert({ event_id: gallery, admin_user_id: c, assigned_by: ownerId });
      const pid = await backendPid(blocker);
      // Before the fix: inserts A, parks on C; then B, behind the second save.
      pending.push(settled(results, 'first', save(gallery, [a, c, b])));
      expect(await until(async () => (await behind(pid)) >= 1)).toBe(true);
      // Before the fix: inserts B, parks on A behind the first save. Now it
      // waits for the first save to finish.
      pending.push(settled(results, 'second', save(gallery, [b, a])));
      expect(await until(async () => (await behind(pid)) >= 2)).toBe(true);
    } finally {
      await rollback(blocker);
      await Promise.all(pending);
    }

    expect(results).toEqual({ first: 'ok', second: 'ok' });
    const ids = (await db('event_admin_assignments').where({ event_id: gallery }).orderBy('admin_user_id').pluck('admin_user_id'))
      .map(Number);
    // The second save runs after the first commits and replaces its team.
    expect(ids).toEqual([a, b]);
  }, 60000);
});
