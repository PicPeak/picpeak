/**
 * Guest identity before downloading (issue 2503) survives the two other ways a
 * gallery's feedback settings are written: creating the gallery, whose form
 * offers the switch and the privacy note, and duplicating one. A gallery set
 * up to ask for the guest's name must not come out downloading anonymously.
 */
process.env.JWT_SECRET = 'guest-download-carry-over-secret-at-least-32-chars';
process.env.NODE_ENV = 'test';

const os = require('os');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('./helpers/crmDb');

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-download-carry-over-'));
process.env.STORAGE_PATH = storageDir;

let db; let cleanup; let app; let adminId; let token;

const idOf = (r) => Number(r[0]?.id ?? r[0]);
const auth = (req) => req.set('Authorization', `Bearer ${token}`);
const settingsOf = (eventId) => db('event_feedback_settings').where({ event_id: eventId }).first();

const base = {
  event_type: 'wedding', event_date: '2026-09-01', customer_name: 'C', customer_email: 'c@example.com',
  admin_email: 'a@example.com', require_password: false, expiration_days: 30,
  feedback_enabled: true, identity_mode: 'guest',
};

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  app = express(); app.use(express.json()); app.use(cookieParser());
  app.use('/api/admin/events', require('../../src/routes/adminEvents'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => { res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code }); });
}, 120000);

afterAll(async () => {
  await cleanup();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe('creating a gallery', () => {
  // Required lazily: db.js binds its file on first load, after bootCrmDb.
  const createEvent = (...args) => require('../../src/services/eventCreationService').createEvent(...args);

  it('stores the switch and the trimmed privacy note', async () => {
    const created = await createEvent({
      ...base, event_name: 'Guest download on',
      require_guest_for_download: true, guest_privacy_text: '  Only for the album.  ',
    }, { actor: { id: adminId } });
    const row = await settingsOf(created.id);
    expect(Boolean(row.require_guest_for_download)).toBe(true);
    expect(row.guest_privacy_text).toBe('Only for the album.');
  });

  it('leaves both off when the request omits them', async () => {
    const created = await createEvent({ ...base, event_name: 'Guest download default' }, { actor: { id: adminId } });
    const row = await settingsOf(created.id);
    expect(Boolean(row.require_guest_for_download)).toBe(false);
    expect(row.guest_privacy_text).toBeNull();
  });

  it('refuses a privacy note that is too long or not text', async () => {
    for (const guest_privacy_text of ['x'.repeat(1001), 42]) {
      await expect(createEvent({ ...base, event_name: 'Guest download bad', guest_privacy_text }, { actor: { id: adminId } }))
        .rejects.toMatchObject({ statusCode: 400 });
    }
  });
});

describe('duplicating a gallery', () => {
  it('copies the switch and the privacy note', async () => {
    const key = Math.random().toString(36).slice(2, 8);
    const source = idOf(await db('events').insert({
      slug: `guest-dl-src-${key}`,
      event_type: 'wedding', event_name: 'Guest download source', event_date: '2026-11-20',
      customer_name: 'Anna', customer_email: 'anna@example.com', host_name: 'Anna', host_email: 'anna@example.com',
      admin_email: 'admin@example.com', password_hash: 'x',
      share_link: `/gallery/guest-dl-src-${key}/tok`, share_token: `tok-${key}`,
      expires_at: '2026-12-20T00:00:00.000Z',
      is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId,
      created_at: new Date().toISOString(),
    }).returning('id'));
    await db('event_feedback_settings').insert({
      event_id: source, feedback_enabled: true, identity_mode: 'guest',
      require_guest_for_download: true, guest_privacy_text: 'Only for the album.',
    });

    const res = await auth(request(app).post(`/api/admin/events/${source}/duplicate`))
      .send({ event_name: `Copy ${key}` });
    expect(res.status).toBe(200);

    const row = await settingsOf(res.body.id);
    expect(Boolean(row.require_guest_for_download)).toBe(true);
    expect(row.guest_privacy_text).toBe('Only for the album.');
  });
});
