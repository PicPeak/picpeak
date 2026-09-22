/**
 * Customer groups outside the Customers page (#1443).
 *
 * The customer search behind the pickers, the event detail and the project
 * cockpit carry each customer's groups, so an admin sees the segment without
 * opening the record. The event and project routes are guarded by
 * events.view, not customers.view, so the groups ride along only for an
 * admin who may read customers — the field is absent otherwise.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';

const request = require('supertest');
const express = require('express');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let app;
let superToken;
let eventsOnlyToken;
let customerId;
let groupId;
let eventId;
let projectId;

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const idOf = (inserted) => (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]);
const bodyOf = (res) => res.body.data || res.body;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const seeded = await seedMinimal(db);
  customerId = seeded.customerId;
  await assignAdminRole(db, seeded.adminId, 'super_admin');
  superToken = mintAdminToken(seeded.adminId);

  // events.view and nothing on customers.
  const roleId = idOf(await db('roles').insert({
    name: 'events-only', display_name: 'Events only', is_system: false,
  }).returning('id'));
  const permission = await db('permissions').where({ name: 'events.view' }).first();
  await db('role_permissions').insert({ role_id: roleId, permission_id: permission.id });
  const eventsOnlyId = idOf(await db('admin_users').insert({
    username: 'events-only', email: 'events-only@example.com', password_hash: 'x',
    must_change_password: false, role_id: roleId, created_at: new Date().toISOString(),
  }).returning('id'));
  eventsOnlyToken = mintAdminToken(eventsOnlyId);

  await db('feature_flags').insert({ key: 'projects', value: 1 }).onConflict('key').merge({ value: 1 });
  groupId = idOf(await db('customer_groups').insert({
    name: 'Context VIP', name_key: 'context vip', color: '#B91C1C', sort_order: 1,
    is_archived: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).returning('id'));
  await db('customer_group_members').insert({ group_id: groupId, customer_account_id: customerId });

  projectId = idOf(await db('projects').insert({
    name: 'Context project', status: 'active', customer_account_id: customerId, created_by: eventsOnlyId,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).returning('id'));
  eventId = idOf(await db('events').insert({
    slug: 'context-event', event_type: 'other', event_name: 'Context event', event_date: '2026-09-01',
    host_email: 'host@example.com', admin_email: 'admin@example.com', password_hash: 'x',
    share_link: 'context-event-share', expires_at: new Date(Date.now() + 86400000).toISOString(),
    created_by: eventsOnlyId, project_id: projectId,
  }).returning('id'));
  await db('event_customer_assignments').insert({ event_id: eventId, customer_account_id: customerId });

  app = express();
  app.use(express.json());
  app.use('/api/admin/customers', buildRouteApp('/', require('../../src/routes/adminCustomers')));
  app.use('/api/admin/events', buildRouteApp('/', require('../../src/routes/adminEvents')));
  app.use('/api/admin/projects', buildRouteApp('/', require('../../src/routes/adminProjects')));
});

afterAll(async () => { if (cleanup) await cleanup(); });

const expectVip = (groups) => expect(groups).toEqual([expect.objectContaining({ id: groupId, name: 'Context VIP' })]);

it('carries the groups on the customer search the pickers use', async () => {
  const res = await request(app).get('/api/admin/customers/search?q=customer@').set(auth(superToken));
  expect(res.status).toBe(200);
  expectVip(res.body.customers.find((c) => c.id === customerId).groups);
});

it('carries the groups on the event detail, only with customers.view', async () => {
  const withView = await request(app).get(`/api/admin/events/${eventId}`).set(auth(superToken));
  expect(withView.status).toBe(200);
  expectVip(withView.body.customer_accounts.find((c) => c.id === customerId).groups);

  const without = await request(app).get(`/api/admin/events/${eventId}`).set(auth(eventsOnlyToken));
  expect(without.status).toBe(200);
  const assigned = without.body.customer_accounts.find((c) => c.id === customerId);
  expect(assigned).toBeDefined();
  expect(assigned).not.toHaveProperty('groups');
});

it('still answers the event detail, without groups, when the group lookup fails', async () => {
  const service = require('../../src/services/customerGroupsService');
  const spy = jest.spyOn(service, 'groupsForCustomers').mockRejectedValue(new Error('boom'));
  try {
    const res = await request(app).get(`/api/admin/events/${eventId}`).set(auth(superToken));
    expect(res.status).toBe(200);
    expect(res.body.customer_accounts.find((c) => c.id === customerId)).not.toHaveProperty('groups');
  } finally {
    spy.mockRestore();
  }
});

it('carries the customer\'s groups on the project cockpit, only with customers.view', async () => {
  const withView = await request(app).get(`/api/admin/projects/${projectId}/overview`).set(auth(superToken));
  expect(withView.status).toBe(200);
  expectVip(bodyOf(withView).project.customerGroups);

  const without = await request(app).get(`/api/admin/projects/${projectId}/overview`).set(auth(eventsOnlyToken));
  expect(without.status).toBe(200);
  expect(bodyOf(without).project.customerAccountId).toBe(customerId);
  expect(bodyOf(without).project).not.toHaveProperty('customerGroups');
});
