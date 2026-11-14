/**
 * The v1 originals ZIP is paced by its client and drops one that stops reading.
 *
 * With ?resolution= every photo is rendered into a Buffer and appended to
 * archiver. The route now goes through the same pacer as the gallery ZIPs:
 * at most two appended entries outstanding before the next render, and a
 * response whose client has stopped reading is ended after the idle timeout,
 * which the route lacked before (a stalled client held its per-token slot
 * and its queued renditions for as long as the connection stayed open).
 *
 * Bounded: 40 photos rendered as 512 KiB of random bytes, real HTTP server on
 * 127.0.0.1, raw socket that stops reading after the response headers.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-v1zippace-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'v1zippace-test-secret';
process.env.ZIP_STREAM_IDLE_TIMEOUT_MS = '1500';

const PHOTO_COUNT = 40;

const mockRenders = { count: 0 };
jest.mock('../../src/services/downloadRendition', () => {
  const actual = jest.requireActual('../../src/services/downloadRendition');
  // eslint-disable-next-line global-require
  const nodeCrypto = require('crypto');
  return {
    ...actual,
    renderPhotoForDownload: async () => {
      mockRenders.count += 1;
      return nodeCrypto.randomBytes(512 * 1024);
    },
  };
});

const express = require('express');
const bcrypt = require('bcrypt');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { generateApiToken } = require('../../src/middleware/apiTokenAuth');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('v1 originals ZIP paces rendering by the reader', () => {
  let db; let cleanup; let server; let port; let token; let eventId;
  const sockets = [];

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const storageRoot = process.env.STORAGE_PATH;
    await seedMinimal(db);

    const role = await db('roles').where({ name: 'super_admin' }).first();
    const admin = await db('admin_users').insert({
      username: 'zippace-root', email: 'zippace-root@example.com',
      password_hash: await bcrypt.hash('Passw0rd!', 4), role_id: role.id, is_active: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id');
    const adminId = admin[0]?.id ?? admin[0];
    const { plaintext, hashed } = generateApiToken();
    await db('api_tokens').insert({
      name: 'zippace', hashed_token: hashed, scopes: 'read', created_by: adminId, created_at: new Date().toISOString(),
    });
    token = plaintext;

    const ev = await db('events').insert({
      slug: 'zippace', event_type: 'wedding', event_name: 'zippace', event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_token: 'share-zippace', share_link: '/gallery/zippace/share-zippace', created_by: adminId,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id');
    eventId = ev[0]?.id ?? ev[0];

    for (let i = 0; i < PHOTO_COUNT; i += 1) {
      const filename = `zp_${String(i).padStart(4, '0')}.jpg`;
      const rel = `zippace/individual/${filename}`;
      const abs = path.join(storageRoot, 'events/active', rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, crypto.randomBytes(256));
      await db('photos').insert({
        event_id: eventId, filename, path: rel, type: 'individual', source_origin: 'managed',
        mime_type: 'image/jpeg', size_bytes: 256, uploaded_at: new Date().toISOString(),
      });
    }

    const app = express();
    app.use(express.json());
    app.use('/api/v1', require('../../src/routes/v1/events'));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    ({ port } = server.address());
  }, 120000);

  afterAll(async () => {
    sockets.forEach((socket) => socket.destroy());
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    if (cleanup) await cleanup();
  });

  beforeEach(() => { mockRenders.count = 0; });

  it('stops rendering while the client reads nothing, then drops it', async () => {
    const socket = net.connect(port, '127.0.0.1');
    sockets.push(socket);
    let closed = false;
    const gone = new Promise((resolve) => socket.on('close', () => { closed = true; resolve(); }));
    socket.on('error', () => {});
    let seen = false; let head = '';
    const status = new Promise((resolve) => {
      socket.on('data', (chunk) => {
        if (seen) return;
        head += chunk.toString('latin1');
        if (head.includes('\r\n\r\n')) { seen = true; socket.pause(); resolve(head.split('\r\n')[0]); }
      });
    });
    socket.write([
      `GET /api/v1/events/${eventId}/photos/download?resolution=400x400 HTTP/1.1`,
      'Host: 127.0.0.1',
      `Authorization: Bearer ${token}`,
      '', '',
    ].join('\r\n'));

    expect(await status).toMatch(/ 200 /);
    await wait(700);
    expect(mockRenders.count).toBeGreaterThan(0);
    // Socket and stream buffers absorb a few entries; the rest must wait.
    expect(mockRenders.count).toBeLessThan(PHOTO_COUNT / 2);
    expect(closed).toBe(false);

    // The idle timeout (1.5 s here) ends the stalled response; a paused
    // socket only sees that once it reads again.
    await wait(2500);
    expect(mockRenders.count).toBeLessThan(PHOTO_COUNT / 2);
    socket.resume();
    await Promise.race([gone, wait(3000)]);
    expect(closed).toBe(true);
  }, 20000);

  it('a reading client still gets every photo', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/events/${eventId}/photos/download?resolution=400x400`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const zip = Buffer.from(await res.arrayBuffer());
    expect(mockRenders.count).toBe(PHOTO_COUNT);
    expect(zip.length).toBeGreaterThan(PHOTO_COUNT * 512 * 1024);
    expect(zip.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(true);
  }, 20000);
});
