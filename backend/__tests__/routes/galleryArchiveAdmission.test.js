/**
 * The synchronous gallery ZIP routes admit a bounded number of archives.
 *
 * download-selected (up to 500 photos a request) and download-all's streaming
 * fallback each bounded the storage reads of their own archive to two, but
 * nothing bounded how many archives one process built at once, so a gallery
 * link holder could start 25 and hold the whole S3 agent pool, plus the
 * resize, deflate and disk work behind each. The background job scheduler
 * already caps at two running and eight queued; the synchronous routes now
 * share a process-wide admission with the same numbers and answer 429 when it
 * is full.
 */

const crypto = require('crypto');
const { Readable } = require('stream');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'archive-admission-secret';

const SLUG = 'archive-admission';
const mockBodies = new Map();
const mockStorage = {
  kind: () => 's3',
  stat: jest.fn(async (key) => (mockBodies.has(key) ? { size: mockBodies.get(key).length, mtime: new Date() } : null)),
  get: jest.fn(async (key) => Readable.from([mockBodies.get(key)])),
  exists: jest.fn(async () => true),
  delete: jest.fn(async () => undefined),
};
jest.mock('../../src/services/storage', () => ({
  getStorage: () => mockStorage,
  initStorage: async () => mockStorage,
}));
jest.mock('../../src/services/downloadZipService', () => ({
  getZipInfo: async () => null,
  generateZip: async () => ({ success: false }),
  invalidate: () => {},
  invalidateAll: () => {},
}));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { createArchiveAdmission, streamingArchiveAdmission } = require('../../src/utils/archiveStreamGuard');

describe('createArchiveAdmission', () => {
  it('runs maxActive at once, queues maxWaiting, refuses the rest', async () => {
    const admission = createArchiveAdmission({ maxActive: 1, maxWaiting: 1 });
    const first = await admission.acquire();
    expect(typeof first).toBe('function');

    let secondDone = false;
    const second = admission.acquire().then((release) => { secondDone = true; return release; });
    await new Promise((r) => setImmediate(r));
    expect(secondDone).toBe(false);
    expect(admission.waiting).toBe(1);

    expect(await admission.acquire()).toBeNull();

    first();
    const release = await second;
    expect(admission.active).toBe(1);
    release();
    expect(admission.active).toBe(0);
  });

  it('ignores a second release of the same slot', async () => {
    const admission = createArchiveAdmission({ maxActive: 1 });
    const release = await admission.acquire();
    release();
    release();
    expect(admission.active).toBe(0);
  });
});

describe('gallery ZIP routes under the shared admission', () => {
  let db; let cleanup; let app; let eventId; const photoIds = [];

  const token = () => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' },
  );
  const selected = () => request(app)
    .post(`/api/gallery/${SLUG}/download-selected`)
    .set('Authorization', `Bearer ${token()}`)
    .send({ photo_ids: photoIds })
    .buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
  const all = () => request(app)
    .get(`/api/gallery/${SLUG}/download-all`)
    .set('Authorization', `Bearer ${token()}`)
    .buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });

  /** Hold every slot and queue position of the process-wide admission. */
  async function saturate() {
    const releases = [];
    for (let i = 0; i < 2; i += 1) releases.push(await streamingArchiveAdmission.acquire());
    const queued = [];
    for (let i = 0; i < 8; i += 1) queued.push(streamingArchiveAdmission.acquire());
    await new Promise((r) => setImmediate(r));
    expect(streamingArchiveAdmission.waiting).toBe(8);
    // Each release hands its slot to the next waiter, so the queue drains in
    // order, one awaited release at a time.
    return async () => {
      releases.forEach((release) => release());
      for (const pending of queued) (await pending)();
    };
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const ev = await db('events').insert({
      slug: SLUG, event_type: 'wedding', event_name: 'Archive admission', event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${SLUG}/s`, share_token: 'archive-admission-share',
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, require_password: 0, allow_downloads: 1,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = ev[0]?.id ?? ev[0];

    for (const filename of ['a.jpg', 'b.jpg']) {
      mockBodies.set(`events/active/${SLUG}/${filename}`, crypto.randomBytes(16 * 1024));
      const r = await db('photos').insert({
        event_id: eventId, filename, path: `${SLUG}/${filename}`, type: 'individual',
        source_origin: 'managed', mime_type: 'image/jpeg', size_bytes: 16 * 1024,
        uploaded_at: new Date(Date.now() - photoIds.length * 1000).toISOString(),
      }).returning('id');
      photoIds.push(r[0]?.id ?? r[0]);
    }

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(() => mockStorage.get.mockClear());

  it('streams a selected archive and gives its slot back', async () => {
    const res = await selected();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(streamingArchiveAdmission.active).toBe(0);
  });

  it('answers 429 to download-selected when the process is full, without opening a storage read', async () => {
    const drain = await saturate();
    try {
      const res = await selected();
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBe('10');
      expect(mockStorage.get).not.toHaveBeenCalled();
    } finally {
      await drain();
    }
    expect(streamingArchiveAdmission.active).toBe(0);
  });

  it('answers 429 to the download-all stream when the process is full', async () => {
    const drain = await saturate();
    try {
      const res = await all();
      expect(res.status).toBe(429);
      expect(mockStorage.get).not.toHaveBeenCalled();
    } finally {
      await drain();
    }
    expect((await all()).status).toBe(200);
    expect(streamingArchiveAdmission.active).toBe(0);
  });
});
