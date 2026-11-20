/**
 * HTTP tests for the gallery QR endpoints (#836):
 *   GET /api/admin/events/:id/qr        (PNG / SVG)
 *   GET /api/admin/events/:id/qr-print  (table-card / poster PDF)
 *   GET /api/admin/events/:id/qr-print?variant=code  (fixed /code QR + event code, issue 2495)
 * Same real-SQLite harness as adminEvents.smoke.test.js.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-events-qr-')), 'db.sqlite'
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-events-qr-test-secret';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const QRCode = require('qrcode');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

async function insertEvent(db, adminId, over = {}) {
  const base = {
    slug: `ev-${Math.random().toString(16).slice(2)}`,
    event_type: 'wedding',
    event_name: 'QR Test Wedding',
    event_date: '2026-05-29',
    host_email: 'host@example.com',
    admin_email: 'admin@example.com',
    password_hash: 'x',
    share_link: `/gallery/share-${Math.random().toString(16).slice(2)}`,
    share_token: `st-${Math.random().toString(16).slice(2)}`,
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0,
    created_by: adminId,
    created_at: new Date().toISOString(),
    ...over,
  };
  const r = await db('events').insert(base).returning('id');
  return r[0]?.id ?? r[0];
}

describe('admin event QR endpoints', () => {
  let db; let cleanup; let app; let adminId; let token;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId } = await seedMinimal(db));
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code });
    });
  }, 120000);

  afterAll(async () => { await cleanup(); });

  beforeEach(async () => { await db('events').del(); });

  const auth = (req) => req.set('Authorization', `Bearer ${token}`);

  it('401s without an admin token', async () => {
    const eventId = await insertEvent(db, adminId);
    const res = await request(app).get(`/api/admin/events/${eventId}/qr`);
    expect(res.status).toBe(401);
  });

  it('returns a PNG QR by default', async () => {
    const eventId = await insertEvent(db, adminId);
    const res = await auth(request(app).get(`/api/admin/events/${eventId}/qr`)).buffer();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    // PNG magic bytes
    expect(res.body.slice(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('returns an SVG QR when requested', async () => {
    const eventId = await insertEvent(db, adminId);
    // supertest doesn't text-parse image/svg+xml — buffer and decode manually.
    const res = await auth(request(app).get(`/api/admin/events/${eventId}/qr?format=svg`)).buffer();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/svg\+xml/);
    expect(Buffer.from(res.body).toString('utf8')).toContain('<svg');
  });

  it('sets attachment disposition with download=1', async () => {
    const eventId = await insertEvent(db, adminId);
    const res = await auth(request(app).get(`/api/admin/events/${eventId}/qr?download=1`)).buffer();
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
  });

  // 30s: the print PDFs embed the full IBM Plex Sans TTFs (~200 KB each) —
  // font parsing + subsetting exceeds jest's 5s default on slower CI runners.
  it.each(['table-card', 'poster'])('renders the %s print PDF', async (template) => {
    const eventId = await insertEvent(db, adminId);
    const res = await auth(
      request(app).get(`/api/admin/events/${eventId}/qr-print?template=${template}&lang=de`)
    ).buffer();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  }, 120000);

  it('409s when the event has no share link', async () => {
    // events.share_link is NOT NULL — an empty string is the closest real-world
    // "no share link" shape (no token extractable from it either).
    const eventId = await insertEvent(db, adminId, { share_link: '', share_token: null });
    const res = await auth(request(app).get(`/api/admin/events/${eventId}/qr`));
    expect(res.status).toBe(409);
  });

  describe('event-code variant (issue 2495)', () => {
    async function setCodesEnabled(on) {
      await db('app_settings').where({ setting_key: 'general_event_codes_enabled' }).del();
      if (on !== undefined) {
        await db('app_settings').insert({
          setting_key: 'general_event_codes_enabled', setting_value: JSON.stringify(on),
          setting_type: 'general', updated_at: new Date().toISOString(),
        });
      }
    }
    const printCode = (eventId, query = '') => auth(request(app)
      .get(`/api/admin/events/${eventId}/qr-print?variant=code&origin=https://photos.example.com${query}`)).buffer();

    afterEach(async () => {
      jest.restoreAllMocks();
      await setCodesEnabled(undefined);
    });

    it.each(['table-card', 'poster'])('renders the %s with the fixed /code QR', async (template) => {
      await setCodesEnabled(true);
      const eventId = await insertEvent(db, adminId, { access_code: 'K7M4QX' });
      const qrSpy = jest.spyOn(QRCode, 'toBuffer');
      const res = await printCode(eventId, `&template=${template}&lang=de`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toContain(`qr-code-${template}-`);
      expect(res.body.slice(0, 4).toString()).toBe('%PDF');
      // The QR is the same for every event: the entry page, never the share link.
      expect(qrSpy).toHaveBeenCalledTimes(1);
      expect(qrSpy.mock.calls[0][0]).toBe('https://photos.example.com/code');
    }, 120000);

    it('409s while event codes are switched off', async () => {
      await setCodesEnabled(false);
      const eventId = await insertEvent(db, adminId, { access_code: 'K7M4QX' });
      const res = await printCode(eventId);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('EVENT_CODES_DISABLED');
    });

    it('409s when the event has no code', async () => {
      await setCodesEnabled(true);
      const eventId = await insertEvent(db, adminId, { access_code: null });
      const res = await printCode(eventId);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('EVENT_HAS_NO_CODE');
    });

    it('403s for an admin who may not act on another owner\'s gallery', async () => {
      await setCodesEnabled(true);
      const eventId = await insertEvent(db, adminId, { access_code: 'K7M4QX' });
      const ins = await db('admin_users').insert({
        username: `other-${Math.random().toString(16).slice(2)}`,
        email: `other-${Math.random().toString(16).slice(2)}@example.com`,
        password_hash: 'x', must_change_password: false, created_at: new Date().toISOString(),
      }).returning('id');
      const otherId = ins[0]?.id ?? ins[0];
      // The built-in admin role reads every gallery (events.view_all), but
      // the gallery's links and code stay its owner's.
      await assignAdminRole(db, otherId, 'admin');
      const res = await request(app)
        .get(`/api/admin/events/${eventId}/qr-print?variant=code`)
        .set('Authorization', `Bearer ${mintAdminToken(otherId)}`);
      expect(res.status).toBe(403);
    });
  });

  it('404s for a non-existent event', async () => {
    const res = await auth(request(app).get('/api/admin/events/999999/qr'));
    expect(res.status).toBe(404);
  });
});
