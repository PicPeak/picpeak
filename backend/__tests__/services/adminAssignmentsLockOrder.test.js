/**
 * Admin hard delete and gallery team save on SQLite (issue 1979).
 *
 * The deadlock itself is PostgreSQL-only and pinned in
 * __tests__/integration/adminDeleteTeamSaveDeadlock.pg.test.js. Here: both
 * operations still do their job on SQLite, where the FOR UPDATE drops out,
 * and both read their assignment rows in id order before writing them.
 */
const { bootCrmDb, seedMinimal, assignAdminRole } = require('../integration/helpers/crmDb');

describe('admin delete and team save lock assignment rows in id order (issue 1979)', () => {
  let db; let cleanup; let ownerId; let editorRoleId;
  let userManagementService; let eventAdminAssignments;
  let queries = [];
  const record = (q) => { queries.push(q.sql); };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId: ownerId } = await seedMinimal(db));
    await assignAdminRole(db, ownerId, 'super_admin');
    editorRoleId = (await db('roles').where({ name: 'editor' }).first()).id;
    userManagementService = require('../../src/services/userManagementService');
    eventAdminAssignments = require('../../src/services/eventAdminAssignmentsService');
    db.on('query', record);
  }, 120000);

  afterAll(async () => {
    db.removeListener('query', record);
    if (cleanup) await cleanup();
  });

  beforeEach(() => { queries = []; });

  let seq = 0;
  const admin = async () => {
    seq += 1;
    const [row] = await db('admin_users').insert({
      username: `lock-order-${seq}`, email: `lock-order-${seq}@example.com`, password_hash: 'x',
      role_id: editorRoleId, is_active: 1, created_at: new Date().toISOString(),
    }).returning('id');
    return row?.id ?? row;
  };
  const event = async () => {
    seq += 1;
    const slug = `lock-order-${seq}`;
    const [row] = await db('events').insert({
      slug, event_type: 'wedding', event_name: slug, event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'studio@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/share`, share_token: `${slug}-share`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, created_by: ownerId, created_at: new Date().toISOString(),
    }).returning('id');
    return row?.id ?? row;
  };
  // The ordered read on the assignments table, before the first write to it.
  const lockedFirst = () => {
    const onTable = queries.filter((sql) => sql.includes('`event_admin_assignments`'));
    const firstWrite = onTable.findIndex((sql) => /^(delete|update)/i.test(sql));
    const lock = onTable.findIndex((sql) => /^select/i.test(sql) && /order by `id` asc$/i.test(sql));
    return lock !== -1 && lock < firstWrite;
  };

  it('deleting an admin drops their assignments and clears the ones they made', async () => {
    const [x, z] = [await admin(), await admin()];
    const gallery = await event();
    await db('event_admin_assignments').insert([
      { event_id: gallery, admin_user_id: z, assigned_by: x },
      { event_id: gallery, admin_user_id: x, assigned_by: ownerId },
    ]);

    await userManagementService.deleteAdminUser(x, ownerId);

    expect(lockedFirst()).toBe(true);
    expect(await db('admin_users').where({ id: x }).first()).toBeUndefined();
    const rows = Array.from(await db('event_admin_assignments').where({ event_id: gallery }));
    expect(rows).toEqual([expect.objectContaining({ admin_user_id: z, assigned_by: null })]);
  });

  it('a team save removes and adds members', async () => {
    const [a, b, c] = [await admin(), await admin(), await admin()];
    const gallery = await event();
    await db('event_admin_assignments').insert([
      { event_id: gallery, admin_user_id: a, assigned_by: ownerId },
      { event_id: gallery, admin_user_id: b, assigned_by: ownerId },
    ]);

    const change = await db.transaction((trx) => eventAdminAssignments.setAssignedAdmins(gallery, [b, c], ownerId, trx));

    expect(change).toEqual({ added: [c], removed: [a] });
    expect(lockedFirst()).toBe(true);
    const ids = (await db('event_admin_assignments').where({ event_id: gallery }).orderBy('admin_user_id').pluck('admin_user_id'))
      .map(Number);
    expect(ids).toEqual([b, c]);
  });

  it('a team save reads the event row before its assignments', async () => {
    const a = await admin();
    const gallery = await event();

    await db.transaction((trx) => eventAdminAssignments.setAssignedAdmins(gallery, [a], ownerId, trx));

    const eventRead = queries.findIndex((sql) => /^select .* from `events` where `id` = \?/i.test(sql));
    const firstOnTable = queries.findIndex((sql) => sql.includes('`event_admin_assignments`'));
    expect(eventRead).not.toBe(-1);
    expect(eventRead).toBeLessThan(firstOnTable);
  });

  it('on PostgreSQL a team save takes its gallery advisory lock before anything else', async () => {
    const a = await admin();
    const gallery = await event();

    await db.transaction(async (trx) => {
      // The real transaction, reporting itself as PostgreSQL to the service.
      const raw = jest.fn(async () => {
        queries.push('advisory lock');
      });
      const pgTrx = Object.assign((table) => trx(table), { raw, client: { config: { client: 'pg' } } });
      queries = [];
      await eventAdminAssignments.setAssignedAdmins(gallery, [a], ownerId, pgTrx);
      expect(raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(?, ?)', [1078, gallery]);
    });

    expect(queries.indexOf('advisory lock')).toBe(0);
    const ids = (await db('event_admin_assignments').where({ event_id: gallery }).pluck('admin_user_id')).map(Number);
    expect(ids).toEqual([a]);
  });
});
