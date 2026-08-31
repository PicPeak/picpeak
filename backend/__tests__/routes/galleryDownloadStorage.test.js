/**
 * Single-photo gallery downloads must go through the storage backend (#1048).
 *
 * `GET /api/gallery/:slug/download/:photoId` resolved a LOCAL filesystem path
 * unconditionally and handed it to res.sendFile. On an S3/R2 deployment
 * managed photos never exist on local disk, so every per-photo download 404'd
 * with ENOENT — while download-all and secure-images worked fine, because they
 * already went through getStorage(). The gallery looks healthy until a guest
 * clicks the download button on a single photo.
 *
 * The local branch is pinned just as hard: sendFile emits Content-Length,
 * Accept-Ranges, ETag and Last-Modified and answers Range with a 206. Routing
 * local installs through a bare stream.pipe(res) to share one code path would
 * silently drop all of that, and a resumed download would append a second full
 * body onto the partial file.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-dl-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'download-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-dl-storage-'));

const { Readable } = require('stream');

const SLUG = 'download-gallery';
const FILENAME = 'original.jpg';
// Deliberately not written to disk anywhere: if the route reads the
// filesystem instead of the backend, it cannot produce these bytes.
const mockObjectBody = Buffer.from('S3-ONLY-ORIGINAL-BYTES-not-on-local-disk');
const mockBackendKind = { value: 's3' };

const mockStorage = {
  kind: () => mockBackendKind.value,
  stat: jest.fn(async () => ({ size: mockObjectBody.length, mtime: new Date('2026-08-20T10:00:00Z') })),
  get: jest.fn(async () => Readable.from([mockObjectBody])),
  getRange: jest.fn(async (key, start, end) => Readable.from([mockObjectBody.subarray(start, end + 1)])),
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

describe('single-photo download through the storage backend (#1048)', () => {
  let db; let cleanup; let app; let eventId; let photoId;

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
      share_token: 'download-share',
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      require_password: 0,
      allow_downloads: 1,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = ev[0]?.id ?? ev[0];

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

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(() => {
    mockBackendKind.value = 's3';
    mockStorage.get.mockClear();
    mockStorage.getRange.mockClear();
  });

  it('streams the stored object instead of 404ing on a local path', async () => {
    const res = await request(app)
      .get(`/api/gallery/${SLUG}/download/${photoId}`)
      .buffer(true)
      .parse((response, cb) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    // The bytes only exist in the backend — proof it did not read the disk.
    expect(res.body.equals(mockObjectBody)).toBe(true);
    expect(mockStorage.get).toHaveBeenCalledWith(`events/active/${SLUG}/${FILENAME}`);
    // Never written locally, so a filesystem read could not have served this.
    expect(fs.existsSync(path.join(process.env.STORAGE_PATH, 'events/active', SLUG, FILENAME))).toBe(false);
  });

  it('sends Content-Length so the browser can show download progress', async () => {
    const res = await request(app).get(`/api/gallery/${SLUG}/download/${photoId}`);

    expect(res.headers['content-length']).toBe(String(mockObjectBody.length));
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-disposition']).toContain(FILENAME);
  });

  it('answers a Range request with 206 and only the requested bytes', async () => {
    const res = await request(app)
      .get(`/api/gallery/${SLUG}/download/${photoId}`)
      .set('Range', 'bytes=0-9')
      .buffer(true)
      .parse((response, cb) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-9/${mockObjectBody.length}`);
    expect(res.headers['content-length']).toBe('10');
    expect(res.body.equals(mockObjectBody.subarray(0, 10))).toBe(true);
    expect(mockStorage.getRange).toHaveBeenCalledWith(`events/active/${SLUG}/${FILENAME}`, 0, 9);
  });

  it('ignores a malformed Range rather than emitting a nonsense 206', async () => {
    const res = await request(app)
      .get(`/api/gallery/${SLUG}/download/${photoId}`)
      .set('Range', 'bytes=abc-def');

    expect(res.status).toBe(200);
    expect(res.headers['content-range']).toBeUndefined();
  });

  it('404s cleanly when the object is missing from the backend', async () => {
    mockStorage.stat.mockResolvedValueOnce(null);

    const res = await request(app).get(`/api/gallery/${SLUG}/download/${photoId}`);

    expect(res.status).toBe(404);
    // The error must not inherit the image headers staged for a successful
    // download, or the browser saves a .jpg containing JSON.
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('keeps res.sendFile on a local backend rather than a bare pipe', async () => {
    mockBackendKind.value = 'local';
    const abs = path.join(process.env.STORAGE_PATH, 'events/active', SLUG, FILENAME);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'local-disk-bytes');

    const res = await request(app).get(`/api/gallery/${SLUG}/download/${photoId}`);

    expect(res.status).toBe(200);
    expect(mockStorage.get).not.toHaveBeenCalled();
    // sendFile's signature: conditional-request headers a raw pipe never sets.
    expect(res.headers.etag).toBeDefined();
    expect(res.headers['last-modified']).toBeDefined();

    fs.rmSync(abs, { force: true });
  });

  it('does not serve a partial body when the If-Range validator is stale', async () => {
    // The object was replaced since the client's last attempt. Answering 206
    // from the new bytes would let it splice two versions into one file.
    const res = await request(app)
      .get(`/api/gallery/${SLUG}/download/${photoId}`)
      .set('Range', 'bytes=0-9')
      .set('If-Range', new Date('2020-01-01T00:00:00Z').toUTCString());

    expect(res.status).toBe(200);
    expect(res.headers['content-range']).toBeUndefined();
    expect(res.headers['content-length']).toBe(String(mockObjectBody.length));
  });

  it('still serves 206 when the If-Range validator matches', async () => {
    const res = await request(app)
      .get(`/api/gallery/${SLUG}/download/${photoId}`)
      .set('Range', 'bytes=0-9')
      .set('If-Range', new Date('2026-08-20T10:00:00Z').toUTCString());

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-9/${mockObjectBody.length}`);
  });

  it('errors cleanly when the object vanishes between stat and get', async () => {
    // HeadObject succeeding does not mean GetObject will — a concurrent
    // delete lands here. The staged image headers must not escape with it.
    const gone = new Error('NoSuchKey');
    gone.name = 'NoSuchKey';
    mockStorage.get.mockRejectedValueOnce(gone);

    const res = await request(app).get(`/api/gallery/${SLUG}/download/${photoId}`);

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('does not send 206 headers before the range fetch can fail', async () => {
    // writeHead(206) before the await would make this ERR_HTTP_HEADERS_SENT.
    mockStorage.getRange.mockRejectedValueOnce(new Error('connection reset'));

    const res = await request(app)
      .get(`/api/gallery/${SLUG}/download/${photoId}`)
      .set('Range', 'bytes=0-9');

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.headers['content-range']).toBeUndefined();
  });

  it('answers HEAD from stat instead of draining the object out of S3', async () => {
    const res = await request(app).head(`/api/gallery/${SLUG}/download/${photoId}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe(String(mockObjectBody.length));
    expect(res.headers['accept-ranges']).toBe('bytes');
    // The whole point: no egress for a metadata probe.
    expect(mockStorage.get).not.toHaveBeenCalled();
    expect(mockStorage.getRange).not.toHaveBeenCalled();
  });

  it('returns a clean error when the range stream dies before its first chunk', async () => {
    // Resolves, then errors — writeHead would already have committed the 206,
    // leaving a connection reset as the only possible outcome.
    const { Readable: R } = require('stream');
    mockStorage.getRange.mockImplementationOnce(async () => {
      const dead = new R({ read() { this.destroy(new Error('socket hang up')); } });
      return dead;
    });

    const res = await request(app)
      .get(`/api/gallery/${SLUG}/download/${photoId}`)
      .set('Range', 'bytes=0-9');

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.headers['content-range']).toBeUndefined();
  });
});
