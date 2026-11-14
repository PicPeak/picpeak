/**
 * The synchronous gallery ZIP routes render at the pace their client reads.
 *
 * download-all's streaming fallback and download-selected render each photo
 * into a Buffer (resize and/or watermark) and append it to archiver. The
 * routes now keep only a couple of appended entries outstanding, so a client
 * that stops reading leaves the route waiting instead of rendering the rest of
 * the selection into archiver's queue, and a response that writes nothing for
 * the idle timeout is ended, which gives its admission slot back.
 *
 * Bounded: 24 photos of 2 MiB rendered (random, so deflate cannot shrink
 * them), real HTTP server on 127.0.0.1, raw socket that stops reading after
 * the response headers.
 */

const crypto = require('crypto');
const net = require('net');
const { Readable } = require('stream');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'archive-pacing-secret';
process.env.ZIP_STREAM_IDLE_TIMEOUT_MS = '1500';

const SLUG = 'archive-pacing';
const PHOTO_COUNT = 24;
// Large enough that loopback socket buffers (several MiB on Linux) absorb
// only a few entries.
const RENDER_BYTES = 2 * 1024 * 1024;

const mockStorage = {
  kind: () => 's3',
  stat: jest.fn(async () => ({ size: 1024, mtime: new Date() })),
  get: jest.fn(async () => Readable.from([Buffer.alloc(1024)])),
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
const mockRenders = { count: 0, slowFirstMs: 0 };
jest.mock('../../src/services/downloadRendition', () => {
  const actual = jest.requireActual('../../src/services/downloadRendition');
  // eslint-disable-next-line global-require
  const nodeCrypto = require('crypto');
  return {
    ...actual,
    renderPhotoForDownload: async () => {
      mockRenders.count += 1;
      if (mockRenders.count === 1 && mockRenders.slowFirstMs) {
        await new Promise((r) => setTimeout(r, mockRenders.slowFirstMs));
      }
      return nodeCrypto.randomBytes(2 * 1024 * 1024);
    },
  };
});

const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { streamingArchiveAdmission } = require('../../src/utils/archiveStreamGuard');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('gallery ZIP routes pace rendering by the reader', () => {
  let db; let cleanup; let server; let port; let eventId; const photoIds = []; const sockets = [];

  const token = () => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' },
  );

  /** Send a request, stop reading as soon as the headers arrive. */
  function stalledRequest(method, pathName, body) {
    const socket = net.connect(port, '127.0.0.1');
    sockets.push(socket);
    let closed = false;
    let headers = '';
    const gotHeaders = new Promise((resolve) => {
      let seen = false;
      socket.on('data', (chunk) => {
        if (seen) return;
        headers += chunk.toString('latin1');
        if (headers.includes('\r\n\r\n')) {
          seen = true;
          socket.pause();
          resolve(headers.split('\r\n')[0]);
        }
      });
    });
    const gone = new Promise((resolve) => socket.on('close', () => { closed = true; resolve(); }));
    socket.on('error', () => {});
    const payload = body ? JSON.stringify(body) : '';
    socket.write([
      `${method} ${pathName} HTTP/1.1`,
      'Host: 127.0.0.1',
      `Authorization: Bearer ${token()}`,
      ...(body ? ['Content-Type: application/json', `Content-Length: ${Buffer.byteLength(payload)}`] : []),
      '',
      payload,
    ].join('\r\n'));
    return { socket, gotHeaders, gone, isClosed: () => closed };
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const ev = await db('events').insert({
      slug: SLUG, event_type: 'wedding', event_name: 'Archive pacing', event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${SLUG}/s`, share_token: 'archive-pacing-share',
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, require_password: 0, allow_downloads: 1,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = ev[0]?.id ?? ev[0];

    for (let i = 0; i < PHOTO_COUNT; i += 1) {
      const filename = `p${i}-${crypto.randomBytes(3).toString('hex')}.jpg`;
      const r = await db('photos').insert({
        event_id: eventId, filename, path: `${SLUG}/${filename}`, type: 'individual',
        source_origin: 'managed', mime_type: 'image/jpeg', size_bytes: RENDER_BYTES,
        uploaded_at: new Date(Date.now() - i * 1000).toISOString(),
      }).returning('id');
      photoIds.push(r[0]?.id ?? r[0]);
    }

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    ({ port } = server.address());
  }, 180000);

  afterAll(async () => {
    sockets.forEach((socket) => socket.destroy());
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    if (cleanup) await cleanup();
  });

  beforeEach(() => { mockRenders.count = 0; mockRenders.slowFirstMs = 0; });

  const routes = [
    ['download-selected', () => ['POST', `/api/gallery/${SLUG}/download-selected`, { photo_ids: photoIds }]],
    ['download-all streaming fallback', () => ['GET', `/api/gallery/${SLUG}/download-all`, null]],
  ];

  it.each(routes)('%s stops rendering while the client reads nothing, then drops it', async (_label, build) => {
    const stalled = stalledRequest(...build());
    expect(await stalled.gotHeaders).toMatch(/ 200 /);

    // Wait until rendering has settled (no new render for 300 ms) — plenty of
    // time to render everything if nothing paced it. How long the socket and
    // stream buffers take to fill depends on the machine, so this polls
    // rather than using a fixed delay.
    let rendered = mockRenders.count;
    let stableSince = Date.now();
    const settleBy = Date.now() + 3000;
    while (Date.now() - stableSince < 300 && Date.now() < settleBy) {
      await wait(50);
      if (mockRenders.count !== rendered) { rendered = mockRenders.count; stableSince = Date.now(); }
    }
    expect(rendered).toBeGreaterThan(0);
    // Socket and stream buffers absorb a few entries; the rest must wait.
    expect(rendered).toBeLessThan(PHOTO_COUNT / 2);
    // And it stays there while the client is idle (one late buffered entry
    // at most).
    await wait(300);
    expect(mockRenders.count).toBeLessThanOrEqual(rendered + 1);
    expect(stalled.isClosed()).toBe(false);

    // The idle timeout (1.5 s here) ends the stalled response on the server
    // side, which gives its admission slot back.
    const deadline = Date.now() + 8000;
    while (streamingArchiveAdmission.active > 0 && Date.now() < deadline) await wait(100);
    expect(streamingArchiveAdmission.active).toBe(0);
    expect(mockRenders.count).toBeLessThan(PHOTO_COUNT / 2);
    // A paused socket only sees the close once it reads again.
    stalled.socket.resume();
    await Promise.race([stalled.gone, wait(3000)]);
    expect(stalled.isClosed()).toBe(true);
  }, 20000);

  it('a reading client waiting on a slow render is not dropped', async () => {
    // Longer than the 1.5 s idle timeout, with nothing written meanwhile.
    mockRenders.slowFirstMs = 2500;
    const res = await fetch(`http://127.0.0.1:${port}/api/gallery/${SLUG}/download-selected`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo_ids: photoIds }),
    });
    expect(res.status).toBe(200);
    const zip = Buffer.from(await res.arrayBuffer());
    expect(mockRenders.count).toBe(PHOTO_COUNT);
    expect(zip.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(true);
  }, 20000);

  it('a reading client still gets every photo', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/gallery/${SLUG}/download-selected`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo_ids: photoIds }),
    });
    expect(res.status).toBe(200);
    const zip = Buffer.from(await res.arrayBuffer());
    expect(mockRenders.count).toBe(PHOTO_COUNT);
    expect(zip.length).toBeGreaterThan(PHOTO_COUNT * RENDER_BYTES);
    // End-of-central-directory record: the archive was finalized.
    expect(zip.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(true);
    expect(streamingArchiveAdmission.active).toBe(0);
  }, 20000);
});
