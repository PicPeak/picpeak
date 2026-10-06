/**
 * A storage backend that cannot be reached is not a broken rendition
 * (issue 1785).
 *
 * The rendition checks treated every error from storage.stat() as "invalid",
 * so an S3 timeout made a healthy preview look broken: the service queued a
 * download of the full original to regenerate it, and the preview and hero
 * routes redirected the guest to that same original. Both went through the
 * client that was already timing out. The checks now let that error through,
 * and the preview route answers 503 instead of redirecting. The hero route
 * keeps its redirect, because its consumers cannot retry a 503, but no longer
 * regenerates.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { Readable } = require('stream');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'media-storage-unavailable-secret';

const SLUG = 'media-storage-unavailable';

// What @smithy/node-http-handler raises when no connection, or no free
// socket, is had within connectionTimeout.
const timeoutError = () => Object.assign(
  new Error('the request socket did not establish a connection with the server within the configured timeout of 120000 ms'),
  { name: 'TimeoutError' },
);

describe('gallery media routes while storage cannot be reached', () => {
  let db; let cleanup; let app; let eventId; let photoId;
  let storage; let setStorageForTesting; let resetStorage;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);
  const token = () => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' },
  );
  const get = (url) => request(app).get(`/api/gallery/${SLUG}${url}`).set('Authorization', `Bearer ${token()}`).redirects(0);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    eventId = unwrap(await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Media Storage Unavailable',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'media-storage-unavailable-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id'));

    photoId = unwrap(await db('photos').insert({
      event_id: eventId,
      filename: 'portrait.jpg',
      path: `events/active/${SLUG}/portrait.jpg`,
      type: 'individual',
      thumbnail_path: 'thumbnails/thumb_portrait.jpg',
      preview_path: 'previews/preview_portrait.jpg',
      hero_path: 'heroes/hero_portrait.jpg',
      uploaded_at: new Date().toISOString(),
    }).returning('id'));

    ({ setStorageForTesting, resetStorage } = require('../../src/services/storage'));

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 180000);

  beforeEach(() => {
    storage = {
      kind: () => 's3',
      stat: jest.fn(),
      get: jest.fn(),
      getToFile: jest.fn(),
      put: jest.fn(),
      putFromFile: jest.fn(),
      delete: jest.fn(),
    };
    setStorageForTesting(storage);
  });

  afterAll(async () => {
    if (resetStorage) resetStorage();
    if (cleanup) await cleanup();
  });

  it.each([
    ['/preview', 'the stored preview'],
    ['/preview?w=1280', 'a preview tier'],
  ])('answers 503 on %s when the check of %s times out', async (route) => {
    storage.stat.mockRejectedValue(timeoutError());
    const [path, query = ''] = route.split('?');

    const res = await get(`${path}/${photoId}${query ? `?${query}` : ''}`);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('STORAGE_UNAVAILABLE');
    expect(res.headers['retry-after']).toBe('5');
    expect(res.headers['cache-control']).toBe('no-store');
    // Not sent on to the original, which sits behind the same backend.
    expect(res.headers.location).toBeUndefined();
    // And nothing was fetched to regenerate a rendition that is fine.
    expect(storage.getToFile).not.toHaveBeenCalled();
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(storage.putFromFile).not.toHaveBeenCalled();
  });

  it('does not regenerate a hero whose check timed out, and keeps its redirect', async () => {
    // The Premium layout loads the hero as a CSS background and HeroHeader
    // falls back to the original by itself; neither can retry a 503.
    storage.stat.mockRejectedValue(timeoutError());

    const res = await get(`/hero/${photoId}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/api/gallery/${SLUG}/photo/${photoId}`);
    expect(storage.getToFile).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(storage.putFromFile).not.toHaveBeenCalled();
  });

  it('does not regenerate a thumbnail whose check timed out', async () => {
    storage.stat.mockRejectedValue(timeoutError());

    const res = await get(`/thumbnail/${photoId}`);

    // The thumbnail route never redirected to the original; it keeps its 500.
    expect(res.status).toBe(500);
    expect(storage.getToFile).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(storage.putFromFile).not.toHaveBeenCalled();
  });

  it('answers 503 when the rendition is there and reading it times out', async () => {
    storage.stat.mockResolvedValue({ size: 1024, mtime: new Date('2026-08-01T00:00:00Z') });
    storage.get.mockRejectedValue(timeoutError());

    const res = await get(`/preview/${photoId}`);

    expect(res.status).toBe(503);
    // Nothing staged for the image rides along on the error: the JSON must
    // not leave as image/jpeg, nor carry the preview's validator.
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body.code).toBe('STORAGE_UNAVAILABLE');
    expect(res.headers.etag || '').not.toContain('preview-');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.location).toBeUndefined();
  });

  it('answers 503 when the read starts and the body then times out', async () => {
    // S3 resolves get() once the response headers are in; the timeout comes
    // out of the stream afterwards, past the route's catch.
    storage.stat.mockResolvedValue({ size: 1024, mtime: new Date('2026-08-01T00:00:00Z') });
    storage.get.mockResolvedValue(new Readable({ read() { this.destroy(timeoutError()); } }));

    const res = await get(`/preview/${photoId}`);

    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body.code).toBe('STORAGE_UNAVAILABLE');
    expect(res.headers['retry-after']).toBe('5');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('still falls back to the original when the rendition cannot be made', async () => {
    // A missing object is an answer about the rendition: regenerate, and when
    // that fails too (no source bytes in this fixture) send the original.
    storage.stat.mockResolvedValue(null);
    storage.getToFile.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }));

    const res = await get(`/preview/${photoId}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/api/gallery/${SLUG}/photo/${photoId}`);
  });

  describe('writing a freshly made preview', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const sharp = require('sharp');
    let source;

    beforeAll(async () => {
      source = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-preview-outage-')), 'source.jpg');
      await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toFile(source);
    });

    it('passes on a write the storage backend could not take', async () => {
      // Swallowed into null, this read as "no preview can be made": the route
      // redirected to the original and a face scan failed the photo for good.
      const { generatePreviewImage } = require('../../src/services/imageProcessor');
      storage.put.mockRejectedValue(timeoutError());

      await expect(generatePreviewImage(source, { outputBasename: 'outage.jpg' }))
        .rejects.toMatchObject({ name: 'TimeoutError' });
    });

    it('still answers null for a write that failed for another reason', async () => {
      const { generatePreviewImage } = require('../../src/services/imageProcessor');
      storage.put.mockRejectedValue(Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }));

      await expect(generatePreviewImage(source, { outputBasename: 'denied.jpg' })).resolves.toBeNull();
    });
  });

  it('keeps the old handling for a storage error that is an answer, not an outage', async () => {
    // AccessDenied is about the request. The original would fail the same
    // way, but that is the existing behaviour and not this fix's to change.
    storage.stat.mockRejectedValue(Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }));
    storage.getToFile.mockRejectedValue(Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }));

    const res = await get(`/preview/${photoId}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/api/gallery/${SLUG}/photo/${photoId}`);
  });
});
