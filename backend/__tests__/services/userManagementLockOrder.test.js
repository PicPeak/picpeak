/**
 * Lock order of the admin hard delete and of invitation acceptance, on SQLite.
 *
 * The deadlocks are PostgreSQL-only and pinned in
 * __tests__/integration/userManagementLockOrder.pg.test.js:
 *   - the admin delete takes the event rows of the galleries the admin created
 *     before any other row, as a gallery delete does (event row, then its
 *     assignments, photos, ...);
 *   - acceptance takes the inviter's account row before the invitation, as
 *     deleting the inviter does (account row, then the cascade onto their
 *     invitations).
 * Here: both still do their job on SQLite, where the row locks drop out, the
 * locking reads come first, and they ask for the lock mode that does not hold
 * back the other writers of those rows.
 */
const crypto = require('crypto');
const QueryBuilder = require('knex/lib/query/querybuilder');
const { bootCrmDb, seedMinimal, assignAdminRole } = require('../integration/helpers/crmDb');
const { capabilityTokenColumns } = require('../../src/utils/capabilityToken');

describe('admin delete and invitation acceptance lock order', () => {
  let db; let cleanup; let ownerId; let editorRoleId;
  let userManagementService;
  let queries = [];
  const record = (q) => { queries.push(q.sql); };
  let proto; let prepBindings;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    // Jest's VM creates Date objects from another realm; sqlite3 otherwise
    // binds the service's expiry comparison as "[object Object]".
    proto = db.client.constructor.prototype;
    prepBindings = proto.prepBindings;
    proto.prepBindings = function prepareCrossRealmDates(bindings) {
      const prepared = prepBindings.call(this, bindings);
      if (!Array.isArray(prepared)) return prepared;
      return prepared.map((value) => (Object.prototype.toString.call(value) === '[object Date]'
        ? value.getTime() : value));
    };
    ({ adminId: ownerId } = await seedMinimal(db));
    await assignAdminRole(db, ownerId, 'super_admin');
    editorRoleId = (await db('roles').where({ name: 'editor' }).first()).id;
    userManagementService = require('../../src/services/userManagementService');
    db.on('query', record);
  }, 120000);

  afterAll(async () => {
    db.removeListener('query', record);
    if (proto) proto.prepBindings = prepBindings;
    if (cleanup) await cleanup();
  });

  beforeEach(() => { queries = []; });
  afterEach(() => { jest.restoreAllMocks(); });

  let seq = 0;
  const admin = async () => {
    seq += 1;
    const [row] = await db('admin_users').insert({
      username: `lock-mode-${seq}`, email: `lock-mode-${seq}@example.com`, password_hash: 'x',
      role_id: editorRoleId, is_active: 1, created_at: new Date().toISOString(),
    }).returning('id');
    return row?.id ?? row;
  };
  const event = async (createdBy) => {
    seq += 1;
    const slug = `lock-mode-${seq}`;
    const [row] = await db('events').insert({
      slug, event_type: 'wedding', event_name: slug, event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'studio@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/share`, share_token: `${slug}-share`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, created_by: createdBy, created_at: new Date().toISOString(),
    }).returning('id');
    return row?.id ?? row;
  };
  // The tables each lock mode was asked for on.
  const lockModes = () => {
    const spies = {
      noKeyUpdate: jest.spyOn(QueryBuilder.prototype, 'forNoKeyUpdate'),
      keyShare: jest.spyOn(QueryBuilder.prototype, 'forKeyShare'),
    };
    return {
      get noKeyUpdate() { return spies.noKeyUpdate.mock.contexts.map((qb) => qb._single.table); },
      get keyShare() { return spies.keyShare.mock.contexts.map((qb) => qb._single.table); },
    };
  };

  it('deleting an admin reads the galleries they created before any write', async () => {
    const x = await admin();
    const gallery = await event(x);
    await event(ownerId);
    await db('event_admin_assignments').insert({ event_id: gallery, admin_user_id: x, assigned_by: ownerId });
    const seen = lockModes();
    queries = [];

    await userManagementService.deleteAdminUser(x, ownerId);

    // NO KEY UPDATE, the lock the ON DELETE SET NULL on events.created_by
    // takes: FOR UPDATE would hold back a team save's key-share lock.
    expect(seen.noKeyUpdate).toEqual(['events']);
    const eventLock = queries.findIndex((sql) => /^select `id` from `events` where `created_by` = \? order by `id` asc$/i.test(sql));
    const begin = queries.findIndex((sql) => /^begin/i.test(sql));
    const firstWrite = queries.findIndex((sql) => /^(delete|update|insert)/i.test(sql));
    expect(eventLock).toBe(begin + 1);
    expect(eventLock).not.toBe(-1);
    expect(eventLock).toBeLessThan(firstWrite);
    expect(await db('admin_users').where({ id: x }).first()).toBeUndefined();
    expect(await db('event_admin_assignments').where({ admin_user_id: x })).toHaveLength(0);
  });

  it('accepting an invitation reads the inviter before claiming the invitation', async () => {
    const inviter = await admin();
    const token = crypto.randomBytes(32).toString('hex');
    const [row] = await db('admin_invitations').insert({
      email: `invitee-${seq}@example.com`, ...capabilityTokenColumns(token), role_id: editorRoleId,
      invited_by: inviter, expires_at: Date.now() + 24 * 3600 * 1000,
      created_at: new Date().toISOString(),
    }).returning('id');
    const invitationId = row?.id ?? row;
    const seen = lockModes();
    queries = [];

    const { userId } = await userManagementService.acceptInvitation({
      token, username: `invitee-${seq}`, password: crypto.randomBytes(12).toString('hex'),
    });

    // KEY SHARE, the lock the insert's created_by check takes: it does not
    // hold back edits of the inviter's account.
    expect(seen.keyShare).toEqual(['admin_users']);
    const inviterLock = queries.findIndex((sql) => /^select `id` from `admin_users` where `id` = \? limit \?$/i.test(sql));
    const claim = queries.findIndex((sql) => /^update `admin_invitations`/i.test(sql));
    expect(inviterLock).not.toBe(-1);
    expect(inviterLock).toBeLessThan(claim);
    const user = await db('admin_users').where({ id: userId }).first();
    expect(Number(user.created_by)).toBe(inviter);
    const invitation = await db('admin_invitations').where({ id: invitationId }).first();
    expect(Number(invitation.accepted_user_id)).toBe(Number(userId));
  });
});
