/**
 * A single-photo download whose res.sendFile fails must still be answered
 * (issue 1733).
 *
 * `GET /api/gallery/:slug/download/:photoId` on a local backend hands the
 * file to res.sendFile with a callback, and the callback only logged. The
 * existsSync precheck catches a missing file, but EACCES/EISDIR or a file
 * removed between the check and the send landed in that callback and the
 * request stayed open until the client or proxy gave up.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-dl-sf-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'download-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-dl-sf-storage-'));

const SLUG = 'sendfile-gallery';
const FILENAME = 'original.jpg';

const mockStorage = {
  kind: () => 'local',
  stat: jest.fn(),
  get: jest.fn(),
  getRange: jest.fn(),
  delete: jest.fn(async () => undefined),
  exists: jest.fn(async () => true),
};

jest.mock('../../src/services/storage', () => ({
  getStorage: () => mockStorage,
  initStorage: async () => mockStorage,
}));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('single-photo download when res.sendFile fails (issue 1733)', () => {
  let db; let cleanup; let app; let photoId;
  // What the stubbed sendFile does with its callback for the next request.
  let sendFileBehaviour;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const ev = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Downloads',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/s`,
      share_token: 'sendfile-share',
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      require_password: 0,
      allow_downloads: 1,
      created_at: new Date().toISOString(),
    }).returning('id');
    const eventId = ev[0]?.id ?? ev[0];

    const row = await db('photos').insert({
      event_id: eventId,
      filename: FILENAME,
      path: `${SLUG}/${FILENAME}`,
      type: 'individual',
      source_origin: 'managed',
      mime_type: 'image/jpeg',
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    photoId = row[0]?.id ?? row[0];

    // On disk, so the existsSync precheck passes and the route reaches sendFile.
    const abs = path.join(process.env.STORAGE_PATH, 'events/active', SLUG, FILENAME);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'local-disk-bytes');

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use((req, res, next) => {
      res.sendFile = (filePath, cb) => sendFileBehaviour(res, cb);
      next();
    });
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('answers 404 when the file vanished between the check and the send', async () => {
    sendFileBehaviour = (res, cb) => {
      const err = new Error('ENOENT: no such file or directory');
      err.code = 'ENOENT';
      cb(err);
    };

    const res = await request(app).get(`/api/gallery/${SLUG}/download/${photoId}`);

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    // Not the staged attachment headers, or the browser saves a .jpg of JSON.
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.body).toEqual({ error: 'Photo file not found' });
  });

  it('answers 500 when the file cannot be read, without the file\'s staged metadata', async () => {
    sendFileBehaviour = (res, cb) => {
      // send stats the file and stages its metadata before the read stream
      // fails; none of it belongs on the JSON answer.
      res.setHeader('ETag', 'W/"abc-123"');
      res.setHeader('Last-Modified', 'Wed, 01 Oct 2026 10:00:00 GMT');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=0');
      res.setHeader('Content-Range', 'bytes 0-99/1024');
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      cb(err);
    };

    const res = await request(app).get(`/api/gallery/${SLUG}/download/${photoId}`);

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.headers['content-disposition']).toBeUndefined();
    // Express computes a fresh weak ETag for the JSON body; the file's own
    // validator must not survive into it.
    expect(res.headers.etag).not.toBe('W/"abc-123"');
    for (const h of ['last-modified', 'accept-ranges', 'content-range']) {
      expect(res.headers[h]).toBeUndefined();
    }
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ error: 'Failed to download photo' });
  });

  it('keeps a 416 and its Content-Range for an unsatisfiable Range request', async () => {
    // What `send` does before calling back with its own client error.
    sendFileBehaviour = (res, cb) => {
      res.setHeader('Content-Range', 'bytes */1024');
      const err = new Error('Range Not Satisfiable');
      err.status = 416;
      cb(err);
    };

    const res = await request(app).get(`/api/gallery/${SLUG}/download/${photoId}`)
      .set('Range', 'bytes=999999-');

    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */1024');
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.body).toEqual({ error: 'Requested range not satisfiable' });
  });

  it('breaks the transfer instead of hanging when headers are already out', async () => {
    sendFileBehaviour = (res, cb) => {
      res.write('partial-bytes');
      cb(new Error('read error mid-stream'));
    };

    // A destroyed socket surfaces as a request error — not a response, and
    // not a timeout.
    await expect(
      request(app).get(`/api/gallery/${SLUG}/download/${photoId}`).timeout({ response: 5000 }),
    ).rejects.toThrow(/aborted|socket hang up|ECONNRESET/);
  });
});
