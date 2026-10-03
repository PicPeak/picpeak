/**
 * The Open Graph surface follows the gallery lifecycle.
 *
 * buildOgMetadata reimplemented the draft/archived/inactive rule and left out
 * expiry, so an expired gallery's name, date and welcome text stayed in the
 * crawler preview after the gallery itself answered 404. handleGalleryOgCover
 * checked only the opt-in and the reveal state, so the hero thumbnail stayed
 * public after the gallery was drafted, archived, deactivated or expired.
 * Both now use isGalleryAvailable, the predicate gallery access uses.
 */

const request = require('supertest');
const express = require('express');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

// galleryOgService destructures ensureThumbnail at load, so the stub has to be
// in place before the service is required.
jest.mock('../../src/services/imageProcessor', () => ({
  ...jest.requireActual('../../src/services/imageProcessor'),
  ensureThumbnail: jest.fn(),
}));

const DAY = 24 * 3600 * 1000;

describe('OG metadata and cover follow the gallery lifecycle', () => {
  let db; let cleanup; let app; let og;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);

  const addEvent = async (slug, extra = {}) => unwrap(await db('events').insert({
    slug,
    event_type: 'wedding',
    event_name: `Name of ${slug}`,
    event_date: '2026-08-01',
    host_email: 'host@example.com',
    admin_email: 'admin@example.com',
    password_hash: 'x',
    require_password: 0,
    welcome_message: `Welcome text of ${slug}`,
    share_link: `/gallery/${slug}/share`,
    share_token: `${slug}-share`,
    expires_at: new Date(Date.now() + 7 * DAY).toISOString(),
    is_active: 1,
    is_archived: 0,
    is_draft: 0,
    og_image_share_enabled: 1,
    created_at: new Date().toISOString(),
    ...extra,
  }).returning('id'));

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    og = require('../../src/services/galleryOgService');

    // Every gallery has its own hero photo, so a 404 can only come from the
    // lifecycle check, not from a photo that belongs to another event.
    for (const [slug, extra] of [
      ['og-live', {}],
      ['og-expired', { expires_at: new Date(Date.now() - DAY).toISOString() }],
      ['og-draft', { is_draft: 1 }],
      ['og-archived', { is_archived: 1 }],
      ['og-inactive', { is_active: 0 }],
    ]) {
      const id = await addEvent(slug, extra);
      const photoId = unwrap(await db('photos').insert({
        event_id: id,
        filename: 'hero.jpg',
        path: `events/${slug}/hero.jpg`,
        type: 'individual',
        uploaded_at: new Date().toISOString(),
      }).returning('id'));
      await db('events').where({ id }).update({ hero_photo_id: photoId });
    }

    // A stored thumbnail the live cover can stream.
    const storage = require('../../src/services/storage').getStorage();
    await storage.put('thumbnails/og-cover.jpg', Buffer.from('not really a jpeg'));
    require('../../src/services/imageProcessor').ensureThumbnail.mockResolvedValue('thumbnails/og-cover.jpg');

    app = express();
    app.get('/og/gallery/:slug/cover', og.handleGalleryOgCover);
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('emits event-specific metadata for a live gallery', async () => {
    const meta = await og.buildOgMetadata('og-live', '/gallery/og-live');
    expect(meta.title).toContain('Name of og-live');
    expect(meta.description).toContain('Welcome text of og-live');
  });

  it.each(['og-expired', 'og-draft', 'og-archived', 'og-inactive'])(
    'emits only generic branding for %s',
    async (slug) => {
      const meta = await og.buildOgMetadata(slug, `/gallery/${slug}`);
      expect(JSON.stringify(meta)).not.toContain(`Name of ${slug}`);
      expect(JSON.stringify(meta)).not.toContain(`Welcome text of ${slug}`);
    },
  );

  it('streams the cover of a live gallery', async () => {
    const res = await request(app).get('/og/gallery/og-live/cover');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/jpeg/);
  });

  it.each(['og-expired', 'og-draft', 'og-archived', 'og-inactive'])(
    'answers 404 to the cover of %s before touching the photo',
    async (slug) => {
      const { ensureThumbnail } = require('../../src/services/imageProcessor');
      ensureThumbnail.mockClear();
      const res = await request(app).get(`/og/gallery/${slug}/cover`);
      expect(res.status).toBe(404);
      expect(ensureThumbnail).not.toHaveBeenCalled();
    },
  );
});
