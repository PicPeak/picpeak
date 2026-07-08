/**
 * HTTP route tests for the PUBLIC Live Slideshow surface (backend/src/routes/gallery.js):
 *   GET /:slug/show/:token/state    (cheap settings + photo-count poll)
 *   GET /:slug/show/:token/session  (mints the gallery JWT + cookie)
 *
 * These pin the two pieces of logic where real bugs lived during the build:
 *   - resolveSlideshow: the `slideshow` feature flag is a MASTER kill-switch
 *     (404 when off), plus token / expiry / draft / archived / inactive guards.
 *   - slideshowSettings: the watermark cascade (global look + per-event on/off),
 *     image fit, and the fact that globals are read from `app_settings`
 *     (regression for the getSetting→nonexistent-`settings`-table bug).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-show-pub-')), 'db.sqlite'
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'slideshow-test-secret';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { invalidateFeatureFlagCache } = require('../../src/middleware/requireFeatureFlag');
const { invalidateSlideshowGlobals } = require('../../src/utils/slideshowGlobals');

const SLUG = 'wedding-test';
const TOKEN = 'show-tok-abcdef';

async function setFlag(db, key, on) {
  await db('feature_flags').where({ key }).del();
  await db('feature_flags').insert({ key, value: on ? 1 : 0 });
  invalidateFeatureFlagCache();
}

async function setSetting(db, key, value, type = 'slideshow') {
  await db('app_settings').where({ setting_key: key }).del();
  await db('app_settings').insert({ setting_key: key, setting_value: JSON.stringify(value), setting_type: type, updated_at: new Date() });
}

async function insertEvent(db, over = {}) {
  const base = {
    slug: SLUG,
    event_type: 'wedding',
    event_name: 'Test Wedding',
    event_date: '2026-05-29',
    host_email: 'host@example.com',
    admin_email: 'admin@example.com',
    password_hash: 'x',
    share_link: `/gallery/${SLUG}/share-${Math.random().toString(16).slice(2)}`,
    share_token: `st-${Math.random().toString(16).slice(2)}`,
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1,
    is_archived: 0,
    is_draft: 0,
    show_share_token: TOKEN,
    created_at: new Date().toISOString(),
    ...over,
  };
  const r = await db('events').insert(base).returning('id');
  return r[0]?.id ?? r[0];
}

describe('public Live Slideshow routes', () => {
  let db; let cleanup; let app;

  // bootCrmDb runs the full migration set against a fresh SQLite file, which
  // takes <2s locally but has been observed to exceed Jest's default 5s
  // `beforeAll` timeout on slower GitHub Actions runners (~5.4s — runner-to-
  // runner I/O variance). Raise the hook timeout so this doesn't intermittently
  // block PRs on CI; doesn't affect happy-path local runs.
  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    // Both routers mount under /api/gallery in production; the display-only
    // guard lives on download routes (gallery) + the feedback POST (galleryFeedback).
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/gallery', require('../../src/routes/galleryFeedback'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code });
    });
  }, 30000);

  afterAll(async () => { await cleanup(); });

  beforeEach(async () => {
    await db('events').del();
    await db('app_settings').del();
    await db('feature_flags').del();
    invalidateFeatureFlagCache();
    invalidateSlideshowGlobals();
    await setFlag(db, 'slideshow', true);
  });

  const stateUrl = (token = TOKEN) => `/api/gallery/${SLUG}/show/${token}/state`;

  describe('resolveSlideshow guards', () => {
    it('200 + per-event display settings on a live link', async () => {
      await insertEvent(db, {
        show_interval_ms: 8000,
        show_transition: 'kenburns',
        show_transition_ms: 1200,
        show_colorfilter: 'sepia',
      });
      const res = await request(app).get(stateUrl());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        interval_ms: 8000,
        transition: 'kenburns',
        transition_ms: 1200,
        colorfilter: 'sepia',
        fit: 'cover',
        photo_count: 0,
        watermark: null,
      });
    });

    it('404 when the slideshow feature flag is OFF (master kill-switch)', async () => {
      await insertEvent(db);
      await setFlag(db, 'slideshow', false);
      const res = await request(app).get(stateUrl());
      expect(res.status).toBe(404);
    });

    it('404 on an unknown token', async () => {
      await insertEvent(db);
      const res = await request(app).get(stateUrl('not-the-token'));
      expect(res.status).toBe(404);
    });

    it('404 when the share token is null (link never minted / disabled)', async () => {
      await insertEvent(db, { show_share_token: null });
      const res = await request(app).get(stateUrl());
      expect(res.status).toBe(404);
    });

    it('404 when the event has expired', async () => {
      await insertEvent(db, { expires_at: new Date(Date.now() - 1000).toISOString() });
      const res = await request(app).get(stateUrl());
      expect(res.status).toBe(404);
    });

    it('404 when the event is a draft', async () => {
      await insertEvent(db, { is_draft: 1 });
      const res = await request(app).get(stateUrl());
      expect(res.status).toBe(404);
    });

    it('404 when the event is archived', async () => {
      await insertEvent(db, { is_archived: 1 });
      const res = await request(app).get(stateUrl());
      expect(res.status).toBe(404);
    });
  });

  describe('slideshowSettings — image fit (global, live)', () => {
    it('reflects the global slideshow_fit setting', async () => {
      await insertEvent(db);
      await setSetting(db, 'slideshow_fit', 'contain');
      const res = await request(app).get(stateUrl());
      expect(res.status).toBe(200);
      expect(res.body.fit).toBe('contain');
    });
  });

  describe('slideshowSettings — watermark cascade (global look + per-event on/off)', () => {
    async function enableGlobalWatermark() {
      await setSetting(db, 'slideshow_watermark_enabled', true);
      await setSetting(db, 'slideshow_watermark_source', 'logo');
      await setSetting(db, 'slideshow_watermark_position', 'top-left');
      await setSetting(db, 'slideshow_watermark_opacity', 40);
      await setSetting(db, 'slideshow_watermark_style', 'original');
      await setSetting(db, 'slideshow_watermark_size', 9);
      await setSetting(db, 'branding_logo_url', '/uploads/logos/light.svg', 'branding');
    }

    it('inherits the global watermark when show_watermark is NULL', async () => {
      await insertEvent(db, { show_watermark: null });
      await enableGlobalWatermark();
      const res = await request(app).get(stateUrl());
      expect(res.body.watermark).toEqual({
        url: '/uploads/logos/light.svg',
        position: 'top-left',
        opacity: 40,
        style: 'original',
        size: 9,
      });
    });

    it('resolves the dark logo / favicon sources', async () => {
      await insertEvent(db, { show_watermark: null });
      await enableGlobalWatermark();
      await setSetting(db, 'slideshow_watermark_source', 'favicon');
      await setSetting(db, 'branding_favicon_url', '/uploads/favicons/f.png', 'branding');
      const res = await request(app).get(stateUrl());
      expect(res.body.watermark.url).toBe('/uploads/favicons/f.png');
    });

    it('per-event OFF override hides the watermark even when the global is on', async () => {
      await insertEvent(db, { show_watermark: 0 });
      await enableGlobalWatermark();
      const res = await request(app).get(stateUrl());
      expect(res.body.watermark).toBeNull();
    });

    it('per-event ON override shows the watermark even when the global is off', async () => {
      await insertEvent(db, { show_watermark: 1 });
      await enableGlobalWatermark();
      await setSetting(db, 'slideshow_watermark_enabled', false);
      const res = await request(app).get(stateUrl());
      expect(res.body.watermark).not.toBeNull();
      expect(res.body.watermark.url).toBe('/uploads/logos/light.svg');
    });

    it('null when enabled but no logo URL is configured', async () => {
      await insertEvent(db, { show_watermark: null });
      await setSetting(db, 'slideshow_watermark_enabled', true);
      // no branding_logo_url set
      const res = await request(app).get(stateUrl());
      expect(res.body.watermark).toBeNull();
    });
  });

  describe('display-only token guards (#646 review concern 1)', () => {
    // Mint a real slideshow JWT, then prove it is denied on the
    // download / upload / feedback routes (display-only contract).
    async function slideshowJwt() {
      await insertEvent(db);
      const res = await request(app).get(`/api/gallery/${SLUG}/show/${TOKEN}/session`);
      expect(res.status).toBe(200);
      return res.body.token;
    }

    it('403 on whole-gallery download', async () => {
      const jwt = await slideshowJwt();
      const res = await request(app).get(`/api/gallery/${SLUG}/download-all`).set('Authorization', `Bearer ${jwt}`);
      expect(res.status).toBe(403);
    });

    it('403 on single-photo download', async () => {
      const jwt = await slideshowJwt();
      const res = await request(app).get(`/api/gallery/${SLUG}/download/1`).set('Authorization', `Bearer ${jwt}`);
      expect(res.status).toBe(403);
    });

    it('403 on bulk download-selected', async () => {
      const jwt = await slideshowJwt();
      const res = await request(app).post(`/api/gallery/${SLUG}/download-selected`).set('Authorization', `Bearer ${jwt}`).send({ photoIds: [1] });
      expect(res.status).toBe(403);
    });

    it('403 on feedback POST', async () => {
      const jwt = await slideshowJwt();
      const res = await request(app).post(`/api/gallery/${SLUG}/photos/1/feedback`).set('Authorization', `Bearer ${jwt}`).send({ feedback_type: 'like' });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /session', () => {
    it('mints a token + sets the gallery cookie on a valid link', async () => {
      await insertEvent(db);
      const res = await request(app).get(`/api/gallery/${SLUG}/show/${TOKEN}/session`);
      expect(res.status).toBe(200);
      expect(typeof res.body.token).toBe('string');
      expect(res.body.token.length).toBeGreaterThan(20);
      expect(res.body.event).toMatchObject({ event_name: 'Test Wedding' });
      expect(res.body).toHaveProperty('settings');
      expect(res.body).toHaveProperty('photo_count', 0);
      expect(res.headers['set-cookie']).toBeDefined();
    });

    it('404 when the feature is off', async () => {
      await insertEvent(db);
      await setFlag(db, 'slideshow', false);
      const res = await request(app).get(`/api/gallery/${SLUG}/show/${TOKEN}/session`);
      expect(res.status).toBe(404);
    });
  });
});
