/**
 * A gallery expiry picked as a date is open through the END of that day in
 * the instance time zone (follow-up to issue 1975). The settings update,
 * event creation, duplication and extend all store that instant, the admin
 * detail read names the zone the settings field reads it back in, and the
 * gallery-expired email prints the picked day.
 *
 * The instance zone here is America/New_York (business_profile.timezone),
 * west of UTC, where the old midnight-UTC and the new end-of-day instants
 * fall on different UTC dates. The suite does not depend on the host's TZ.
 */
process.env.JWT_SECRET = 'expiry-end-of-day-secret-at-least-32-characters';
process.env.NODE_ENV = 'test';

const os = require('os');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'expiry-eod-'));
process.env.STORAGE_PATH = storageDir;

let db, cleanup, app, adminId, token;

const auth = (req) => req.set('Authorization', `Bearer ${token}`);
const storedExpiry = async (id) => {
  const value = (await db('events').where({ id }).first('expires_at')).expires_at;
  // SQLite text or epoch ms, Postgres Date: compare as an ISO instant.
  return new Date(/^\d+$/.test(String(value)) ? Number(value) : value).toISOString();
};
const setSetting = (key, value) => db('app_settings')
  .insert({ setting_key: key, setting_value: JSON.stringify(value), setting_type: typeof value === 'boolean' ? 'boolean' : 'string' })
  .onConflict('setting_key').merge({ setting_value: JSON.stringify(value) });

async function insertEvent(over = {}) {
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inserted = await db('events').insert({
    slug: `expiry-eod-${key}`,
    event_type: 'wedding', event_name: 'Expiry', event_date: '2026-11-20',
    customer_name: 'Anna', customer_email: 'anna@example.com', host_name: 'Anna', host_email: 'anna@example.com',
    admin_email: 'admin@example.com', password_hash: 'x',
    share_link: `/gallery/expiry-eod-${key}/tok`, share_token: `tok-${key}`,
    expires_at: '2026-12-20T00:00:00.000Z',
    is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId,
    created_at: new Date().toISOString(),
    ...over,
  }).returning('id');
  return inserted[0]?.id ?? inserted[0];
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  await db('business_profile').where({ id: 1 }).update({ timezone: 'America/New_York' });
  app = express(); app.use(express.json()); app.use(cookieParser());
  app.use('/api/admin/events', require('../../src/routes/adminEvents'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => { res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code }); });
}, 120000);

