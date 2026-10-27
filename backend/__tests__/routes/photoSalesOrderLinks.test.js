/**
 * Photo sales: a buyer's purchase link is a credential on the gallery, so
 * it stays with the gallery's owner (the requireEventOwner rule, PR 1858).
 * A team member assigned to the gallery reads its orders, but can neither
 * copy a buyer's link nor have it emailed again.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-sales-links-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sales-links-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-sales-links-storage-'));

jest.mock('../../src/services/emailProcessor', () => ({ queueEmail: jest.fn(async () => undefined) }));
jest.mock('../../src/utils/frontendUrl', () => ({
  getFrontendBaseUrl: async () => 'https://photos.example.com',
  getFrontendBaseUrlSync: () => 'https://photos.example.com',
}));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');
const { queueEmail } = require('../../src/services/emailProcessor');

jest.setTimeout(120000);

describe('photo sales: buyer links stay with the gallery owner', () => {
  let db; let cleanup; let app;
  const tok = {};
  const id = {};
  const ORDER = 'order-links-1';
  const ACCESS_TOKEN = 'a'.repeat(48);

  const now = () => new Date().toISOString();
  const unwrap = (rows) => rows[0]?.id ?? rows[0];
  const as = (req, who) => req.set('Authorization', `Bearer ${tok[who]}`);

  async function mkAdmin(name, roleName) {
    const adminId = unwrap(await db('admin_users').insert({
      username: `links-${name}`,
      email: `links-${name}@example.com`,
      password_hash: 'x',
      must_change_password: false,
      created_at: now(),
    }).returning('id'));
    await assignAdminRole(db, adminId, roleName);
    tok[name] = mintAdminToken(adminId);
    return adminId;
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    id.owner = await mkAdmin('owner', 'editor');
    id.member = await mkAdmin('member', 'editor');

    id.event = unwrap(await db('events').insert({
      slug: 'sales-links',
      event_type: 'wedding',
      event_name: 'Sales links',
      event_date: '2026-10-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_token: 'st-sales-links',
      share_link: '/gallery/sales-links/st-sales-links',
      created_by: id.owner,
      expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      is_priced: 1,
      photo_price: 5,
      created_at: now(),
    }).returning('id'));
    await db('event_admin_assignments').insert({ event_id: id.event, admin_user_id: id.member, assigned_by: id.owner });

    await db('photo_purchase_orders').insert({
      order_id: ORDER,
      gallery_id: id.event,
      buyer_email: 'buyer@example.com',
      total_cents: 500,
      currency: 'EUR',
      status: 'completed',
      purchased_at: now(),
      expires_at: new Date(Date.now() + 10 * 864e5).toISOString(),
      access_token: ACCESS_TOKEN,
      email_sent: true,
      promo_used: false,
    });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(() => queueEmail.mockClear());

  const accessLink = (who) => as(request(app).post(`/api/admin/events/${id.event}/photo-orders/${ORDER}/access-link`), who);
  const resend = (who) => as(request(app).post(`/api/admin/events/${id.event}/photo-orders/${ORDER}/resend-email`), who);

  it('lets an assigned team member read the orders, without any link in them', async () => {
    const res = await as(request(app).get(`/api/admin/events/${id.event}/photo-orders`), 'member');
    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain(ACCESS_TOKEN);
  });

  it('refuses the buyer link and the resend to an assigned team member', async () => {
    expect((await accessLink('member')).status).toBe(403);
    expect((await resend('member')).status).toBe(403);
    expect(queueEmail).not.toHaveBeenCalled();
  });

  it('hands both to the owner', async () => {
    const link = await accessLink('owner');
    expect(link.status).toBe(200);
    expect(link.body.access_link).toContain(ACCESS_TOKEN);

    expect((await resend('owner')).status).toBe(200);
    expect(queueEmail).toHaveBeenCalledTimes(1);
  });
});
