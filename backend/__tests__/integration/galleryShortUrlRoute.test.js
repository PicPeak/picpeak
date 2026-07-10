/**
 * HTTP-level tests for the `/s/:shortSlug` public resolver (#699).
 *
 * Verifies the contract the public route is expected to honour:
 *   - Browser UA → 302 to target_path
 *   - Social crawler UA → 200 with OG <meta>, canonical = /s/<slug>
 *   - Soft-deleted slug → 410 Gone (intentional-delete signal)
 *   - Unknown slug → 404 Not Found
 *   - Hit count increments after successful resolutions (both shapes)
 *
 * Mirrors the production server.js wiring but doesn't load the whole
 * server — the surrounding middleware (CORS, helmet, rate limiters)
 * isn't part of this route's contract.
 */
const express = require('express');
const request = require('supertest');

const { bootCrmDb } = require('./helpers/crmDb');

jest.setTimeout(60000);

let db; let cleanup; let service; let app;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());

  // Persist a business_profile + business_name so buildOgMetadata's
  // settings-based fields populate consistently.
  const { upsertAppSetting } = require('../../src/utils/appSettings');
  await upsertAppSetting('branding_company_name', JSON.stringify('Test Studio'), 'string');

  service = require('../../src/services/galleryShortUrlService');
  const {
    isSocialCrawler, buildOgMetadata, renderOgHtml,
  } = require('../../src/services/galleryOgService');

  app = express();
  app.get('/s/:shortSlug', async (req, res) => {
    try {
      const row = await service.findByShortSlug(req.params.shortSlug);
      if (!row) return res.status(404).type('text/plain').send('Short URL not found');
      if (row.deleted_at) return res.status(410).type('text/plain').send('Short URL has been removed');

      if (isSocialCrawler(req.get('user-agent'))) {
        const event = await db('events').where({ id: row.event_id }).first('slug');
        if (event?.slug) {
          const meta = await buildOgMetadata(event.slug, req.originalUrl);
          const base = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
          meta.url = `${base}/s/${row.short_slug}`;
          res.set('Cache-Control', 'public, max-age=300');
          res.set('Content-Type', 'text/html; charset=utf-8');
          res.send(renderOgHtml(meta));
          service.recordHit(row.id).catch(() => {});
          return;
        }
        return res.status(410).type('text/plain').send('Short URL points at a deleted event');
      }

      service.recordHit(row.id).catch(() => {});
      return res.redirect(302, row.target_path);
    } catch (err) {
      return res.status(500).type('text/plain').send(err.message);
    }
  });
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

async function seedEventAndShortUrl({ slug = `evt-${Date.now()}`, shortSlug }) {
  const farFuture = new Date(Date.now() + 365 * 86400000).toISOString();
  const [eventId] = await db('events').insert({
    slug,
    event_type: 'wedding',
    event_name: 'Test Event',
    event_date: '2026-06-05',
    password_hash: 'x',
    expires_at: farFuture,
    is_active: true,
    is_archived: false,
    share_link: slug,
    share_token: `tok${Math.random().toString(36).slice(2, 12)}`,
    welcome_message: null,
  });
  const row = await service.createShortUrl({
    eventId, customSlug: shortSlug,
  });
  return { eventId, shortUrl: row };
}

// User-agent strings the production `isSocialCrawler` helper matches.
// Snapshot known-true samples here so the test stays in sync if the
// helper's allowlist evolves.
const BOT_UA_WHATSAPP = 'WhatsApp/2.23.20.0';
const BOT_UA_FACEBOOK = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';

