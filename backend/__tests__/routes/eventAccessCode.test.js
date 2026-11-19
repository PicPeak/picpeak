/**
 * Event codes (issue 2495, migration 367) on a real SQLite database.
 *
 * Public: GET /api/public/event-code/:code answers the share link's path for a
 * live gallery and one generic 404 for everything else (unknown, malformed,
 * expired, archived, draft, paused, or event codes switched off), and stops
 * a guesser after twenty misses.
 * Admin: regenerate, set a chosen code (400 invalid, 409 taken), remove it,
 * and the code is hidden from an admin who may not hand out the gallery's
 * links.
 * Creation: ensureAccessCode gives a gallery one code only while event codes
 * are on, and retries a collision.
 */
const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken,
} = require('../integration/helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'event-code-secret';

const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);

describe('event codes (issue 2495)', () => {
  let db; let cleanup; let app; let adminId; let adminToken;
  let ipCounter = 0;
  // Each test its own client address, so the miss budget of one test does
  // not leak into the next.
  const freshIp = () => { ipCounter += 1; return `198.51.100.${ipCounter}`; };

  // Event codes are opt-in (general_event_codes_enabled, default off).
  async function setCodesEnabled(on) {
    await db('app_settings').where({ setting_key: 'general_event_codes_enabled' }).del();
    if (on !== undefined) {
      await db('app_settings').insert({
        setting_key: 'general_event_codes_enabled', setting_value: JSON.stringify(on),
        setting_type: 'general', updated_at: new Date().toISOString(),
      });
    }
  }

  async function insertEvent(over = {}) {
    const slug = `code-${Math.random().toString(16).slice(2)}`;
    const token = crypto.randomBytes(16).toString('hex');
    return unwrap(await db('events').insert({
      slug, event_type: 'wedding', event_name: 'Code Gallery', event_date: '2026-08-01',
      host_email: 'host@example.com', admin_email: 'admin@example.com', password_hash: 'x',
      require_password: 1,
      share_link: `/gallery/${slug}/${token}`, share_token: token,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, temporarily_disabled: 0,
      created_by: adminId, created_at: new Date().toISOString(),
      ...over,
    }).returning('id'));
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId } = await seedMinimal(db));
    await assignAdminRole(db, adminId, 'super_admin');
    adminToken = mintAdminToken(adminId);
    await setCodesEnabled(true);

    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/public/event-code', require('../../src/routes/publicEventCode'));
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code });
    });
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  const lookup = (code, ip = freshIp()) => request(app).get(`/api/public/event-code/${encodeURIComponent(code)}`).set('X-Forwarded-For', ip);
  const admin = (req) => req.set('Authorization', `Bearer ${adminToken}`);

  describe('public lookup', () => {
    it('answers the share link path for a live gallery, whatever the input form', async () => {
      const id = await insertEvent({ access_code: 'K7M4QX' });
      const event = await db('events').where({ id }).first();
      for (const typed of ['K7M4QX', 'k7m-4qx', 'K7M 4QX']) {
        const res = await lookup(typed);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ path: event.share_link });
        expect(res.headers['cache-control']).toMatch(/no-store/);
      }
    });

    it('keeps the share link form: a short link stays short', async () => {
      const token = crypto.randomBytes(16).toString('hex');
      await insertEvent({ access_code: 'SHRT22', share_link: `/gallery/${token}`, share_token: token });
      const res = await lookup('SHRT22');
      expect(res.body).toEqual({ path: `/gallery/${token}` });
    });

    it('re-anchors a legacy absolute share link on this site', async () => {
      const token = crypto.randomBytes(16).toString('hex');
      await insertEvent({ access_code: 'ABS222', share_link: `https://old.example.com/gallery/legacy/${token}`, share_token: token });
      const res = await lookup('ABS222');
      expect(res.body).toEqual({ path: `/gallery/legacy/${token}` });
    });

    it.each([
      ['expired', 'GXNE22', { expires_at: new Date(Date.now() - 1000).toISOString() }],
      ['archived', 'GXNE23', { is_archived: 1 }],
      ['a draft', 'GXNE24', { is_draft: 1 }],
      ['deactivated', 'GXNE25', { is_active: 0 }],
      ['paused', 'GXNE26', { temporarily_disabled: 1 }],
    ])('answers the generic 404 for a gallery that is %s', async (_label, code, over) => {
      await insertEvent({ access_code: code, ...over });
      const res = await lookup(code);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Code not found', code: 'EVENT_CODE_NOT_FOUND' });
    });

    it('answers the same 404 for an unknown or malformed code', async () => {
      for (const code of ['ZZZZZZ', 'K7M0QX', 'AB', 'X'.repeat(40)]) {
        const res = await lookup(code);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Code not found', code: 'EVENT_CODE_NOT_FOUND' });
      }
    });

    it('stops a client after twenty misses, hits do not count, and then valid codes are blocked too', async () => {
      await insertEvent({ access_code: 'HXTS22' });
      const ip = freshIp();
      for (let i = 0; i < 5; i += 1) expect((await lookup('HXTS22', ip)).status).toBe(200);
      for (let i = 0; i < 20; i += 1) expect((await lookup('NXPE22', ip)).status).toBe(404);
      const limited = await lookup('HXTS22', ip);
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('EVENT_CODE_RATE_LIMITED');
      // Another client is unaffected.
      expect((await lookup('HXTS22')).status).toBe(200);
    });

    describe('with event codes switched off', () => {
      afterEach(() => setCodesEnabled(true));

      it.each([
        ['never set', undefined, 'QFFC22'],
        ['off', false, 'QFFC23'],
      ])('answers the generic 404 for a valid code (setting %s)', async (_label, value, code) => {
        await insertEvent({ access_code: code });
        expect((await lookup(code)).status).toBe(200);
        await setCodesEnabled(value);
        const res = await lookup(code);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Code not found', code: 'EVENT_CODE_NOT_FOUND' });
      });
    });
  });

  describe('admin routes', () => {
    it('regenerates a code, and the old one stops resolving', async () => {
      const id = await insertEvent({ access_code: 'XYZ222' });
      const res = await admin(request(app).post(`/api/admin/events/${id}/access-code/regenerate`));
      expect(res.status).toBe(200);
      expect(res.body.access_code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
      expect(res.body.access_code).not.toBe('XYZ222');
      expect(res.body.access_code_display).toBe(`${res.body.access_code.slice(0, 3)}-${res.body.access_code.slice(3)}`);
      expect((await db('events').where({ id }).first()).access_code).toBe(res.body.access_code);
      expect((await lookup('XYZ222')).status).toBe(404);
      expect((await lookup(res.body.access_code)).status).toBe(200);
    });

    it('sets a chosen code, normalised', async () => {
      const id = await insertEvent({ access_code: 'SET222' });
      const res = await admin(request(app).put(`/api/admin/events/${id}/access-code`).send({ code: 'mue-pper 24' }));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ access_code: 'MUEPPER24', access_code_display: 'MUEPPER24' });
      expect((await db('events').where({ id }).first()).access_code).toBe('MUEPPER24');
    });

    it('refuses a code outside the alphabet or the length', async () => {
      const id = await insertEvent({ access_code: 'VAT222' });
      for (const code of ['ABC', 'MUELLER24', 'K7M0QX', 'ABCDEFGHJKMNP', '', undefined]) {
        const res = await admin(request(app).put(`/api/admin/events/${id}/access-code`).send({ code }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_ACCESS_CODE');
      }
      expect((await db('events').where({ id }).first()).access_code).toBe('VAT222');
    });

    it('answers 409 when another gallery holds the code, and keeps saving the own code a no-op', async () => {
      await insertEvent({ access_code: 'TAKEN2' });
      const id = await insertEvent({ access_code: 'MYNE22' });
      const res = await admin(request(app).put(`/api/admin/events/${id}/access-code`).send({ code: 'taken-2' }));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ACCESS_CODE_TAKEN');
      expect((await db('events').where({ id }).first()).access_code).toBe('MYNE22');
      const same = await admin(request(app).put(`/api/admin/events/${id}/access-code`).send({ code: 'MYNE22' }));
      expect(same.status).toBe(200);
    });

    it('removes a code, and it stops resolving', async () => {
      const id = await insertEvent({ access_code: 'RMVE22' });
      expect((await lookup('RMVE22')).status).toBe(200);
      const res = await admin(request(app).delete(`/api/admin/events/${id}/access-code`));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ access_code: null, access_code_display: null });
      expect((await db('events').where({ id }).first()).access_code).toBeNull();
      expect((await lookup('RMVE22')).status).toBe(404);
      // Removing again is a no-op.
      expect((await admin(request(app).delete(`/api/admin/events/${id}/access-code`))).status).toBe(200);
    });

    it('requires an admin', async () => {
      const id = await insertEvent({ access_code: 'AUTH22' });
      expect((await request(app).post(`/api/admin/events/${id}/access-code/regenerate`)).status).toBe(401);
      expect((await request(app).put(`/api/admin/events/${id}/access-code`).send({ code: 'ABCD' })).status).toBe(401);
      expect((await request(app).delete(`/api/admin/events/${id}/access-code`)).status).toBe(401);
      expect((await db('events').where({ id }).first()).access_code).toBe('AUTH22');
    });

    it('treats the code as a gallery link: hidden from an admin who may not hand out the links', () => {
      const { withoutForeignEventSecrets } = require('../../src/middleware/ownership');
      const stripped = withoutForeignEventSecrets(
        { id: 1, created_by: 999, access_code: 'K7M4QX', share_link: '/gallery/x/y' },
        { id: 1, roleName: 'admin', permissions: ['events.view'] }
      );
      expect(stripped.access_code).toBeUndefined();
      expect(stripped.share_secrets_hidden).toBe(true);
    });

    it('does not let the generic event update write the code', async () => {
      const id = await insertEvent({ access_code: 'KEEP22' });
      const res = await admin(request(app).put(`/api/admin/events/${id}`).send({ access_code: 'HACK22', event_name: 'Renamed' }));
      expect(res.status).toBe(200);
      expect((await db('events').where({ id }).first()).access_code).toBe('KEEP22');
    });
  });

  describe('assignment on creation', () => {
    // Required lazily: db.js must not load before bootCrmDb points it at the
    // test database.
    const ensureAccessCode = (id) => require('../../src/services/eventAccessCode').ensureAccessCode(id);

    afterEach(async () => {
      jest.restoreAllMocks();
      await setCodesEnabled(true);
    });

    it('gives a new gallery no code while event codes are off', async () => {
      await setCodesEnabled(false);
      const id = await insertEvent({ access_code: null });
      expect(await ensureAccessCode(id)).toBeNull();
      expect((await db('events').where({ id }).first()).access_code).toBeNull();
    });

    it('gives a gallery without a code one, and leaves an existing code alone', async () => {
      const id = await insertEvent({ access_code: null });
      const code = await ensureAccessCode(id);
      expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
      expect(await ensureAccessCode(id)).toBe(code);
      expect((await db('events').where({ id }).first()).access_code).toBe(code);
    });

    it('retries with a fresh code when the first one is taken', async () => {
      // ALPHABET[0] six times is '222222'; hold it on another gallery.
      await insertEvent({ access_code: '222222' });
      const id = await insertEvent({ access_code: null });
      const real = crypto.randomInt;
      let calls = 0;
      jest.spyOn(crypto, 'randomInt').mockImplementation((...args) => {
        calls += 1;
        return calls <= 6 ? 0 : real(...args);
      });
      const code = await ensureAccessCode(id);
      expect(calls).toBeGreaterThan(6);
      expect(code).not.toBe('222222');
      expect((await db('events').where({ id }).first()).access_code).toBe(code);
    });
  });
});
