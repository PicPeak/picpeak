/**
 * The customer detail lists the customer's galleries the way the events API
 * shows them to the caller: every gallery for roles that see all events,
 * otherwise only galleries the caller owns, is assigned to, or that have no
 * owner. GET /admin/events/:id answers 404 for the rest, so the customer
 * record must not list them either.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-custevents-')), 'db.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'custevents-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-custevents-storage-'));

const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp } = require('../integration/helpers/crmDb');
const { clearPermissionCache } = require('../../src/middleware/permissions');

describe('GET /admin/customers/:id and event visibility', () => {
  let db; let cleanup; let app; let customerId;
  let superTok; let teamTok; let studioTok;
  let foreignEvent; let ownEvent; let ownerlessEvent; let assignedEvent;

  const insertAdmin = async (username, role) => {
    const [row] = await db('admin_users').insert({
      username, email: `${username}@example.com`, password_hash: 'x',
      must_change_password: false, is_active: true, created_at: new Date(),
    }).returning('id');
    const id = row?.id ?? row;
    await assignAdminRole(db, id, role);
    return id;
  };
  const insertEvent = async (slug, createdBy) => {
    const [row] = await db('events').insert({
      slug, event_name: slug, event_type: 'wedding', event_date: '2026-06-01',
      share_link: `/gallery/${slug}`, share_token: `${slug}-token`.padEnd(32, 'x'), password_hash: 'x',
      expires_at: '2027-01-01', created_by: createdBy, created_at: new Date().toISOString(),
    }).returning('id');
    const id = row?.id ?? row;
    await db('event_customer_assignments').insert({ event_id: id, customer_account_id: customerId, assigned_at: new Date().toISOString() });
    return id;
  };
  const eventIds = async (tok) => {
    const res = await request(app).get(`/api/admin/customers/${customerId}`).set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    return res.body.customer.events.map((e) => e.id).sort((a, b) => a - b);
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    let superId;
    ({ adminId: superId, customerId } = await seedMinimal(db));
    await assignAdminRole(db, superId, 'super_admin');
    superTok = mintAdminToken(superId);
    const teamId = await insertAdmin('team_member', 'team_photographer');
    teamTok = mintAdminToken(teamId);
    const studioId = await insertAdmin('studio_admin', 'admin');
    studioTok = mintAdminToken(studioId);

    foreignEvent = await insertEvent('foreign-gallery', superId);
    ownEvent = await insertEvent('own-gallery', teamId);
    ownerlessEvent = await insertEvent('ownerless-gallery', null);
    assignedEvent = await insertEvent('assigned-gallery', superId);
    await db('event_admin_assignments').insert({ event_id: assignedEvent, admin_user_id: teamId, assigned_by: superId });
    clearPermissionCache();
    app = buildRouteApp('/api/admin/customers', require('../../src/routes/adminCustomers'));
  }, 120000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('leaves out galleries an event-scoped admin cannot open', async () => {
    expect(await eventIds(teamTok)).toEqual([ownEvent, ownerlessEvent, assignedEvent].sort((a, b) => a - b));
  });

  it('leaves them out of the record a save returns too', async () => {
    const editRole = await db('roles').insert({ name: 'customer_editor_team', display_name: 'Customer editor', priority: 10 }).returning('id');
    const roleId = editRole[0]?.id ?? editRole[0];
    const perms = await db('permissions').whereIn('name', ['customers.view', 'customers.edit', 'events.view']).select('id');
    await db('role_permissions').insert(perms.map((p) => ({ role_id: roleId, permission_id: p.id })));
    const [row] = await db('admin_users').insert({
      username: 'customer_editor', email: 'customer_editor@example.com', password_hash: 'x',
      must_change_password: false, is_active: true, role_id: roleId, created_at: new Date(),
    }).returning('id');
    const editorTok = mintAdminToken(row?.id ?? row);
    clearPermissionCache();
    const res = await request(app).put(`/api/admin/customers/${customerId}`)
      .set('Authorization', `Bearer ${editorTok}`).send({ display_name: 'Test Customer' });
    expect(res.status).toBe(200);
    expect(res.body.customer.events.map((e) => e.id)).toEqual([ownerlessEvent]);
  });

  it('lists every gallery for roles that see all events', async () => {
    const all = [foreignEvent, ownEvent, ownerlessEvent, assignedEvent].sort((a, b) => a - b);
    expect(await eventIds(superTok)).toEqual(all);
    expect(await eventIds(studioTok)).toEqual(all);
  });
});
