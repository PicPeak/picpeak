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
// External (reference) photos are read by archiver itself via archive.file().
process.env.EXTERNAL_MEDIA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-gzipfail-ext-'));

const { Readable } = require('stream');

const SLUG = 'zip-failure';
const MIXED_SLUG = 'zip-mixed';
const mockBodies = new Map();
const mockMode = { value: 'mid' };

const mockStorage = {
  kind: () => 's3',
  stat: jest.fn(async (key) => (mockBodies.has(key) ? { size: mockBodies.get(key).length, mtime: new Date() } : null)),
  get: jest.fn(async (key) => {
    const body = mockBodies.get(key);
    const failing = key.endsWith('/b.jpg');
    const slow = key.endsWith('/a.jpg');
    // Let archiver queue the external file (stat first) ahead of this read.
    if (failing && mockMode.value === 'late') await new Promise((r) => setTimeout(r, 50));
    const stream = Readable.from((async function* read() {
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
    // 'late': the socket dies while the read is still queued and unread,
    // as an S3 connection reset does.
    if (failing && mockMode.value === 'late') {
      setTimeout(() => stream.destroy(Object.assign(new Error('socket reset by peer'), { code: 'ECONNRESET' })), 30);
    }
    return stream;
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

    // A mixed-source gallery: a large external file ahead of a failing S3 read.
    const mixed = await db('events').insert({
      slug: MIXED_SLUG, event_type: 'wedding', event_name: 'Zip mixed', event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${MIXED_SLUG}/s`, share_token: 'zip-mixed-share',
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, require_password: 0, allow_downloads: 1,
      created_at: new Date().toISOString(),
    }).returning('id');
    const mixedId = mixed[0]?.id ?? mixed[0];
    fs.writeFileSync(path.join(process.env.EXTERNAL_MEDIA_ROOT, 'big.mov'), crypto.randomBytes(16 * 1024 * 1024));
    await db('photos').insert({
      event_id: mixedId, filename: 'big.mov', path: 'big.mov', type: 'individual',
      source_origin: 'external', external_relpath: 'big.mov', media_type: 'video',
      mime_type: 'video/quicktime', size_bytes: 16 * 1024 * 1024,
      uploaded_at: new Date().toISOString(),
    });
    mockBodies.set(`events/active/${MIXED_SLUG}/b.jpg`, crypto.randomBytes(256 * 1024));
    await db('photos').insert({
      event_id: mixedId, filename: 'b.jpg', path: `${MIXED_SLUG}/b.jpg`, type: 'individual',
      source_origin: 'managed', mime_type: 'image/jpeg', size_bytes: 256 * 1024,
      uploaded_at: new Date(Date.now() - 1000).toISOString(),
    });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  // How the response ended: 'complete' (a clean end), 'aborted' (connection
  // broken) or 'timeout' (still hanging).
  const outcome = (method, url, body, timeoutMs = 3000, { pauseMs = 0, disconnectAfterMs = null } = {}) => new Promise((resolve) => {
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
        // A slow client pauses after every chunk, so the socket stays full
        // and the tail of the archive is still queued server-side when the
        // archive itself has ended.
        let disconnectScheduled = false;
        res.on('data', () => {
          // Simulate a guest closing the tab mid-download, once the archive
          // has actually started streaming (not before headers land).
          if (disconnectAfterMs !== null && !disconnectScheduled) {
            disconnectScheduled = true;
            setTimeout(() => req.destroy(), disconnectAfterMs);
          }
          if (!pauseMs) return;
          res.pause();
          setTimeout(() => res.resume(), pauseMs);
        });
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

  // Open descriptors of this process (macOS and Linux both expose /dev/fd).
  const openFds = () => fs.readdirSync('/dev/fd').length;

  it('closes an external file being copied when a queued read fails', async () => {
    // archive.file() sources are not in the stream guard. Unpiping the
    // archive on abort left the active one paused with its descriptor open.
    // 'late': the queued read fails once the external copy is under way.
    mockMode.value = 'late';
    const before = openFds();
    // A slow client keeps the external copy running when the read fails.
    expect(await outcome('GET', `/api/gallery/${MIXED_SLUG}/download-all`, null, 10000, { pauseMs: 5 })).toBe('aborted');
    let after = openFds();
    for (let i = 0; i < 40 && after > before; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      after = openFds();
    }
    expect(after).toBeLessThanOrEqual(before);
  });

  it('closes an external file being copied when the client disconnects mid-copy', async () => {
    // No induced read failure here (issue 1587): every read succeeds, but the
    // guest closes the tab while archiver is still copying the external file.
    // res.on('close') used to abort only the archive — archive.file() sources
    // aren't in the guard, so the active entry stayed paused with its
    // descriptor open once nothing read the archive any more.
    mockMode.value = 'none';
    const before = openFds();
    expect(await outcome('GET', `/api/gallery/${MIXED_SLUG}/download-all`, null, 10000, {
      pauseMs: 5, disconnectAfterMs: 20,
    })).toBe('aborted');
    let after = openFds();
    for (let i = 0; i < 40 && after > before; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      after = openFds();
    }
    expect(after).toBeLessThanOrEqual(before);
  });

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

    it('still completes for a slow client when the download log write fails', async () => {
      // The archive is built but not yet drained when the access_logs insert
      // runs; its failure must not destroy the response.
      mockMode.value = 'none';
      // Large enough that the socket buffers can't absorb the whole archive.
      const saved = new Map(mockBodies);
      for (const key of saved.keys()) mockBodies.set(key, crypto.randomBytes(2 * 1024 * 1024));
      const origInsert = db.client.query.bind(db.client);
      db.client.query = async (conn, obj) => {
        if (/^insert into [`"]?access_logs/i.test(obj.sql || '')) throw new Error('log table unavailable');
        return origInsert(conn, obj);
      };
      try {
        expect(await outcome(...args(), 20000, { pauseMs: 5 })).toBe('complete');
      } finally {
        db.client.query = origInsert;
        for (const [key, value] of saved) mockBodies.set(key, value);
      }
    }, 30000);
  });
});
