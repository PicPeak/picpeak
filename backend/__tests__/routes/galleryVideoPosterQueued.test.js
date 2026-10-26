/**
 * A video's missing poster is rebuilt off the request path (issue 2263).
 *
 * The thumbnail route used to rebuild it inline: on S3 a copy of up to 512 MB
 * and up to a minute of ffmpeg before the tile got an answer. It now answers
 * at once with the placeholder, uncached, and queues one rebuild per photo
 * however many tiles ask meanwhile.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'video-poster-queued-secret';

const SLUG = 'video-poster-queued';

describe('gallery thumbnail route for a video without a poster', () => {
  let db; let cleanup; let app; let eventId; let photoId; let storage; let setStorageForTesting; let resetStorage;

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
      event_name: 'Video Poster Queued',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'video-poster-queued-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id'));

    photoId = unwrap(await db('photos').insert({
      event_id: eventId,
      filename: 'clip.mov',
      path: `events/active/${SLUG}/clip.mov`,
      type: 'individual',
      media_type: 'video',
      mime_type: 'video/quicktime',
      thumbnail_path: null,
      uploaded_at: new Date().toISOString(),
    }).returning('id'));

    ({ setStorageForTesting, resetStorage } = require('../../src/services/storage'));

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 180000);

  afterAll(async () => {
    if (resetStorage) resetStorage();
    if (cleanup) await cleanup();
  });

  it('answers with the uncached placeholder at once and queues one rebuild for many requests', async () => {
    // The source copy never finishes while the requests are answered: an
    // inline rebuild would hang every one of them.
    let finishCopy;
    const copying = new Promise((resolve) => { finishCopy = resolve; });
    storage = {
      kind: () => 's3',
      stat: jest.fn().mockResolvedValue(null),
      get: jest.fn(),
      getToFile: jest.fn(() => copying.then(() => { throw new Error('NoSuchKey'); })),
      put: jest.fn(),
      putFromFile: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(false),
    };
    setStorageForTesting(storage);

    try {
      const responses = await Promise.all([
        get(`/thumbnail/${photoId}`),
        get(`/thumbnail/${photoId}?w=600`),
        get(`/thumbnail/${photoId}`),
      ]);

      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('image/jpeg');
        expect(res.headers['cache-control']).toBe('no-store');
        // The image client keeps these bytes on screen and asks again.
        expect(res.headers['x-poster-pending']).toBe('1');
        expect(res.headers['retry-after']).toBe('10');
        expect(res.headers.etag).toBeUndefined();
        // A JPEG, not a JSON error.
        expect(Buffer.from(res.body).subarray(0, 2).toString('hex')).toBe('ffd8');
      }

      // One rebuild, started off the request path.
      for (let i = 0; i < 50 && storage.getToFile.mock.calls.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(storage.getToFile).toHaveBeenCalledTimes(1);
      expect(storage.getToFile.mock.calls[0][0]).toBe(`events/active/${SLUG}/clip.mov`);

      // While it runs, a further request does not start a second one.
      const again = await get(`/thumbnail/${photoId}`);
      expect(again.status).toBe(200);
      expect(storage.getToFile).toHaveBeenCalledTimes(1);
    } finally {
      // Lets the queued rebuild settle, so the suite's shutdown drain ends.
      finishCopy();
    }
  });

  it('serves a poster that is there as before, cached and without a rebuild', async () => {
    await db('photos').where({ id: photoId }).update({ thumbnail_path: 'thumbnails/thumb_clip.jpg' });
    const bytes = Buffer.from('ffd8ffe0', 'hex');
    storage = {
      kind: () => 's3',
      stat: jest.fn().mockResolvedValue({ size: bytes.length, mtime: new Date('2026-08-01T00:00:00Z') }),
      get: jest.fn(async () => require('stream').Readable.from([bytes])),
      getToFile: jest.fn(),
      put: jest.fn(),
      putFromFile: jest.fn(),
      delete: jest.fn(),
    };
    setStorageForTesting(storage);

    const res = await get(`/thumbnail/${photoId}`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, max-age=1800');
    expect(res.headers.etag).toMatch(/^"thumb-/);
    expect(res.headers['x-poster-pending']).toBeUndefined();
    expect(storage.get).toHaveBeenCalledWith('thumbnails/thumb_clip.jpg');
    expect(storage.getToFile).not.toHaveBeenCalled();
  });

  it('caches a picked poster only under the URL naming that pick', async () => {
    await db('photos').where({ id: photoId }).update({ thumbnail_path: 'thumbnails/thumb_clip.jpg', poster_offset_seconds: 5 });
    const bytes = Buffer.from('ffd8ffe0', 'hex');
    storage = {
      kind: () => 's3',
      stat: jest.fn().mockResolvedValue({ size: bytes.length, mtime: new Date('2026-08-01T00:00:00Z') }),
      get: jest.fn(async () => require('stream').Readable.from([bytes])),
      getToFile: jest.fn(),
      put: jest.fn(),
      putFromFile: jest.fn(),
      delete: jest.fn(),
    };
    setStorageForTesting(storage);
    try {
      expect((await get(`/thumbnail/${photoId}?poster=5`)).headers['cache-control']).toBe('private, max-age=1800');
      // An older list's URL: the current frame, not kept under that URL.
      expect((await get(`/thumbnail/${photoId}?poster=3`)).headers['cache-control']).toBe('no-store');
      expect((await get(`/thumbnail/${photoId}`)).headers['cache-control']).toBe('no-store');
    } finally {
      await db('photos').where({ id: photoId }).update({ poster_offset_seconds: null });
    }
  });
});
