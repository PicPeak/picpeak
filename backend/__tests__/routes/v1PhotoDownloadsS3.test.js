/**
 * v1 original downloads on an S3 backend (issue 1473).
 *
 * The storage backend is mocked as kind 's3' and the bytes exist only in the
 * mock, so a response carrying them proves the route read through the storage
 * abstraction and not a local path. The single download takes its
 * Content-Length from stat(); the ZIP skips the per-entry HEAD and relies on
 * get() rejecting a missing key, which must land in MISSING_FILES.txt rather
 * than kill the archive.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-v1dls3-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'v1dls3-test-secret';

const { Readable } = require('stream');

const mockObjects = new Map();
// Keys whose read fails: 'mid' after some bytes, 'early' before any byte.
const mockFailures = new Map();
const mockSlow = new Set();
// Storage metadata sizes that differ from the stored body.
const mockStatSizes = new Map();
const mockStorage = {
  kind: () => 's3',
  stat: jest.fn(async (key) => {
    if (mockStatSizes.has(key)) return { size: mockStatSizes.get(key), mtime: new Date() };
    return mockObjects.has(key) ? { size: mockObjects.get(key).length, mtime: new Date() } : null;
  }),
  get: jest.fn(async (key) => {
    if (!mockObjects.has(key)) {
      const err = new Error('The specified key does not exist.');
      err.name = 'NoSuchKey';
      throw err;
    }
    const body = mockObjects.get(key);
    const failure = mockFailures.get(key);
    const slow = mockSlow.has(key);
    return Readable.from((async function* read() {
      if (failure === 'early') {
        await new Promise((r) => setImmediate(r));
        throw Object.assign(new Error('socket reset by peer'), { code: 'ECONNRESET' });
      }
      if (slow) await new Promise((r) => setTimeout(r, 150));
      yield body.subarray(0, 32 * 1024);
      if (failure === 'mid') {
        await new Promise((r) => setTimeout(r, 20));
        throw Object.assign(new Error('socket reset by peer'), { code: 'ECONNRESET' });
      }
      yield body.subarray(32 * 1024);
    })());
  }),
};

jest.mock('../../src/services/storage', () => ({
  getStorage: () => mockStorage,
  initStorage: async () => mockStorage,
}));

const http = require('http');
const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const StreamZip = require('node-stream-zip');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { generateApiToken } = require('../../src/middleware/apiTokenAuth');

const binaryParser = (response, cb) => {
  const chunks = [];
  response.on('data', (c) => chunks.push(c));
  response.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('v1 original downloads through an S3 backend (issue 1473)', () => {
  let db; let cleanup; let app; let token; let eventId; let presentId; let missingId;
  let midEventId; let earlyEventId; let unsizedEventId;
  const body = Buffer.from('S3-ONLY-ORIGINAL-not-on-local-disk');

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    const role = await db('roles').where({ name: 'super_admin' }).first();
    const a = await db('admin_users').insert({
      username: 's3-root', email: 's3-root@example.com', password_hash: 'x', role_id: role.id,
      is_active: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id');
    const adminId = a[0]?.id ?? a[0];
    const { plaintext, hashed } = generateApiToken();
    await db('api_tokens').insert({
      name: 's3-read', hashed_token: hashed, scopes: 'read', created_by: adminId,
      created_at: new Date().toISOString(),
    });
    token = plaintext;

    const ev = await db('events').insert({
      slug: 's3-event', event_type: 'wedding', event_name: 's3-event', event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_token: 's3-share', share_link: '/gallery/s3-event/s3-share', created_by: adminId,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id');
    eventId = ev[0]?.id ?? ev[0];

    const mk = async (filename, original) => {
      const r = await db('photos').insert({
        event_id: eventId, filename, path: `s3-event/individual/${filename}`, type: 'individual',
        source_origin: 'managed', mime_type: 'image/jpeg', original_filename: original,
        size_bytes: body.length, uploaded_at: new Date().toISOString(),
      }).returning('id');
      return r[0]?.id ?? r[0];
    };
    presentId = await mk('s3-event_0001.jpg', 'present.jpg');
    missingId = await mk('s3-event_0002.jpg', 'missing.jpg');
    mockObjects.set('events/active/s3-event/individual/s3-event_0001.jpg', body);

    // Two events whose ZIP hits a failing read: one mid-copy, one while the
    // failing entry is still queued behind a slow first entry.
    const mkFailEvent = async (slug) => {
      const r = await db('events').insert({
        slug, event_type: 'wedding', event_name: slug, event_date: '2026-08-01',
        host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
        share_token: `${slug}-share`, share_link: `/gallery/${slug}/x`, created_by: adminId,
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
      }).returning('id');
      return r[0]?.id ?? r[0];
    };
    const mkFailPhoto = async (evId, slug, filename, mode) => {
      const key = `events/active/${slug}/individual/${filename}`;
      mockObjects.set(key, crypto.randomBytes(256 * 1024));
      if (mode === 'slow') mockSlow.add(key);
      else if (mode) mockFailures.set(key, mode);
      await db('photos').insert({
        event_id: evId, filename, path: `${slug}/individual/${filename}`, type: 'individual',
        source_origin: 'managed', mime_type: 'image/jpeg', size_bytes: 256 * 1024,
        uploaded_at: new Date().toISOString(),
      });
    };
    midEventId = await mkFailEvent('s3-mid');
    await mkFailPhoto(midEventId, 's3-mid', 'a.jpg', 'mid');
    await mkFailPhoto(midEventId, 's3-mid', 'b.jpg', null);
    // A legacy row with no recorded size whose object is 21 GiB according to
    // the storage metadata: the cap must see it.
    unsizedEventId = await mkFailEvent('s3-unsized');
    await db('photos').insert({
      event_id: unsizedEventId, filename: 'huge.mp4', path: 's3-unsized/individual/huge.mp4',
      type: 'individual', source_origin: 'managed', mime_type: 'video/mp4', media_type: 'video',
      size_bytes: null, uploaded_at: new Date().toISOString(),
    });
    mockObjects.set('events/active/s3-unsized/individual/huge.mp4', Buffer.from('x'));
    mockStatSizes.set('events/active/s3-unsized/individual/huge.mp4', 21 * 1024 ** 3);
    earlyEventId = await mkFailEvent('s3-early');
    await mkFailPhoto(earlyEventId, 's3-early', 'a.jpg', 'slow');
    await mkFailPhoto(earlyEventId, 's3-early', 'b.jpg', 'early');
    await mkFailPhoto(earlyEventId, 's3-early', 'c.jpg', null);

    app = express();
    app.use('/api/v1', require('../../src/routes/v1/events'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(() => {
    mockStorage.stat.mockClear();
    mockStorage.get.mockClear();
  });

  const get = (url) => request(app).get(url).set('Authorization', `Bearer ${token}`)
    .buffer(true).parse(binaryParser);

  it('streams the object from the backend with its stat size', async () => {
    const res = await get(`/api/v1/events/${eventId}/photos/${presentId}/download`);
    expect(res.status).toBe(200);
    expect(res.body.equals(body)).toBe(true);
    expect(res.headers['content-length']).toBe(String(body.length));
    expect(mockStorage.get).toHaveBeenCalledWith('events/active/s3-event/individual/s3-event_0001.jpg');
  });

  it('answers PHOTO_FILE_MISSING for a key the bucket does not have', async () => {
    const res = await get(`/api/v1/events/${eventId}/photos/${missingId}/download`);
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body.toString()).code).toBe('PHOTO_FILE_MISSING');
  });

  it('zips from the backend without a HEAD per entry and lists the missing key', async () => {
    const res = await get(`/api/v1/events/${eventId}/photos/download`);
    expect(res.status).toBe(200);
    expect(mockStorage.stat).not.toHaveBeenCalled();

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-v1dls3-zip-')), 'out.zip');
    fs.writeFileSync(file, res.body);
    const zip = new StreamZip.async({ file });
    const names = Object.keys(await zip.entries()).sort();
    expect(names).toEqual(['MISSING_FILES.txt', 'present.jpg']);
    expect((await zip.entryData('present.jpg')).equals(body)).toBe(true);
    expect((await zip.entryData('MISSING_FILES.txt')).toString()).toContain(String(missingId));
    await zip.close();
  });

  // Fetch over a real socket and report how the response ended: 'complete'
  // (a clean end), 'aborted' (connection broken) or 'timeout'.
  const fetchOutcome = (url, timeoutMs = 3000) => new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const done = (outcome, status) => {
        clearTimeout(timer);
        server.closeAllConnections?.();
        server.close(() => resolve({ outcome, status }));
      };
      const timer = setTimeout(() => done('timeout', null), timeoutMs);
      const req = http.get({
        host: '127.0.0.1', port: server.address().port, path: url,
        headers: { Authorization: `Bearer ${token}` },
      }, (res) => {
        res.on('data', () => {});
        res.on('aborted', () => done('aborted', res.statusCode));
        res.on('error', () => done('aborted', res.statusCode));
        res.on('end', () => done(res.complete ? 'complete' : 'aborted', res.statusCode));
      });
      req.on('error', () => done('aborted', null));
    });
  });

  it('breaks the connection when a read fails mid-copy instead of ending a truncated 200', async () => {
    const { outcome } = await fetchOutcome(`/api/v1/events/${midEventId}/photos/download`);
    expect(outcome).toBe('aborted');
  });

  it('breaks the connection when a queued read fails before it starts instead of hanging', async () => {
    const { outcome } = await fetchOutcome(`/api/v1/events/${earlyEventId}/photos/download`);
    expect(outcome).toBe('aborted');
  });

  it('sizes rows without a recorded size from storage metadata before the cap', async () => {
    const res = await get(`/api/v1/events/${unsizedEventId}/photos/download`);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body.toString()).code).toBe('ZIP_TOO_LARGE');
  });

  it('answers HEAD from a stat without opening the object', async () => {
    const res = await request(app)
      .head(`/api/v1/events/${eventId}/photos/${presentId}/download`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe(String(body.length));
    expect(mockStorage.stat).toHaveBeenCalled();
    expect(mockStorage.get).not.toHaveBeenCalled();

    const missing = await request(app)
      .head(`/api/v1/events/${eventId}/photos/${missingId}/download`)
      .set('Authorization', `Bearer ${token}`);
    expect(missing.status).toBe(404);
    expect(mockStorage.get).not.toHaveBeenCalled();
  });
});