describe('GET /s/:shortSlug — browser (302 redirect)', () => {
  it('redirects to the snapshotted target_path with a 302', async () => {
    const { shortUrl } = await seedEventAndShortUrl({
      slug: 'browser-redirect', shortSlug: 'go-here',
    });
    const res = await request(app)
      .get('/s/go-here')
      .set('User-Agent', BROWSER_UA);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(shortUrl.target_path);
    expect(res.headers.location).toMatch(/^\/gallery\//);
  });

  it('increments hit_count on a browser hit (fire-and-forget — wait briefly)', async () => {
    await seedEventAndShortUrl({
      slug: 'hit-browser', shortSlug: 'hit-from-browser',
    });
    await request(app).get('/s/hit-from-browser').set('User-Agent', BROWSER_UA);
    await new Promise((r) => setTimeout(r, 50));
    const row = await service.findByShortSlug('hit-from-browser');
    expect(row.hit_count).toBe(1);
    expect(row.last_hit_at).toBeTruthy();
  });
});

describe('GET /s/:shortSlug — social crawler (OG metadata)', () => {
  it('returns 200 with OG HTML for WhatsApp UA', async () => {
    await seedEventAndShortUrl({
      slug: 'whatsapp-og', shortSlug: 'wa-preview',
    });
    const res = await request(app)
      .get('/s/wa-preview')
      .set('User-Agent', BOT_UA_WHATSAPP);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<meta');
    expect(res.text).toMatch(/og:title/);
    expect(res.text).toMatch(/og:url/);
  });

  it('og:url canonical points at /s/<slug>, not the underlying gallery URL', async () => {
    await seedEventAndShortUrl({
      slug: 'canonical-test', shortSlug: 'canonical-short',
    });
    const res = await request(app)
      .get('/s/canonical-short')
      .set('User-Agent', BOT_UA_FACEBOOK);
    expect(res.status).toBe(200);
    // The og:url meta tag must contain the short-URL path, not the
    // /gallery/<slug> path — this is the cache-key invariant from #699.
    expect(res.text).toMatch(/property="og:url"\s+content="[^"]*\/s\/canonical-short"/);
    expect(res.text).not.toMatch(
      /property="og:url"\s+content="[^"]*\/gallery\/canonical-test"/
    );
  });

  it('sets a short cache header so scrapers can re-fetch when admin rotates the preview', async () => {
    await seedEventAndShortUrl({
      slug: 'cache-header', shortSlug: 'cache-test',
    });
    const res = await request(app)
      .get('/s/cache-test')
      .set('User-Agent', BOT_UA_WHATSAPP);
    expect(res.headers['cache-control']).toMatch(/public/);
    expect(res.headers['cache-control']).toMatch(/max-age=300/);
  });

  it('increments hit_count on a crawler hit as well', async () => {
    await seedEventAndShortUrl({
      slug: 'hit-bot', shortSlug: 'hit-from-bot',
    });
    await request(app).get('/s/hit-from-bot').set('User-Agent', BOT_UA_WHATSAPP);
    await new Promise((r) => setTimeout(r, 50));
    const row = await service.findByShortSlug('hit-from-bot');
    expect(row.hit_count).toBe(1);
  });
});

describe('GET /s/:shortSlug — error states', () => {
  it('404 for an unknown slug', async () => {
    const res = await request(app)
      .get('/s/never-existed')
      .set('User-Agent', BROWSER_UA);
    expect(res.status).toBe(404);
  });

  it('410 for a soft-deleted slug (intentional-delete signal)', async () => {
    const { shortUrl } = await seedEventAndShortUrl({
      slug: 'gone-test', shortSlug: 'gone-slug',
    });
    await service.softDelete(shortUrl.id, null);
    const res = await request(app)
      .get('/s/gone-slug')
      .set('User-Agent', BROWSER_UA);
    expect(res.status).toBe(410);
  });

  it('410 if the event was hard-deleted but the short URL row somehow survives', async () => {
    const { eventId } = await seedEventAndShortUrl({
      slug: 'orphan-test', shortSlug: 'orphan-slug',
    });
    // Hard-delete the event row (FK CASCADE would normally clean up the
    // short URL too — but if CASCADE didn't fire for whatever reason
    // (e.g. SQLite foreign_keys pragma off in a particular runtime), the
    // resolver should still degrade safely).
    // SQLite's foreign_keys pragma is OFF by default; the migration
    // doesn't toggle it, so this delete leaves the short URL row.
    await db('events').where({ id: eventId }).delete();
    const res = await request(app)
      .get('/s/orphan-slug')
      .set('User-Agent', BOT_UA_WHATSAPP);
    expect(res.status).toBe(410);
  });

  it('404 for a malformed slug (rejected at validation, no DB hit)', async () => {
    const res = await request(app)
      .get('/s/UPPER_CASE')
      .set('User-Agent', BROWSER_UA);
    expect(res.status).toBe(404);
  });
});

describe('Regression — existing URL paths must still respond the same', () => {
  // The /s/* namespace is additive: it must NOT shadow /gallery/*
  // or any of the OG routes. We don't load the whole app here, but we
  // can at least pin that the route param doesn't accept slashes —
  // i.e. /s/foo/bar must NOT be matched by our handler.
  it('the /s/:shortSlug route does not match nested paths', async () => {
    const res = await request(app)
      .get('/s/foo/bar')
      .set('User-Agent', BROWSER_UA);
    // Express returns its default 404 when no route matches the path.
    expect(res.status).toBe(404);
  });
});
