/**
 * HTTP route tests for the ADMIN Live Slideshow endpoints:
 *   POST  /api/admin/events/:id/slideshow/generate
 *   POST  /api/admin/events/:id/slideshow/disable
 *   PATCH /api/admin/events/:id/slideshow
 *   PUT   /api/admin/settings/slideshow          (global preset + watermark + fit)
 *
 * Pins the contracts + the two regressions hit during the build:
 *   - the events table has NO `updated_at` column, so these writes must NOT set
 *     it (else every call 500s — that was the original "Generate" failure);
 *   - the `slideshow` feature flag gates these endpoints (403 when off);
 *   - PUT /admin/settings/slideshow validates + clamps every key.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-show-admin-')), 'db.sqlite'
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'slideshow-test-secret';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');
const { invalidateFeatureFlagCache } = require('../../src/middleware/requireFeatureFlag');

async function setFlag(db, key, on) {
  await db('feature_flags').where({ key }).del();
  await db('feature_flags').insert({ key, value: on ? 1 : 0 });
  invalidateFeatureFlagCache();
}

async function insertEvent(db, adminId, over = {}) {
  const base = {
    slug: `ev-${Math.random().toString(16).slice(2)}`,
    event_type: 'wedding',
    event_name: 'Test Wedding',
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

describe('admin Live Slideshow endpoints', () => {
  let db; let cleanup; let app; let adminId; let token;

  // Match slideshowPublic.test.js — bootCrmDb's full migration run intermittently
  // exceeds Jest's default 5s `beforeAll` timeout on slower CI runners; raise
  // it so this doesn't block PRs.
  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId } = await seedMinimal(db));
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
    app.use('/api/admin/settings', require('../../src/routes/adminSettings'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code });
    });
  }, 30000);

  afterAll(async () => { await cleanup(); });

  beforeEach(async () => {
    await db('events').del();
    await db('app_settings').del();
    await setFlag(db, 'slideshow', true);
  });

  const auth = (req) => req.set('Authorization', `Bearer ${token}`);

  describe('generate / disable', () => {
    it('mints a share token (no updated_at column → must not 500)', async () => {
      const id = await insertEvent(db, adminId);
      const res = await auth(request(app).post(`/api/admin/events/${id}/slideshow/generate`));
      expect(res.status).toBe(200);
      expect(typeof res.body.show_share_token).toBe('string');
      expect(res.body.show_share_token).toHaveLength(64);
      expect(res.body.slideshow_url).toContain(`/show/${res.body.show_share_token}`);
      const row = await db('events').where({ id }).first();
      expect(row.show_share_token).toBe(res.body.show_share_token);
    });

    it('regenerate rotates the token', async () => {
      const id = await insertEvent(db, adminId, { show_share_token: 'old-token' });
      const res = await auth(request(app).post(`/api/admin/events/${id}/slideshow/generate`));
      expect(res.status).toBe(200);
      expect(res.body.show_share_token).not.toBe('old-token');
    });

    it('disable nulls the token', async () => {
      const id = await insertEvent(db, adminId, { show_share_token: 'live-token' });
      const res = await auth(request(app).post(`/api/admin/events/${id}/slideshow/disable`));
      expect(res.status).toBe(200);
      const row = await db('events').where({ id }).first();
      expect(row.show_share_token == null).toBe(true);
    });

    it('403 when the slideshow feature is off', async () => {
      const id = await insertEvent(db, adminId);
      await setFlag(db, 'slideshow', false);
      const res = await auth(request(app).post(`/api/admin/events/${id}/slideshow/generate`));
      expect(res.status).toBe(403);
    });

    it('401 without an admin token', async () => {
      const id = await insertEvent(db, adminId);
      const res = await request(app).post(`/api/admin/events/${id}/slideshow/generate`);
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /:id/slideshow', () => {
    it('persists display + watermark mode (no updated_at column → must not 500)', async () => {
      const id = await insertEvent(db, adminId);
      const res = await auth(request(app).patch(`/api/admin/events/${id}/slideshow`)).send({
        show_interval_ms: 9000,
        show_transition: 'cut',
        show_transition_ms: 300,
        show_watermark: true,
        show_colorfilter: 'bw',
      });
      expect(res.status).toBe(200);
      const row = await db('events').where({ id }).first();
      expect(row.show_interval_ms).toBe(9000);
      expect(row.show_transition).toBe('cut');
      expect(row.show_transition_ms).toBe(300);
      expect(row.show_colorfilter).toBe('bw');
      expect(row.show_watermark === 1 || row.show_watermark === true).toBe(true);
    });

    it('show_watermark=null sets the column to NULL (inherit global)', async () => {
      const id = await insertEvent(db, adminId, { show_watermark: 1 });
      const res = await auth(request(app).patch(`/api/admin/events/${id}/slideshow`)).send({ show_watermark: null });
      expect(res.status).toBe(200);
      const row = await db('events').where({ id }).first();
      expect(row.show_watermark == null).toBe(true);
    });

    it('400 on an invalid transition', async () => {
      const id = await insertEvent(db, adminId);
      const res = await auth(request(app).patch(`/api/admin/events/${id}/slideshow`)).send({ show_transition: 'wormhole' });
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/admin/settings/slideshow', () => {
    const getSetting = async (key) => {
      const row = await db('app_settings').where({ setting_key: key }).first();
      return row ? JSON.parse(row.setting_value) : undefined;
    };

    it('persists the global preset + watermark + fit, clamping out-of-range values', async () => {
      const res = await auth(request(app).put('/api/admin/settings/slideshow')).send({
        slideshow_fit: 'contain',
        slideshow_interval_ms: 9000,
        slideshow_transition: 'slide',
        slideshow_transition_ms: 250,
        slideshow_colorfilter: 'sepia',
        slideshow_watermark_enabled: true,
        slideshow_watermark_opacity: 999,   // clamp -> 100
        slideshow_watermark_size: 99,       // clamp -> 40
      });
      expect(res.status).toBe(200);
      expect(await getSetting('slideshow_fit')).toBe('contain');
      expect(await getSetting('slideshow_interval_ms')).toBe(9000);
      expect(await getSetting('slideshow_transition')).toBe('slide');
      expect(await getSetting('slideshow_transition_ms')).toBe(250);
      expect(await getSetting('slideshow_colorfilter')).toBe('sepia');
      expect(await getSetting('slideshow_watermark_enabled')).toBe(true);
      expect(await getSetting('slideshow_watermark_opacity')).toBe(100);
      expect(await getSetting('slideshow_watermark_size')).toBe(40);
    });

    it('coerces an invalid fit / transition to the safe default', async () => {
      const res = await auth(request(app).put('/api/admin/settings/slideshow')).send({
        slideshow_fit: 'banana',
        slideshow_transition: 'wormhole',
      });
      expect(res.status).toBe(200);
      expect(await getSetting('slideshow_fit')).toBe('cover');
      expect(await getSetting('slideshow_transition')).toBe('crossfade');
    });
  });
});
