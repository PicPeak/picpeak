/**
 * Parcel tracking for an album order (issue 2422): the admin routes, the
 * customer mail and the portal dashboard, through the real routes on SQLite.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID: uuid } = require('crypto');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'album-shipments-')), 'db.sqlite');
process.env.JWT_SECRET = 'album-shipments-tests-long-secret-not-production';
process.env.DATABASE_CLIENT = 'sqlite3';

const request = require('supertest');
const express = require('express');
const { bootCrmDb, seedMinimal, mintAdminToken } = require('./helpers/crmDb');

const idOf = (rows) => rows[0].id ?? rows[0];

describe('album shipments', () => {
  let db; let cleanup; let app; let owner; let viewer;
  const auth = (id = owner) => `Bearer ${mintAdminToken(id)}`;
  const base = (gallery, offer) => `/api/admin/album-products/events/${gallery}/offers/${offer}/shipments`;
  const add = (gallery, offer, body, id = owner) => request(app).post(base(gallery, offer)).set('Authorization', auth(id)).send(body);
  const mails = (to) => db('email_queue').where({ email_type: 'album_shipped', recipient_email: to });

  async function role(name, permissions) {
    const roleId = idOf(await db('roles').insert({ name, display_name: name }).returning('id'));
    for (const p of await db('permissions').whereIn('name', permissions))
      await db('role_permissions').insert({ role_id: roleId, permission_id: p.id });
    return roleId;
  }
  async function customer(extra = {}) {
    return idOf(await db('customer_accounts').insert({
      email: `${uuid()}@example.test`, display_name: 'Customer', is_active: true, password_hash: 'x', ...extra,
    }).returning('id'));
  }
  async function gallery(customers = [], createdBy = owner) {
    const slug = `ship-${uuid().slice(0, 8)}`;
    const id = idOf(await db('events').insert({
      slug, event_name: `Wedding ${slug}`, event_type: 'wedding', event_date: '2026-10-01', host_email: 'client@example.com',
      admin_email: 'studio@example.com', password_hash: 'x', share_link: `/gallery/${slug}/share`, share_token: uuid(),
      is_active: true, is_archived: false, is_draft: false, require_password: true, created_by: createdBy,
      expires_at: new Date(Date.now() + 864e5).toISOString(),
    }).returning('id'));
    for (const c of customers) await db('event_customer_assignments').insert({ event_id: id, customer_account_id: c });
    return id;
  }
  async function offer(eventId, { status = 'submitted', released = null, billing = null } = {}) {
    const id = uuid();
    await db('event_album_products').insert({
      id, event_id: eventId, product_id: uuid(), released_customer_id: released, billing_customer_id: billing,
      enabled: true, revision: 2, status,
      selection: JSON.stringify({ product: { name: 'Fine Art Album' }, clientFinal: true }),
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    return id;
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId: owner } = await seedMinimal(db));
    viewer = idOf(await db('admin_users').insert({ username: 'viewer', email: 'viewer@example.com', password_hash: 'x', must_change_password: false }).returning('id'));
    await db('admin_users').where({ id: owner }).update({ role_id: await role('ship_all', ['products.view', 'products.configure', 'events.view']) });
    await db('admin_users').where({ id: viewer }).update({ role_id: await role('ship_view', ['products.view', 'events.view']) });
    await db('feature_flags').where({ key: 'albumProducts' }).update({ value: true });
    require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
    require('../../src/middleware/permissions').clearPermissionCache();
    app = express();
    app.use(express.json());
    app.use('/api/admin/album-products', require('../../src/routes/adminAlbumProducts'));
    app.get('/api/customer/dashboard', async (req, res) => res.json(
      await require('../../src/services/customerPortalService').getDashboard(Number(req.headers['x-customer'])),
    ));
    app.use((err, req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
  }, 180000);

  afterAll(async () => {
    await require('../../src/services/serviceShutdown').stopServices?.();
    if (cleanup) await cleanup();
  });

  test('the migration can run and roll back twice', async () => {
    const migration = require('../../migrations/core/350_album_shipments');
    await migration.up(db);
    await migration.down(db);
    await migration.down(db);
    expect(await db.schema.hasTable('album_shipments')).toBe(false);
    await migration.up(db);
    await migration.up(db);
    expect(await db.schema.hasColumn('album_shipments', 'tracking_url')).toBe(true);
  });

  test('records a parcel, builds the carrier link and mails the order\'s customer', async () => {
    const c = await customer({ preferred_language: 'de' });
    const g = await gallery([c]);
    const o = await offer(g);
    const res = await add(g, o, { carrier: 'dhl', trackingNumber: ' 00340434 1612 ' });
    expect(res.status).toBe(201);
    expect(res.body.notification).toBe('queued');
    expect(res.body.shipment).toMatchObject({
      carrier: 'dhl', trackingNumber: '00340434 1612',
      trackingUrl: 'https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=00340434%201612',
    });
    expect(res.body.shipment.notifiedAt).toBeTruthy();
    const { email } = await db('customer_accounts').where({ id: c }).first();
    const queued = await mails(email);
    expect(queued).toHaveLength(1);
    const listed = await request(app).get(base(g, o)).set('Authorization', auth());
    expect(listed.status).toBe(200);
    expect(listed.body.recipient).toMatchObject({ id: c, email });
    expect(listed.body.shipments).toHaveLength(1);
  });

  test('sends nothing when the studio unticks the mail', async () => {
    const c = await customer();
    const g = await gallery([c]);
    const o = await offer(g, { status: 'locked' });
    const res = await add(g, o, { carrier: 'ups', trackingNumber: '1Z999AA10123456784', notify: false });
    expect(res.status).toBe(201);
    expect(res.body.notification).toBe('off');
    expect(res.body.shipment.notifiedAt).toBeNull();
    const { email } = await db('customer_accounts').where({ id: c }).first();
    expect(await mails(email)).toHaveLength(0);
  });

  test('a gallery opened by PIN alone has nobody to notify but still records the parcel', async () => {
    const g = await gallery([]);
    const o = await offer(g);
    const listed = await request(app).get(base(g, o)).set('Authorization', auth());
    expect(listed.body.recipient).toBeNull();
    const res = await add(g, o, { carrier: 'gls', trackingNumber: '12345678901' });
    expect(res.status).toBe(201);
    expect(res.body.notification).toBe('skipped');
  });

  test('refuses an unconfirmed order, an unknown carrier, a bad number and a non-http link', async () => {
    const g = await gallery([await customer()]);
    expect((await add(g, await offer(g, { status: 'draft' }), { carrier: 'dhl', trackingNumber: '123' })).status).toBe(409);
    const o = await offer(g);
    expect((await add(g, o, { carrier: 'pigeon', trackingNumber: '123' })).status).toBe(400);
    expect((await add(g, o, { carrier: 'dhl', trackingNumber: '' })).status).toBe(400);
    expect((await add(g, o, { carrier: 'dhl', trackingNumber: '<script>' })).status).toBe(400);
    expect((await add(g, o, { carrier: 'other', trackingNumber: '123', trackingUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await add(g, o, { carrier: 'other', trackingNumber: '123', trackingUrl: 'ftp://example.com/x' })).status).toBe(400);
    const other = await add(g, o, { carrier: 'other', trackingNumber: 'AB-1', trackingUrl: 'https://track.example.com/AB-1', notify: false });
    expect(other.status).toBe(201);
    expect(other.body.shipment.trackingUrl).toBe('https://track.example.com/AB-1');
    // A known carrier's link is always built, never taken from the request.
    const known = await add(g, o, { carrier: 'dpd', trackingNumber: '0123/45', trackingUrl: 'https://evil.example', notify: false });
    expect(known.body.shipment.trackingUrl).toBe('https://tracking.dpd.de/status/de_DE/parcel/0123%2F45');
  });

  test('needs products.configure to add or delete, and products.view to list', async () => {
    // No owner: both admins pass the gallery check, only the permission differs.
    const g = await gallery([await customer()], null);
    const o = await offer(g);
    expect((await add(g, o, { carrier: 'dhl', trackingNumber: '1' }, viewer)).status).toBe(403);
    expect((await request(app).get(base(g, o)).set('Authorization', auth(viewer))).status).toBe(200);
    const created = await add(g, o, { carrier: 'dhl', trackingNumber: '1', notify: false });
    expect(created.status).toBe(201);
    const id = created.body.shipment.id;
    expect((await request(app).delete(`${base(g, o)}/${id}`).set('Authorization', auth(viewer))).status).toBe(403);
    // Another gallery's offer path cannot reach this shipment.
    const g2 = await gallery([]);
    const o2 = await offer(g2);
    expect((await request(app).delete(`${base(g2, o2)}/${id}`).set('Authorization', auth())).status).toBe(404);
    expect((await request(app).delete(`${base(g, o)}/${id}`).set('Authorization', auth())).status).toBe(204);
    expect(await db('album_shipments').where({ id })).toHaveLength(0);
  });

  test('the portal dashboard lists only the customer\'s own parcels', async () => {
    const anna = await customer();
    const ben = await customer();
    const shared = await gallery([anna, ben]);
    const annas = await offer(shared, { released: anna });
    const bens = await offer(shared, { released: ben });
    // Shared gallery, nobody named on the offer and nobody billed: nobody's.
    const nobodys = await offer(shared);
    const own = await gallery([anna]);
    const sole = await offer(own);
    await add(shared, annas, { carrier: 'hermes', trackingNumber: 'H1', notify: false });
    await add(shared, bens, { carrier: 'hermes', trackingNumber: 'B1', notify: false });
    await add(shared, nobodys, { carrier: 'hermes', trackingNumber: 'N1', notify: false });
    await add(own, sole, { carrier: 'fedex', trackingNumber: 'F1', notify: false });
    const dashboard = async (id) => (await request(app).get('/api/customer/dashboard').set('x-customer', String(id))).body;
    const forAnna = (await dashboard(anna)).shipments;
    expect(forAnna.map((s) => s.trackingNumber).sort()).toEqual(['F1', 'H1']);
    expect(forAnna[0]).toMatchObject({ productName: 'Fine Art Album', eventName: expect.stringMatching(/^Wedding /) });
    expect((await dashboard(ben)).shipments.map((s) => s.trackingNumber)).toEqual(['B1']);
    const stranger = await customer();
    expect((await dashboard(stranger)).shipments).toEqual([]);
  });

  test('a customer erasure forgets the tracking numbers of their own orders', async () => {
    const c = await customer();
    const g = await gallery([c]);
    const o = await offer(g, { released: c });
    await add(g, o, { carrier: 'dhl', trackingNumber: 'E1', notify: false });
    await db.transaction((tx) => require('../../src/services/albumProducts/shipments').forgetCustomer(tx, c));
    expect(await db('album_shipments').where({ offer_id: o })).toHaveLength(0);
  });
});