afterAll(async () => {
  await cleanup();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe('the settings date field (PUT /:id)', () => {
  it('stores a bare date as the end of that day in the instance zone', async () => {
    const id = await insertEvent();
    const res = await auth(request(app).put(`/api/admin/events/${id}`)).send({ expires_at: '2026-12-24' });
    expect(res.status).toBe(200);
    // 23:59:59.999 EST on 24 Dec; midnight UTC would close it at 19:00 on the 23rd.
    expect(await storedExpiry(id)).toBe('2026-12-25T04:59:59.999Z');
  });

  it('keeps a full date-time as the instant it names', async () => {
    const id = await insertEvent();
    await auth(request(app).put(`/api/admin/events/${id}`)).send({ expires_at: '2026-12-24T10:00:00Z' });
    expect(await storedExpiry(id)).toBe('2026-12-24T10:00:00.000Z');
  });

  it('refuses a date that does not exist', async () => {
    const id = await insertEvent();
    const res = await auth(request(app).put(`/api/admin/events/${id}`)).send({ expires_at: '2026-02-30' });
    expect(res.status).toBe(400);
    expect(await storedExpiry(id)).toBe('2026-12-20T00:00:00.000Z');
  });

  it('the detail read names the zone the field reads expires_at back in', async () => {
    const id = await insertEvent();
    const res = await auth(request(app).get(`/api/admin/events/${id}`));
    expect(res.status).toBe(200);
    expect(res.body.expiry_time_zone).toBe('America/New_York');
  });

  it('public settings name the same zone, for the lists and the guest gallery', async () => {
    const publicApp = express();
    publicApp.use('/api/public/settings', require('../../src/routes/publicSettings'));
    const res = await request(publicApp).get('/api/public/settings');
    expect(res.status).toBe(200);
    expect(res.body.expiry_time_zone).toBe('America/New_York');
  });
});

describe('event creation (POST /)', () => {
  const create = (body) => auth(request(app).post('/api/admin/events')).send({
    event_type: 'wedding', event_name: `Created ${Math.random().toString(36).slice(2, 8)}`,
    customer_name: 'Client Person', customer_email: 'client@example.com', admin_email: 'admin@example.com',
    require_password: false, is_draft: true, ...body,
  });

  beforeAll(async () => { await setSetting('event_require_expiration', true); });

  it('ends the day count at the end of its last day in the instance zone', async () => {
    const res = await create({ event_date: '2026-11-20', expiration_days: 30 });
    expect(res.status).toBe(200);
    expect(await storedExpiry(res.body.id)).toBe('2026-12-21T04:59:59.999Z');
  });

  it('treats a bare expires_at as the end of that day too', async () => {
    const res = await create({ event_date: '2026-11-20', expires_at: '2026-12-24' });
    expect(res.status).toBe(200);
    expect(await storedExpiry(res.body.id)).toBe('2026-12-25T04:59:59.999Z');
  });
});

describe('duplication (POST /:id/duplicate)', () => {
  const duplicate = (id, body) => auth(request(app).post(`/api/admin/events/${id}/duplicate`)).send({
    event_name: `Copy ${Math.random().toString(36).slice(2, 8)}`, ...body,
  });

  it('keeps the source window in calendar days and ends on the last one', async () => {
    const source = await insertEvent({ event_date: '2026-11-20', expires_at: '2026-12-25T04:59:59.999Z' }); // 24 Dec, end of day
    const res = await duplicate(source, { event_date: '2027-01-10' });
    expect(res.status).toBe(200);
    // 34 days, as the source: 13 Feb 2027, end of day in New York.
    expect(await storedExpiry(res.body.id)).toBe('2027-02-14T04:59:59.999Z');
  });

  it('reads an old midnight-UTC source as the date it was picked for', async () => {
    const source = await insertEvent({ event_date: '2026-11-20', expires_at: '2026-12-24T00:00:00.000Z' });
    const res = await duplicate(source, { event_date: '2027-01-10' });
    expect(res.status).toBe(200);
    expect(await storedExpiry(res.body.id)).toBe('2027-02-14T04:59:59.999Z');
  });
});

describe('extend (POST /:id/extend)', () => {
  const extend = (id, days) => auth(request(app).post(`/api/admin/events/${id}/extend`)).send({ days });

  it('stays at the end of the day across the switch from EDT to EST', async () => {
    const id = await insertEvent({ expires_at: '2026-10-29T03:59:59.999Z' }); // 28 Oct, end of day (EDT)
    const res = await extend(id, 7);
    expect(res.status).toBe(200);
    expect(await storedExpiry(id)).toBe('2026-11-05T04:59:59.999Z'); // 4 Nov, end of day (EST)
  });

  it('refuses a gallery without an expiry instead of setting one in 1970', async () => {
    const id = await insertEvent({ expires_at: null });
    expect((await extend(id, 7)).status).toBe(400);
    expect((await db('events').where({ id }).first('expires_at')).expires_at).toBeNull();
  });
});

describe('the expiry date in emails', () => {
  it('prints the picked day, not the UTC date of the instant', async () => {
    const { renderQueuedEmail } = require('../../src/services/emailProcessor');
    await setSetting('general_date_format', { format: 'YYYY-MM-DD', locale: 'en-GB' });
    const rendered = await renderQueuedEmail('gallery_expired', {
      __language: 'en', host_name: 'Anna', event_name: 'Expiry', event_date: '2026-11-20',
      expiry_date: '2026-12-25T04:59:59.999Z',
    });
    expect(rendered).not.toBeNull();
    expect(rendered.html).toContain('expired on 2026-12-24');
    expect(rendered.html).not.toContain('2026-12-25');
  });
});
