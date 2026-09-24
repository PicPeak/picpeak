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
// External (reference) photos are appended as read streams of files under here.
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
  let db; let cleanup; let app; const photoIds = []; const mixedPhotoIds = [];

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
    const big = await db('photos').insert({
      event_id: mixedId, filename: 'big.mov', path: 'big.mov', type: 'individual',
      source_origin: 'external', external_relpath: 'big.mov', media_type: 'video',
      mime_type: 'video/quicktime', size_bytes: 16 * 1024 * 1024,
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    mixedPhotoIds.push(big[0]?.id ?? big[0]);
    mockBodies.set(`events/active/${MIXED_SLUG}/b.jpg`, crypto.randomBytes(256 * 1024));
    const small = await db('photos').insert({
      event_id: mixedId, filename: 'b.jpg', path: `${MIXED_SLUG}/b.jpg`, type: 'individual',
      source_origin: 'managed', mime_type: 'image/jpeg', size_bytes: 256 * 1024,
      uploaded_at: new Date(Date.now() - 1000).toISOString(),
    }).returning('id');
    mixedPhotoIds.push(small[0]?.id ?? small[0]);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  // How the response ended: 'complete' (a clean end), 'aborted' (connection
  // broken) or 'timeout' (still hanging).
  const outcome = (method, url, body, timeoutMs = 3000, { pauseMs = 0 } = {}) => new Promise((resolve) => {
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
        res.on('data', () => {
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

  // Handles this process holds on the external file. Counting every open
  // descriptor is not enough: the test server's own sockets close in the same
  // window and hide one leaked file. /proc on Linux (CI), lsof on macOS.
  const EXTERNAL_FILE = path.join(process.env.EXTERNAL_MEDIA_ROOT, 'big.mov');
  const handlesToExternal = () => {
    const real = fs.realpathSync(EXTERNAL_FILE);
    if (fs.existsSync('/proc/self/fd')) {
      return fs.readdirSync('/proc/self/fd').filter((fd) => {
        try { return fs.readlinkSync(`/proc/self/fd/${fd}`) === real; } catch { return false; }
      }).length;
    }
    const out = require('child_process').execFileSync('lsof', ['-Fn', '-p', String(process.pid)], { encoding: 'utf8' });
    return out.split('\n').filter((line) => line === `n${real}` || line === `n${EXTERNAL_FILE}`).length;
  };
  const closedWithin = async (ms) => {
    for (let waited = 0; waited < ms && handlesToExternal() > 0; waited += 50) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return handlesToExternal();
  };

  // A slow client that hangs up once the external file is actually being
  // copied, rather than after a guessed delay that may land before it opens.
  const disconnectWhileCopying = (method, url, body) => new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      let sawOpen = false;
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, path: url, method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      }, (res) => {
        res.on('data', () => { res.pause(); setTimeout(() => res.resume(), 5); });
        res.on('error', () => {});
        const poll = setInterval(() => {
          if (handlesToExternal() > 0) { sawOpen = true; clearInterval(poll); req.destroy(); }
        }, 20);
        setTimeout(() => { clearInterval(poll); req.destroy(); }, 5000);
      });
      req.on('error', () => {});
      req.on('close', () => {
        server.closeAllConnections?.();
        server.close(() => resolve(sawOpen));
      });
      if (payload) req.write(payload);
      req.end();
    });
  });

  it('closes an external file being copied when a queued read fails', async () => {
    // 'late': the queued read fails once the external copy is under way.
    mockMode.value = 'late';
    // A slow client keeps the external copy running when the read fails.
    expect(await outcome('GET', `/api/gallery/${MIXED_SLUG}/download-all`, null, 10000, { pauseMs: 5 })).toBe('aborted');
    expect(await closedWithin(2000)).toBe(0);
  });

  // Issue 1587: a guest closing the tab while an external file is being
  // copied left that file open, one descriptor per cancelled download.
  it.each([
    ['download-all', () => ['GET', `/api/gallery/${MIXED_SLUG}/download-all`, null]],
    ['download-selected', () => ['POST', `/api/gallery/${MIXED_SLUG}/download-selected`, { photo_ids: mixedPhotoIds }]],
  ])('%s closes an external file being copied when the client disconnects', async (_route, args) => {
    mockMode.value = 'none';
    expect(await disconnectWhileCopying(...args())).toBe(true);
    expect(await closedWithin(2000)).toBe(0);
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
