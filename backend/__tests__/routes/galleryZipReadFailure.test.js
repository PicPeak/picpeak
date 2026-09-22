/**
 * A storage read that fails while a gallery ZIP is streaming must break the
 * connection (found in the review of PR 1582).
 *
 * The stream guard's fatal-error handler aborted only the archive. When the
 * entry being copied failed, the archive then ended cleanly and the guest got
 * a truncated ZIP as a complete 200; when an entry still queued behind another
 * failed, the archive never ended and the response hung (up to 24 h behind
 * nginx). Both download-all and download-selected stream through the guard.
 *
 * The backend is mocked as S3 so the reads can fail on cue: 'a.jpg' is slow,
 * 'b.jpg' fails as configured per test, 'c.jpg' is fine.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-gzipfail-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'gzipfail-test-secret';

const { Readable } = require('stream');

const SLUG = 'zip-failure';
const mockBodies = new Map();
const mockMode = { value: 'mid' };

const mockStorage = {
  kind: () => 's3',
  stat: jest.fn(async (key) => (mockBodies.has(key) ? { size: mockBodies.get(key).length, mtime: new Date() } : null)),
  get: jest.fn(async (key) => {
    const body = mockBodies.get(key);
    const failing = key.endsWith('/b.jpg');
    const slow = key.endsWith('/a.jpg');
    return Readable.from((async function* read() {
      if (failing && mockMode.value === 'early') {
        await new Promise((r) => setImmediate(r));
        throw Object.assign(new Error('socket reset by peer'), { code: 'ECONNRESET' });
      }
      if (slow) await new Promise((r) => setTimeout(r, 150));
      yield body.subarray(0, 32 * 1024);
      if (failing && mockMode.value === 'mid') {
        await new Promise((r) => setTimeout(r, 20));
        throw Object.assign(new Error('socket reset by peer'), { code: 'ECONNRESET' });
      }
      yield body.subarray(32 * 1024);
    })());
  }),
  exists: jest.fn(async () => true),
  delete: jest.fn(async () => undefined),
};

jest.mock('../../src/services/storage', () => ({
  getStorage: () => mockStorage,
  initStorage: async () => mockStorage,
}));

// Keep the background cache build out of it: it would read the same objects.
jest.mock('../../src/services/downloadZipService', () => ({
  getZipInfo: async () => null,
  generateZip: async () => ({ success: false }),
  invalidate: () => {},
  invalidateAll: () => {},
}));

const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('gallery ZIP with a failing storage read', () => {
  let db; let cleanup; let app; const photoIds = [];

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const ev = await db('events').insert({
      slug: SLUG, event_type: 'wedding', event_name: 'Zip failure', event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${SLUG}/s`, share_token: 'zip-failure-share',
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, require_password: 0, allow_downloads: 1,
      created_at: new Date().toISOString(),
    }).returning('id');
    const eventId = ev[0]?.id ?? ev[0];

    for (const filename of ['a.jpg', 'b.jpg', 'c.jpg']) {
      mockBodies.set(`events/active/${SLUG}/${filename}`, crypto.randomBytes(256 * 1024));
      const r = await db('photos').insert({
        event_id: eventId, filename, path: `${SLUG}/${filename}`, type: 'individual',
        source_origin: 'managed', mime_type: 'image/jpeg', size_bytes: 256 * 1024,
        uploaded_at: new Date(Date.now() - photoIds.length * 1000).toISOString(),
      }).returning('id');
      photoIds.push(r[0]?.id ?? r[0]);
    }

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  // How the response ended: 'complete' (a clean end), 'aborted' (connection
  // broken) or 'timeout' (still hanging).
  const outcome = (method, url, body, timeoutMs = 3000) => new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const done = (result) => {
        clearTimeout(timer);
        server.closeAllConnections?.();
        server.close(() => resolve(result));
      };
      const timer = setTimeout(() => done('timeout'), timeoutMs);
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, path: url, method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      }, (res) => {
        res.on('data', () => {});
        res.on('aborted', () => done('aborted'));
        res.on('error', () => done('aborted'));
        res.on('end', () => done(res.complete ? 'complete' : 'aborted'));
      });
      req.on('error', () => done('aborted'));
      if (payload) req.write(payload);
      req.end();
    });
  });

  const cases = [
    ['download-all', () => ['GET', `/api/gallery/${SLUG}/download-all`, null]],
    ['download-selected', () => ['POST', `/api/gallery/${SLUG}/download-selected`, { photo_ids: photoIds }]],
  ];

  describe.each(cases)('%s', (_name, args) => {
    it('breaks the connection when a read fails mid-copy', async () => {
      mockMode.value = 'mid';
      expect(await outcome(...args())).toBe('aborted');
    });

    it('breaks the connection when a queued read fails before it starts', async () => {
      mockMode.value = 'early';
      expect(await outcome(...args())).toBe('aborted');
    });

    it('still completes when every read succeeds', async () => {
      mockMode.value = 'none';
      expect(await outcome(...args())).toBe('complete');
    });
  });
});
