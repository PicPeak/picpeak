/**
 * Slideshow photo source (#1015).
 *
 * The bug: with `lightbox_preview_enabled` off (the default), /photos emitted
 * `preview_url: null`, so the slideshow's `preview_url || hero_url || url`
 * chain fell through to `hero_url` — a 1920x1080 `fit: 'cover'` centre crop
 * meant for gallery header banners. With the "Black Bars (No crop)" fit the
 * show then letterboxed an already-cropped frame: portrait photos lost their
 * top and bottom and the setting looked broken.
 *
 * The contract pinned here: `slideshow_url` points at the aspect-preserved
 * preview tier and is emitted for image photos REGARDLESS of the lightbox
 * toggle, so the slideshow never has a reason to reach for `hero_url`.
 * `preview_url` itself must stay gated — the lightbox opt-in is unchanged.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'slideshow-src-test-secret';

const SLUG = 'slideshow-source-event';

describe('Slideshow photo source (#1015)', () => {
  let db;
  let cleanup;
  let app;
  let eventId;
  let imagePhotoId;
  let videoPhotoId;

  const galleryToken = () => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  const setLightboxPreview = async (on) => {
    await db('app_settings').where({ setting_key: 'lightbox_preview_enabled' }).del();
    await db('app_settings').insert({
      setting_key: 'lightbox_preview_enabled',
      setting_value: JSON.stringify(on),
      setting_type: 'general',
      updated_at: new Date().toISOString(),
    });
  };

  const fetchPhotos = async () => {
    const res = await request(app)
      .get(`/api/gallery/${SLUG}/photos`)
      .set('Authorization', `Bearer ${galleryToken()}`)
      .expect(200);
    return res.body.photos;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const inserted = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Slideshow Source Test',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'slideshow-source-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = inserted[0]?.id ?? inserted[0];

    const img = await db('photos').insert({
      event_id: eventId,
      filename: 'portrait.jpg',
      path: 'events/slideshow-source/portrait.jpg',
      type: 'individual',
      mime_type: 'image/jpeg',
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    imagePhotoId = img[0]?.id ?? img[0];

    const vid = await db('photos').insert({
      event_id: eventId,
      filename: 'clip.mp4',
      path: 'events/slideshow-source/clip.mp4',
      type: 'individual',
      media_type: 'video',
      mime_type: 'video/mp4',
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    videoPhotoId = vid[0]?.id ?? vid[0];

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  it('emits slideshow_url for image photos even when lightbox previews are OFF', async () => {
    await setLightboxPreview(false);
    const photos = await fetchPhotos();
    const image = photos.find((p) => p.id === imagePhotoId);

    expect(image.slideshow_url).toBe(`/api/gallery/${SLUG}/preview/${imagePhotoId}`);
    // The regression: this is what used to be null, pushing the show to hero.
    expect(image.preview_url).toBeNull();
  });

  it('leaves preview_url gated so the lightbox opt-in is unchanged', async () => {
    await setLightboxPreview(true);
    const photos = await fetchPhotos();
    const image = photos.find((p) => p.id === imagePhotoId);

    expect(image.preview_url).toBe(`/api/gallery/${SLUG}/preview/${imagePhotoId}`);
    expect(image.slideshow_url).toBe(image.preview_url);
  });

  it('never points the slideshow at the cover-cropped hero tier', async () => {
    await setLightboxPreview(false);
    const photos = await fetchPhotos();
    const image = photos.find((p) => p.id === imagePhotoId);

    // hero_url still ships (the gallery header uses it) — it just must not be
    // what the slideshow resolves to.
    expect(image.hero_url).toBe(`/api/gallery/${SLUG}/hero/${imagePhotoId}`);
    expect(image.slideshow_url).not.toBe(image.hero_url);
  });

  it('emits slideshow_url: null for videos, which have no preview tier', async () => {
    await setLightboxPreview(false);
    const photos = await fetchPhotos();
    const video = photos.find((p) => p.id === videoPhotoId);

    expect(video.slideshow_url).toBeNull();
  });
});
