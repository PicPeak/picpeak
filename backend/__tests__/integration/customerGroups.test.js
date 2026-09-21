/**
 * Customer groups (#1443, migration 226).
 *
 * Through the real admin router, so the permission and validation layers are
 * part of what is pinned:
 *  - the catalogue: create, rename, recolour, reorder, archive, restore
 *  - names are unique regardless of case, colours must be hex
 *  - a customer belongs to none, one or several groups, and the overview
 *    carries them
 *  - the group filter works with the existing search, and resets
 *  - renaming or recolouring changes nothing on the customer record
 *  - an archived group stays on the customers that carry it and is refused
 *    for a new assignment
 *  - deleting a group with members is refused; deleting an empty one works
 *    and takes no customer with it
 *  - the catalogue needs customers.groups.manage, reading needs customers.view
 *  - every change reaches activity_logs
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let adminApp;
let adminId;
let customerId;
let superToken;
let viewerToken;
let seq = 0;

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const idOf = (inserted) => (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]);

async function createCustomer(email) {
  seq += 1;
  return idOf(await db('customer_accounts').insert({
    email: email || `groups-${seq}@example.com`,
    display_name: `Customer ${seq}`,
    is_active: true,
    created_at: new Date().toISOString(),
  }).returning('id'));
}

const createGroup = (body, token = superToken) => request(adminApp)
  .post('/api/admin/customers/groups').set(auth(token)).send(body);

const listGroups = (query = '', token = superToken) => request(adminApp)
  .get(`/api/admin/customers/groups${query}`).set(auth(token));

const listCustomers = (query = '', token = superToken) => request(adminApp)
  .get(`/api/admin/customers${query}`).set(auth(token));

const setGroups = (id, groupIds, token = superToken) => request(adminApp)
  .put(`/api/admin/customers/${id}/groups`).set(auth(token)).send({ groupIds });

const bodyOf = (res) => res.body.data || res.body;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  superToken = mintAdminToken(adminId);

  // A second admin with customers.view and nothing else: may read the
  // catalogue, may not change it. Its own role, so the grants the migration
  // makes to super_admin/admin can't blur the check.
  const roleId = idOf(await db('roles').insert({
    name: 'groups-read-only', display_name: 'Groups read only', is_system: false,
  }).returning('id'));
  const viewPermission = await db('permissions').where({ name: 'customers.view' }).first();
  await db('role_permissions').insert({ role_id: roleId, permission_id: viewPermission.id });
  const viewerId = idOf(await db('admin_users').insert({
    username: 'groups-viewer',
    email: 'groups-viewer@example.com',
    password_hash: 'x',
    must_change_password: false,
    role_id: roleId,
    created_at: new Date().toISOString(),
  }).returning('id'));
  viewerToken = mintAdminToken(viewerId);

  adminApp = buildRouteApp('/api/admin/customers', require('../../src/routes/adminCustomers'));
});

afterAll(async () => { if (cleanup) await cleanup(); });

describe('the catalogue', () => {
  it('creates, renames and recolours a group', async () => {
    const created = await createGroup({ name: 'Weddings', description: 'Private clients', color: '#2563eb' });
    expect(created.status).toBe(201);
    expect(bodyOf(created).group).toMatchObject({
      name: 'Weddings', description: 'Private clients', color: '#2563EB', isArchived: false, memberCount: 0,
    });

    const id = bodyOf(created).group.id;
    const renamed = await request(adminApp).put(`/api/admin/customers/groups/${id}`)
      .set(auth(superToken)).send({ name: 'Wedding clients', color: '#15803D' });
    expect(renamed.status).toBe(200);
    expect(bodyOf(renamed).group).toMatchObject({ name: 'Wedding clients', color: '#15803D' });
  });

  it('refuses a duplicate name whatever its case, and a colour that is not hex', async () => {
    await createGroup({ name: 'Corporate' });
    const duplicate = await createGroup({ name: '  corporate  ' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('GROUP_NAME_TAKEN');

    // SQL LOWER() is ASCII-only on SQLite, so the umlaut is the case that
    // told the two engines apart.
    expect((await createGroup({ name: 'Ärzte' })).status).toBe(201);
    const umlaut = await createGroup({ name: 'ärzte' });
    expect(umlaut.status).toBe(409);
    expect(umlaut.body.code).toBe('GROUP_NAME_TAKEN');

    // A rename into a taken name, in another case.
    const other = bodyOf(await createGroup({ name: 'Praxen' })).group;
    const renamed = await request(adminApp).put(`/api/admin/customers/groups/${other.id}`)
      .set(auth(superToken)).send({ name: 'ÄRZTE' });
    expect(renamed.status).toBe(409);
    expect(renamed.body.code).toBe('GROUP_NAME_TAKEN');

    // What holds when two creates pass the check together: the index itself.
    await expect(db('customer_groups').insert({ name: 'CORPORATE', name_key: 'corporate' })).rejects.toThrow();

    const badColor = await createGroup({ name: 'Studio', color: 'cornflowerblue' });
    expect(badColor.status).toBe(400);
    expect(badColor.body.code).toBe('GROUP_COLOR_INVALID');
  });

  it('refuses a description over 500 characters at the route, on create and on update', async () => {
    // The route validator answers before the service's own check, so the
    // service's GROUP_DESCRIPTION_TOO_LONG code must not be what comes back.
    const tooLong = 'x'.repeat(501);
    const created = await createGroup({ name: 'Long notes', description: tooLong });
    expect(created.status).toBe(400);
    expect(created.body.code).not.toBe('GROUP_DESCRIPTION_TOO_LONG');

    // Padding is trimmed first, as the service does, so 500 characters fit.
    const fits = await createGroup({ name: 'Long notes', description: `  ${'x'.repeat(500)}  ` });
    expect(fits.status).toBe(201);

    const updated = await request(adminApp).put(`/api/admin/customers/groups/${bodyOf(fits).group.id}`)
      .set(auth(superToken)).send({ description: tooLong });
    expect(updated.status).toBe(400);
    expect(updated.body.code).not.toBe('GROUP_DESCRIPTION_TOO_LONG');
  });

  it('keeps the admin\'s order, and lists archived groups only when asked', async () => {
    const first = bodyOf(await createGroup({ name: 'Order A' })).group;
    const second = bodyOf(await createGroup({ name: 'Order B' })).group;

    const reordered = await request(adminApp).post('/api/admin/customers/groups/reorder')
      .set(auth(superToken)).send({ orderedIds: [second.id, first.id] });
    expect(reordered.status).toBe(200);
    const order = bodyOf(reordered).groups.map((g) => g.id);
    expect(order.indexOf(second.id)).toBeLessThan(order.indexOf(first.id));

    await request(adminApp).put(`/api/admin/customers/groups/${first.id}`)
      .set(auth(superToken)).send({ isArchived: true });
    const live = bodyOf(await listGroups()).groups.map((g) => g.id);
    expect(live).not.toContain(first.id);
    const all = bodyOf(await listGroups('?includeArchived=1')).groups;
    expect(all.find((g) => g.id === first.id)).toMatchObject({ isArchived: true });
  });
});

describe('assignment', () => {
  it('puts a customer in none, one or several groups and counts the members', async () => {
    const a = bodyOf(await createGroup({ name: 'Members A' })).group;
    const b = bodyOf(await createGroup({ name: 'Members B' })).group;
    const customer = await createCustomer();

    expect(bodyOf(await setGroups(customer, [])).groups).toEqual([]);
    expect(bodyOf(await setGroups(customer, [a.id])).groups.map((g) => g.id)).toEqual([a.id]);

    const both = bodyOf(await setGroups(customer, [a.id, b.id])).groups.map((g) => g.id);
    expect(both.sort()).toEqual([a.id, b.id].sort());

    const counts = bodyOf(await listGroups()).groups;
    expect(counts.find((g) => g.id === a.id).memberCount).toBe(1);
    expect(bodyOf(await setGroups(customer, [b.id])).groups.map((g) => g.id)).toEqual([b.id]);
  });

  it('carries the groups on the overview and on the detail record', async () => {
    const group = bodyOf(await createGroup({ name: 'Overview', color: '#B91C1C' })).group;
    const customer = await createCustomer();
    await setGroups(customer, [group.id]);

    const list = await listCustomers();
    expect(list.status).toBe(200);
    const row = list.body.customers.find((c) => c.id === customer);
    expect(row.groups).toEqual([expect.objectContaining({ id: group.id, name: 'Overview', color: '#B91C1C' })]);
    // A customer with no group is still listed, with an empty list.
    expect(list.body.customers.find((c) => c.id === customerId).groups).toEqual([]);

    const detail = await request(adminApp).get(`/api/admin/customers/${customer}`).set(auth(superToken));
    expect(detail.body.customer.groups.map((g) => g.id)).toEqual([group.id]);
  });

  it('reflects a rename everywhere without touching the customer record', async () => {
    const group = bodyOf(await createGroup({ name: 'Before' })).group;
    const customer = await createCustomer();
    await setGroups(customer, [group.id]);
    const before = await db('customer_accounts').where({ id: customer }).first();

    await request(adminApp).put(`/api/admin/customers/groups/${group.id}`)
      .set(auth(superToken)).send({ name: 'After', color: '#7C3AED' });

    const row = (await listCustomers()).body.customers.find((c) => c.id === customer);
    expect(row.groups[0]).toMatchObject({ name: 'After', color: '#7C3AED' });
    const after = await db('customer_accounts').where({ id: customer }).first();
    expect(after.updated_at).toEqual(before.updated_at);
  });

  it('keeps an archived group on the customers that carry it, and refuses it for a new one', async () => {
    const group = bodyOf(await createGroup({ name: 'Retired' })).group;
    const carrier = await createCustomer();
    await setGroups(carrier, [group.id]);
    await request(adminApp).put(`/api/admin/customers/groups/${group.id}`)
      .set(auth(superToken)).send({ isArchived: true });

    const row = (await listCustomers()).body.customers.find((c) => c.id === carrier);
    expect(row.groups[0]).toMatchObject({ id: group.id, isArchived: true });
    // Sending the same set back is not a new assignment, so it is allowed.
    expect((await setGroups(carrier, [group.id])).status).toBe(200);

    const other = await createCustomer();
    const refused = await setGroups(other, [group.id]);
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('GROUP_ARCHIVED');
  });
});

describe('filtering', () => {
  it('filters by one or more groups, together with the search, and unfiltered shows everyone', async () => {
    const vip = bodyOf(await createGroup({ name: 'VIP' })).group;
    const press = bodyOf(await createGroup({ name: 'Press' })).group;
    const vipCustomer = await createCustomer('filter-vip@example.com');
    const pressCustomer = await createCustomer('filter-press@example.com');
    await db('customer_accounts').where({ id: vipCustomer }).update({ display_name: 'Filter Vip' });
    await db('customer_accounts').where({ id: pressCustomer }).update({ display_name: 'Filter Press' });
    await setGroups(vipCustomer, [vip.id]);
    await setGroups(pressCustomer, [press.id]);

    const one = await listCustomers(`?groupIds=${vip.id}`);
    expect(one.body.customers.map((c) => c.id)).toEqual([vipCustomer]);

    const both = await listCustomers(`?groupIds=${vip.id},${press.id}`);
    expect(both.body.customers.map((c) => c.id).sort()).toEqual([vipCustomer, pressCustomer].sort());

    const repeated = await listCustomers(`?groupIds=${vip.id}&groupIds=${press.id}`);
    expect(repeated.body.customers.length).toBe(2);

    const withSearch = await listCustomers(`?groupIds=${vip.id},${press.id}&search=filter-press`);
    expect(withSearch.body.customers.map((c) => c.id)).toEqual([pressCustomer]);

    // Cleared: everyone is back, grouped or not.
    const cleared = await listCustomers();
    expect(cleared.body.customers.length).toBeGreaterThan(2);
    expect(cleared.body.customers.map((c) => c.id)).toContain(customerId);

    // Something that isn't an id is dropped, so the list is unfiltered…
    expect((await listCustomers('?groupIds=abc')).body.customers.length).toBe(cleared.body.customers.length);
    // …while the id of a group that no longer exists is a filter nobody
    // matches: an empty list, not an error.
    const stale = await listCustomers('?groupIds=999999');
    expect(stale.status).toBe(200);
    expect(stale.body.customers).toEqual([]);
    // More ids than the route accepts are cut off, not refused.
    const many = await listCustomers(`?groupIds=${Array.from({ length: 1200 }, (_, i) => i + 1000000).join(',')}`);
    expect(many.status).toBe(200);
  });
});

describe('deletion', () => {
  it('refuses to delete a group that is still in use, and never takes a customer with it', async () => {
    const group = bodyOf(await createGroup({ name: 'In use' })).group;
    const customer = await createCustomer();
    await setGroups(customer, [group.id]);

    const refused = await request(adminApp).delete(`/api/admin/customers/groups/${group.id}`).set(auth(superToken));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('GROUP_IN_USE');
    expect(await db('customer_accounts').where({ id: customer }).first()).toBeTruthy();
    expect(await db('customer_group_members').where({ group_id: group.id })).toHaveLength(1);
    // The database refuses it too, where it enforces foreign keys: an
    // assignment landing between the check and the delete must not cascade.
    const fks = await db.raw('PRAGMA foreign_key_list(customer_group_members)');
    expect(fks.find((fk) => fk.table === 'customer_groups').on_delete).toBe('RESTRICT');

    await setGroups(customer, []);
    expect((await request(adminApp).delete(`/api/admin/customers/groups/${group.id}`).set(auth(superToken))).status).toBe(200);
    expect(await db('customer_groups').where({ id: group.id }).first()).toBeUndefined();
    expect(await db('customer_accounts').where({ id: customer }).first()).toBeTruthy();
  });
});

describe('assignment under a race', () => {
  it('answers 409, not 500, when another admin\'s save inserted the same membership first', async () => {
    const group = bodyOf(await createGroup({ name: 'Raced' })).group;
    const customer = await createCustomer();
    // The unique index the service leans on is there…
    await db('customer_group_members').insert({ group_id: group.id, customer_account_id: customer });
    await expect(db('customer_group_members').insert({ group_id: group.id, customer_account_id: customer }))
      .rejects.toThrow();
    await db('customer_group_members').where({ customer_account_id: customer }).del();

    // …and losing to it is a conflict to reload on. A single SQLite
    // connection serialises the two saves, so the window between the read and
    // the insert can't be opened here; the transaction is made to fail the way
    // the index makes it fail on PostgreSQL. (`db` is a proxy over the pool,
    // so the client underneath is what has to be patched.)
    const realTransaction = db.client.transaction;
    db.client.transaction = () => Promise.reject(
      Object.assign(new Error('UNIQUE constraint failed: customer_group_members.group_id'), { code: 'SQLITE_CONSTRAINT' }),
    );
    let raced;
    try {
      raced = await setGroups(customer, [group.id]);
    } finally {
      db.client.transaction = realTransaction;
    }
    expect(raced.status).toBe(409);
    expect(raced.body.code).toBe('GROUP_ASSIGNMENT_CONFLICT');

    // Nothing half-done: the retry goes through, and two saves at once end
    // in one membership row, not an error.
    expect((await setGroups(customer, [group.id])).status).toBe(200);
    await db('customer_group_members').where({ customer_account_id: customer }).del();
    const both = await Promise.all([setGroups(customer, [group.id]), setGroups(customer, [group.id])]);
    expect(both.map((res) => res.status)).toEqual([200, 200]);
    expect(await db('customer_group_members').where({ customer_account_id: customer })).toHaveLength(1);
  });
});

describe('erasure', () => {
  it('takes an erased customer out of their groups, so the group can go', async () => {
    const group = bodyOf(await createGroup({ name: 'Erasure' })).group;
    const customer = await createCustomer();
    await setGroups(customer, [group.id]);

    const erased = await request(adminApp).post(`/api/admin/customers/${customer}/erase`).set(auth(superToken));
    expect(erased.status).toBe(200);
    expect(await db('customer_group_members').where({ customer_account_id: customer })).toHaveLength(0);
    const listed = bodyOf(await listGroups()).groups.find((g) => g.id === group.id);
    expect(listed.memberCount).toBe(0);
    expect((await request(adminApp).delete(`/api/admin/customers/groups/${group.id}`).set(auth(superToken))).status).toBe(200);
  });
});

describe('permissions and the log', () => {
  it('lets customers.view read the catalogue but not change it', async () => {
    const group = bodyOf(await createGroup({ name: 'Permission check' })).group;
    expect((await listGroups('', viewerToken)).status).toBe(200);

    const created = await createGroup({ name: 'From a viewer' }, viewerToken);
    expect(created.status).toBe(403);
    const assigned = await setGroups(await createCustomer(), [group.id], viewerToken);
    expect(assigned.status).toBe(403);
    // Every other write, too — and the group is as it was afterwards.
    const base = '/api/admin/customers/groups';
    expect((await request(adminApp).put(`${base}/${group.id}`).set(auth(viewerToken)).send({ name: 'Renamed' })).status).toBe(403);
    expect((await request(adminApp).post(`${base}/reorder`).set(auth(viewerToken)).send({ orderedIds: [group.id] })).status).toBe(403);
    expect((await request(adminApp).delete(`${base}/${group.id}`).set(auth(viewerToken))).status).toBe(403);
    expect(await db('customer_groups').where({ id: group.id }).first()).toMatchObject({ name: 'Permission check' });
  });

  it('refuses id lists longer than a catalogue could be', async () => {
    const customer = await createCustomer();
    const tooMany = Array.from({ length: 101 }, (_, i) => i + 1);
    expect((await setGroups(customer, tooMany)).status).toBe(400);
    const reorder = await request(adminApp).post('/api/admin/customers/groups/reorder')
      .set(auth(superToken)).send({ orderedIds: Array.from({ length: 501 }, (_, i) => i + 1) });
    expect(reorder.status).toBe(400);
  });

  it('records every change in the activity log', async () => {
    const group = bodyOf(await createGroup({ name: 'Logged' })).group;
    const customer = await createCustomer();
    await setGroups(customer, [group.id]);
    await request(adminApp).put(`/api/admin/customers/groups/${group.id}`)
      .set(auth(superToken)).send({ color: '#0F766E' });
    await setGroups(customer, []);
    await request(adminApp).delete(`/api/admin/customers/groups/${group.id}`).set(auth(superToken));

    // This group's rows only — the tests above logged the same types.
    const rows = (await db('activity_logs').whereIn('activity_type', [
      'customer_group_created', 'customer_group_updated', 'customer_groups_assigned', 'customer_group_deleted',
    ])).filter((row) => {
      const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
      return meta.groupId === group.id || (meta.customerId === customer);
    });
    for (const type of ['customer_group_created', 'customer_group_updated', 'customer_groups_assigned', 'customer_group_deleted']) {
      expect(rows.map((row) => row.activity_type)).toContain(type);
    }
    // …and every one says who did it. A bare admin id is stored as "system".
    for (const row of rows) {
      expect(row).toMatchObject({ actor_type: 'admin', actor_id: adminId });
      expect(row.actor_name).toBeTruthy();
    }
  });
});
