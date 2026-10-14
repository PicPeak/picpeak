/**
 * Admin hard delete against a gallery delete, and invitation acceptance
 * against deleting the inviter, on PostgreSQL.
 *
 * Gallery delete (adminEvents/helpers.js deleteEventCascade, adminArchives.js)
 * locks the event row, then deletes its assignments. The admin delete used to
 * lock the deleted admin's assignment rows first and reach the event row last,
 * in the ON DELETE SET NULL onto events.created_by of a gallery the admin
 * created: each held what the other wanted, 40P01, a 500 on one side. The
 * admin delete now locks those event rows before any other row.
 *
 * Acceptance claimed the invitation row, then inserted the account, whose
 * created_by check takes a key-share lock on the inviter. Deleting the inviter
 * locks their account row, then its ON DELETE CASCADE deletes their
 * invitations: the same cycle. Acceptance now locks the inviter row first.
 *
 * Each interleaving is pinned with a held transaction, and every step waits
 * for the backends parked behind it, so a test cannot pass by running the two
 * sides one after the other. Not run in CI: gated on PICPEAK_PG_TEST_URL.
 */
const knex = require('knex');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const pgUrl = process.env.PICPEAK_PG_TEST_URL;

(pgUrl ? describe : describe.skip)('admin delete lock order (pg)', () => {
  let owner; let db; let schema; let tmpDir; let cleanup; let previousClient;
  let userManagementService; let capabilityTokenColumns; let ownerId; let editor;

  beforeAll(async () => {
    schema = `admin_delete_order_${crypto.randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    previousClient = process.env.DATABASE_CLIENT;
    process.env.DATABASE_CLIENT = 'pg';
    process.env.JWT_SECRET = 'admin-delete-order-pg-test-secret-at-least-32-chars';
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-admin-delete-order-pg-'));
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    jest.doMock('../../knexfile', () => ({ client: 'pg', connection: pgUrl, searchPath: [schema] }));
    ({ db } = require('../../src/database/db'));
    ({ cleanup } = await require('./helpers/crmDb').bootCrmDb());
    userManagementService = require('../../src/services/userManagementService');
    ({ capabilityTokenColumns } = require('../../src/utils/capabilityToken'));
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
  const settled = (results, name, promise) => promise.then(
    () => { results[name] = 'ok'; },
    (e) => { results[name] = e; },
  );

  const admin = async (name) => (await db('admin_users').insert({
    username: name, email: `${name}@example.com`, password_hash: 'x',
    role_id: editor.id, is_active: true, created_at: new Date().toISOString(),
  }).returning('id'))[0].id;
  const event = async (slug, createdBy) => (await db('events').insert({
    slug, event_type: 'wedding', event_name: slug, event_date: '2026-08-01',
    host_email: 'h@example.com', admin_email: 'studio@example.com', password_hash: 'x',
    share_link: `/gallery/${slug}/share`, share_token: `${slug}-share`,
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: true, is_archived: false, is_draft: false, created_by: createdBy,
    created_at: new Date().toISOString(),
  }).returning('id'))[0].id;

  test('a gallery delete and the delete of the admin who created it both finish', async () => {
    const x = await admin('creator-x');
    const gallery = await event('created-by-x', x);
    await db('event_admin_assignments').insert({ event_id: gallery, admin_user_id: x, assigned_by: ownerId });

    // The gallery delete's opening, held: the event row, FOR UPDATE.
    const del = await db.transaction();
    const results = {};
    const pending = [];
    try {
      await del('events').where({ id: gallery }).forUpdate().first();
      const pid = await backendPid(del);
      // Before the fix the admin delete locks and deletes X's assignment,
      // then parks on the event row in the SET NULL of created_by; now it
      // parks on the event row before touching anything.
      pending.push(settled(results, 'admin', userManagementService.deleteAdminUser(x, ownerId)));
      expect(await until(async () => (await behind(pid)) >= 1)).toBe(true);

      // The gallery delete's next steps. Before the fix the assignment delete
      // waits on X's row: 40P01.
      pending.push(settled(results, 'gallery', (async () => {
        await del('event_admin_assignments').where({ event_id: gallery }).del();
        await del('events').where({ id: gallery }).del();
        await del.commit();
      })()));
      await Promise.all(pending);
    } finally {
      await rollback(del);
      await Promise.all(pending);
    }

    expect(results).toEqual({ admin: 'ok', gallery: 'ok' });
    expect(await db('admin_users').where({ id: x }).first()).toBeUndefined();
    expect(await db('events').where({ id: gallery }).first()).toBeUndefined();
  }, 60000);

  test('accepting an invitation and deleting the inviter both finish', async () => {
    const x = await admin('inviter-x');
    const token = crypto.randomBytes(32).toString('hex');
    const [{ id: invitationId }] = await db('admin_invitations').insert({
      email: 'invitee-x@example.com', ...capabilityTokenColumns(token), role_id: editor.id,
      invited_by: x, expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      created_at: new Date().toISOString(),
    }).returning('id');

    // Holds the invitation row, so acceptance parks on its claim.
    const blocker = await db.transaction();
    const results = {};
    const pending = [];
    let accepted;
    try {
      await blocker('admin_invitations').where({ id: invitationId }).forUpdate().first();
      const pid = await backendPid(blocker);
      // Now: takes its key-share lock on X, then parks on the invitation.
      pending.push(settled(results, 'accept', userManagementService.acceptInvitation({
        token, username: 'invitee-x', password: crypto.randomBytes(12).toString('hex'),
      }).then((r) => { accepted = r; })));
      expect(await until(async () => (await behind(pid)) >= 1)).toBe(true);
      // Before the fix: locks X, cascades onto the invitation and queues
      // behind acceptance there; acceptance then gets the invitation and parks
      // on X in its insert: 40P01. Now it parks on X behind acceptance.
      pending.push(settled(results, 'delete', userManagementService.deleteAdminUser(x, ownerId)));
      expect(await until(async () => (await behind(pid)) >= 2)).toBe(true);
    } finally {
      await rollback(blocker);
      await Promise.all(pending);
    }

    expect(results).toEqual({ accept: 'ok', delete: 'ok' });
    expect(await db('admin_users').where({ id: x }).first()).toBeUndefined();
    // Accepted first: the account stays, its creator cleared by the delete.
    const user = await db('admin_users').where({ id: accepted.userId }).first();
    expect(user.created_by).toBeNull();
    expect(await db('admin_invitations').where({ id: invitationId }).first()).toBeUndefined();
  }, 60000);
});
