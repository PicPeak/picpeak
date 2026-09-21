/**
 * Videos under enhanced/maximum image protection (#1370).
 *
 * Both halves of the video path used to be routed through /api/secure-images
 * once an event left `standard` protection, and neither half could carry a
 * video:
 *
 *   1. galleryQueryService emitted `/api/secure-images/{slug}/secure/{id}/{{token}}`
 *      as the video's `url`. The lightbox drops that straight into a <video>
 *      element, nothing substitutes `{{token}}` (the helper that could is
 *      unreferenced), and the route answers 403 "Invalid or expired token".
 *   2. Even with a valid token it would still fail: the secure-images route
 *      pipes every byte through secureImageService.processProtectedImage,
 *      which calls sharp() and throws on an mp4 → 404.
 *
 * The guest saw a poster frozen at 0:00 with no error of any kind.
 *
 * Videos now keep the JWT route at every protection level. That is not a new
 * exposure — thumbnails of those same videos have always been served from it —
 * so these tests also pin the inverse: still images must keep bouncing to the
 * secure endpoint. Every assertion here fails on the unfixed code except the
 * two guarding images.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-video-urls-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'video-urls-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-video-urls-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const SLUG = 'protected-video-gallery';
const VIDEO_BYTES = Buffer.from('not really an mp4, but the route only streams bytes');

describe('videos stay playable under enhanced/maximum protection (#1370)', () => {
  let db; let cleanup; let app; let eventId; let videoId; let imageId;

  async function setProtection(level) {
    await db('events').where('id', eventId).update({ protection_level: level });
  }

  async function photoPayload(id) {
    const res = await request(app).get(`/api/gallery/${SLUG}/photos`);
    expect(res.status).toBe(200);
    const photo = res.body.photos.find((p) => p.id === id);
    expect(photo).toBeDefined();
    return photo;
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const ev = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Protected Video',
      event_date: '2026-09-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/s`,
      share_token: 'protected-video-share',
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      // Password-free so verifyGalleryAccess takes the public path, same as
      // the sibling gallery suites.
      require_password: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = ev[0]?.id ?? ev[0];

    const mediaDir = path.join(process.env.STORAGE_PATH, 'events/active', SLUG, 'individual');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, 'clip.mp4'), VIDEO_BYTES);
    fs.writeFileSync(path.join(mediaDir, 'still.jpg'), Buffer.from('jpeg-ish'));

    const vid = await db('photos').insert({
      event_id: eventId,
      filename: 'clip.mp4',
      path: `${SLUG}/individual/clip.mp4`,
      type: 'individual',
      media_type: 'video',
      mime_type: 'video/mp4',
      duration: 43,
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    videoId = vid[0]?.id ?? vid[0];

    const img = await db('photos').insert({
      event_id: eventId,
      filename: 'still.jpg',
      path: `${SLUG}/individual/still.jpg`,
      type: 'individual',
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    imageId = img[0]?.id ?? img[0];

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  describe.each(['enhanced', 'maximum'])('protection_level = %s', (level) => {
    beforeAll(async () => { await setProtection(level); });

    test('the video url is the JWT route, not a {{token}} template', async () => {
      const photo = await photoPayload(videoId);
      expect(photo.url).toBe(`/api/gallery/${SLUG}/photo/${videoId}`);
      expect(photo.url).not.toContain('{{token}}');
      expect(photo.requires_token).toBe(false);
    });

    test('the video streams instead of bouncing to the secure endpoint', async () => {
      const res = await request(app).get(`/api/gallery/${SLUG}/photo/${videoId}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('video/mp4');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(Buffer.from(res.body)).toEqual(VIDEO_BYTES);
    });

    test('range requests still work, so seeking is possible', async () => {
      const res = await request(app)
        .get(`/api/gallery/${SLUG}/photo/${videoId}`)
        .set('Range', 'bytes=0-9');
      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes 0-9/${VIDEO_BYTES.length}`);
    });

    test('still images keep bouncing to the secure endpoint', async () => {
      const photo = await photoPayload(imageId);
      expect(photo.url).toBe(`/api/secure-images/${SLUG}/secure/${imageId}/{{token}}`);
      expect(photo.requires_token).toBe(true);

      const res = await request(app).get(`/api/gallery/${SLUG}/photo/${imageId}`);
      expect(res.status).toBe(302);
      expect(res.body.error).toBe('Secure access required');
    });
  });

  describe('protection_level = standard', () => {
    beforeAll(async () => { await setProtection('standard'); });

    test('both media types take the JWT route, as before', async () => {
      expect((await photoPayload(videoId)).url).toBe(`/api/gallery/${SLUG}/photo/${videoId}`);
      expect((await photoPayload(imageId)).url).toBe(`/api/gallery/${SLUG}/photo/${imageId}`);
    });
  });

  // Both rows here were seeded with no thumbnail_path, which is the state
  // every video uploaded before the pipeline gained its placeholder fallback
  // is still in.
  describe('a video with no stored thumbnail (#1414)', () => {
    test('is still offered the thumbnail route, which regenerates it lazily', async () => {
      const photo = await photoPayload(videoId);
      expect(photo.thumbnail_url).toBe(`/api/gallery/${SLUG}/thumbnail/${videoId}`);
    });

    test('while a still image keeps falling back to its original', async () => {
      const photo = await photoPayload(imageId);
      expect(photo.thumbnail_url).toBeNull();
    });
  });
});
