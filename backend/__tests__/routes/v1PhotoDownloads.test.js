/**
 * Original downloads through the v1 API (issue 1473).
 *
 * An integration (n8n → WhatsApp) holds an API token, lists an event's photos
 * with GET /api/v1/events/:id/photos, and needs the ORIGINAL bytes of each —
 * no admin session, no gallery password. Pinned here:
 *
 *   - the exact stored bytes, with the content type, an RFC 5987 filename,
 *     Content-Length and nosniff;
 *   - the authorization chain: read scope ∩ photos.view + photos.download on
 *     the owner's role, event ownership, photo ↔ event binding;
 *   - archived events answer 409, a missing file 404 PHOTO_FILE_MISSING;
 *   - nothing lands in the guest statistics (access_logs, download_count);
 *     one activity_logs row per download, ids only;
 *   - the bulk ZIP: byte-identical stored entries, ids filter, deduped names,
 *     a MISSING_FILES.txt manifest, the size cap, and a client abort.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-v1dl-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'v1dl-test-secret';

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const StreamZip = require('node-stream-zip');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { generateApiToken } = require('../../src/middleware/apiTokenAuth');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const binaryParser = (response, cb) => {
  const chunks = [];
  response.on('data', (c) => chunks.push(c));
  response.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function waitFor(fn, timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function readZip(buffer) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-v1dl-zip-')), 'out.zip');
  fs.writeFileSync(file, buffer);
  const zip = new StreamZip.async({ file });
  const entries = await zip.entries();
  const out = {};
  for (const [name, entry] of Object.entries(entries)) {
    out[name] = { method: entry.method, data: await zip.entryData(name) };
  }
  await zip.close();
  return out;
}

describe('v1 original downloads (issue 1473)', () => {
  let db; let cleanup; let app; let storageRoot;
  let superId; let adminId; let editorId;
  let readToken; let noScopeToken; let editorToken; let foreignAdminToken;
  let revokedToken; let expiredToken; let readTokenId;
  let eventId; let otherEventId; let archivedEventId; let capEventId; let editorEventId;
  const photos = {};
  const bytes = {};

  const mkAdmin = async (username, roleName) => {
    const role = await db('roles').where({ name: roleName }).first();
    const r = await db('admin_users').insert({
      username,
      email: `${username}@example.com`,
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id');
    return r[0]?.id ?? r[0];
  };

  const mkToken = async (ownerId, scopes, extra = {}) => {
    const { plaintext, hashed } = generateApiToken();
    const r = await db('api_tokens').insert({
      name: `tok-${ownerId}-${scopes}-${crypto.randomBytes(3).toString('hex')}`,
      hashed_token: hashed,
      scopes,
      created_by: ownerId,
      created_at: new Date().toISOString(),
      ...extra,
    }).returning('id');
    return { plaintext, id: r[0]?.id ?? r[0] };
  };

  const mkEvent = async (slug, createdBy, extra = {}) => {
    const r = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: slug,
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_token: `share-${slug}`,
      share_link: `/gallery/${slug}/share-${slug}`,
      created_by: createdBy,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
      ...extra,
    }).returning('id');
    return r[0]?.id ?? r[0];
  };

  // Writes the file under the managed layout unless `onDisk` is false.
  const mkPhoto = async (key, evId, slug, filename, body, extra = {}, onDisk = true) => {
    const rel = `${slug}/individual/${filename}`;
    if (onDisk) {
      const abs = path.join(storageRoot, 'events/active', rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    const r = await db('photos').insert({
      event_id: evId,
      filename,
      path: rel,
      type: 'individual',
      source_origin: 'managed',
      mime_type: 'image/jpeg',
      size_bytes: body.length,
      uploaded_at: new Date().toISOString(),
      ...extra,
    }).returning('id');
    const id = r[0]?.id ?? r[0];
    photos[key] = id;
    bytes[key] = body;
    return id;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    storageRoot = process.env.STORAGE_PATH;
    await seedMinimal(db);

    superId = await mkAdmin('dl-root', 'super_admin');
    adminId = await mkAdmin('dl-admin', 'admin');
    editorId = await mkAdmin('dl-editor', 'editor');

    ({ plaintext: readToken, id: readTokenId } = await mkToken(superId, 'read'));
    ({ plaintext: noScopeToken } = await mkToken(superId, 'none'));
    ({ plaintext: editorToken } = await mkToken(editorId, 'admin'));
    ({ plaintext: foreignAdminToken } = await mkToken(adminId, 'admin'));
    ({ plaintext: revokedToken } = await mkToken(superId, 'read', { revoked_at: new Date().toISOString() }));
    ({ plaintext: expiredToken } = await mkToken(superId, 'read', { expires_at: new Date(Date.now() - 60000).toISOString() }));

    eventId = await mkEvent('dl-main', superId);
    otherEventId = await mkEvent('dl-other', superId);
    archivedEventId = await mkEvent('dl-archived', superId, {
      is_archived: 1, archive_path: 'events/archived/dl-archived.zip',
    });
    capEventId = await mkEvent('dl-cap', superId);
    editorEventId = await mkEvent('dl-editor', editorId);

    // Random bytes: a transformed (resized, watermarked, re-encoded) response
    // cannot reproduce them, so a matching hash proves the stored original.
    await mkPhoto('jpeg', eventId, 'dl-main', 'dl-main_0001.jpg', crypto.randomBytes(64 * 1024), {
      original_filename: 'Hochzeit Müller "final".jpg',
    });
    await mkPhoto('png', eventId, 'dl-main', 'dl-main_0002.png', crypto.randomBytes(2048), {
      mime_type: 'image/png', original_filename: 'IMG_0001.png',
    });
    await mkPhoto('dupe', eventId, 'dl-main', 'dl-main_0003.jpg', crypto.randomBytes(4096), {
      original_filename: 'IMG_0001.png',
    });
    await mkPhoto('video', eventId, 'dl-main', 'dl-main_0004.mp4', crypto.randomBytes(8192), {
      media_type: 'video', mime_type: 'video/mp4', original_filename: 'clip.mp4',
    });
    await mkPhoto('missing', eventId, 'dl-main', 'dl-main_0005.jpg', Buffer.from('gone'), {
      original_filename: 'gone.jpg',
    }, false);
    await mkPhoto('foreign', otherEventId, 'dl-other', 'dl-other_0001.jpg', crypto.randomBytes(1024));
    await mkPhoto('archived', archivedEventId, 'dl-archived', 'dl-archived_0001.jpg', Buffer.from('x'), {}, false);
    await mkPhoto('editorOwn', editorEventId, 'dl-editor', 'dl-editor_0001.jpg', crypto.randomBytes(1024));

    // Eleven 2 GB rows: over the 20 GiB cap without writing a byte.
    for (let i = 0; i < 11; i += 1) {
      await mkPhoto(`cap${i}`, capEventId, 'dl-cap', `dl-cap_${i}.jpg`, Buffer.alloc(0), {
        size_bytes: 2000000000,
      }, false);
    }

    app = express();
    app.use(express.json());
    app.use('/api/v1', require('../../src/routes/v1/events'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  const get = (url, token = readToken) => request(app)
    .get(url)
    .set('Authorization', `Bearer ${token}`)
    .buffer(true)
    .parse(binaryParser);

  const json = (res) => JSON.parse(res.body.toString('utf8'));

  describe('single original', () => {
    it('streams the exact stored bytes with download headers', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/${photos.jpeg}/download`);
      expect(res.status).toBe(200);
      expect(sha256(res.body)).toBe(sha256(bytes.jpeg));
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['content-length']).toBe(String(bytes.jpeg.length));
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      const cd = res.headers['content-disposition'];
      expect(cd).toMatch(/^attachment; /);
      // ASCII fallback: quotes and the umlaut are neutralised, so the
      // quoted-string cannot be broken out of.
      expect(cd).toContain('filename="Hochzeit M_ller _final_.jpg"');
      expect(cd).toContain('filename*=UTF-8\'\'Hochzeit%20M%C3%BCller%20%22final%22.jpg');
    });

    it('keeps the stored content type (png)', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/${photos.png}/download`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(sha256(res.body)).toBe(sha256(bytes.png));
    });

    it('serves videos through the same endpoint', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/${photos.video}/download`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('video/mp4');
      expect(res.headers['content-disposition']).toContain('filename="clip.mp4"');
      expect(sha256(res.body)).toBe(sha256(bytes.video));
    });

    it('answers a photo of another event with the same 404 as an unknown id', async () => {
      const foreign = await get(`/api/v1/events/${eventId}/photos/${photos.foreign}/download`);
      const unknown = await get(`/api/v1/events/${eventId}/photos/999999/download`);
      const garbage = await get(`/api/v1/events/${eventId}/photos/1abc/download`);
      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(garbage.status).toBe(404);
      expect(json(foreign)).toEqual(json(unknown));
      expect(json(garbage)).toEqual(json(unknown));
    });

    it('answers 404 PHOTO_FILE_MISSING when the row exists but the file does not', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/${photos.missing}/download`);
      expect(res.status).toBe(404);
      expect(json(res).code).toBe('PHOTO_FILE_MISSING');
    });

    it('answers 409 EVENT_ARCHIVED for an archived event', async () => {
      const res = await get(`/api/v1/events/${archivedEventId}/photos/${photos.archived}/download`);
      expect(res.status).toBe(409);
      expect(json(res).code).toBe('EVENT_ARCHIVED');
    });

    it('rejects a token without the read scope', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/${photos.jpeg}/download`, noScopeToken);
      expect(res.status).toBe(403);
      expect(json(res).code).toBe('INSUFFICIENT_SCOPE');
    });

    it('rejects an owner whose role lacks photos.download, even on their own event', async () => {
      // The same token can list the photos (photos.view), so the 403 below
      // is the photos.download gate, not ownership.
      const list = await get(`/api/v1/events/${editorEventId}/photos`, editorToken);
      expect(list.status).toBe(200);
      const res = await get(`/api/v1/events/${editorEventId}/photos/${photos.editorOwn}/download`, editorToken);
      expect(res.status).toBe(403);
      expect(json(res).code).toBe('FORBIDDEN');
      expect(res.body.toString()).not.toContain(bytes.editorOwn.toString('latin1').slice(0, 16));
    });

    it('rejects an admin token for an event its owner does not own', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/${photos.jpeg}/download`, foreignAdminToken);
      expect(res.status).toBe(403);
      expect(sha256(res.body)).not.toBe(sha256(bytes.jpeg));
    });

    it('rejects revoked and expired tokens', async () => {
      const revoked = await get(`/api/v1/events/${eventId}/photos/${photos.jpeg}/download`, revokedToken);
      const expired = await get(`/api/v1/events/${eventId}/photos/${photos.jpeg}/download`, expiredToken);
      expect(revoked.status).toBe(401);
      expect(expired.status).toBe(401);
    });

    it('stays out of the guest statistics and logs one ids-only activity row', async () => {
      await db('activity_logs').where({ event_id: eventId }).delete();
      const res = await get(`/api/v1/events/${eventId}/photos/${photos.png}/download`);
      expect(res.status).toBe(200);

      const rows = await waitFor(async () => {
        const r = await db('activity_logs')
          .where({ event_id: eventId, activity_type: 'api_photo_downloaded' });
        return r.length ? r : null;
      });
      expect(rows).toHaveLength(1);
      const metadata = typeof rows[0].metadata === 'string' ? JSON.parse(rows[0].metadata) : rows[0].metadata;
      expect(metadata).toEqual({ via: 'api_v1', token_id: Number(readTokenId), photo_id: Number(photos.png) });
      expect(Number(rows[0].actor_id)).toBe(Number(superId));

      const accessRows = await db('access_logs').where({ event_id: eventId });
      expect(accessRows).toHaveLength(0);
      const counted = await db('photos').where({ event_id: eventId }).sum('download_count as n').first();
      expect(Number(counted.n || 0)).toBe(0);
    });
  });

  it('answers HEAD with the headers and logs nothing', async () => {
    await db('activity_logs').where({ event_id: eventId }).delete();
    const single = await request(app)
      .head(`/api/v1/events/${eventId}/photos/${photos.png}/download`)
      .set('Authorization', `Bearer ${readToken}`);
    expect(single.status).toBe(200);
    expect(single.headers['content-length']).toBe(String(bytes.png.length));
    const zip = await request(app)
      .head(`/api/v1/events/${eventId}/photos/download`)
      .set('Authorization', `Bearer ${readToken}`);
    expect(zip.status).toBe(200);
    expect(zip.headers['content-type']).toBe('application/zip');
    await new Promise((r) => setTimeout(r, 100));
    expect(await db('activity_logs').where({ event_id: eventId })).toHaveLength(0);
  });

  describe('ZIP of originals', () => {
    it('streams every original, stored uncompressed, with deduped names and a missing-file manifest', async () => {
      await db('activity_logs').where({ event_id: eventId }).delete();
      const res = await get(`/api/v1/events/${eventId}/photos/download`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['content-disposition']).toContain('dl-main-originals.zip');

      const entries = await readZip(res.body);
      const names = Object.keys(entries).sort();
      expect(names).toEqual([
        'Hochzeit Müller "final".jpg',
        'IMG_0001.png',
        'IMG_0001_1.png',
        'MISSING_FILES.txt',
        'clip.mp4',
      ].sort());
      expect(sha256(entries['Hochzeit Müller "final".jpg'].data)).toBe(sha256(bytes.jpeg));
      expect(sha256(entries['clip.mp4'].data)).toBe(sha256(bytes.video));
      // Order is by stored filename: _0002.png before _0003.jpg.
      expect(sha256(entries['IMG_0001.png'].data)).toBe(sha256(bytes.png));
      expect(sha256(entries['IMG_0001_1.png'].data)).toBe(sha256(bytes.dupe));
      for (const name of names) expect(entries[name].method).toBe(0); // STORE

      const manifest = entries['MISSING_FILES.txt'].data.toString('utf8');
      expect(manifest).toContain(String(photos.missing));
      expect(manifest).not.toContain('gone.jpg');

      const rows = await waitFor(async () => {
        const r = await db('activity_logs')
          .where({ event_id: eventId, activity_type: 'api_photos_zip_downloaded' });
        return r.length ? r : null;
      });
      expect(rows).toHaveLength(1);
      const metadata = typeof rows[0].metadata === 'string' ? JSON.parse(rows[0].metadata) : rows[0].metadata;
      expect(metadata).toEqual({ via: 'api_v1', token_id: Number(readTokenId), photo_count: 4, missing_count: 1 });
      expect(await db('access_logs').where({ event_id: eventId })).toHaveLength(0);
    });

    it('limits the archive to ?ids=', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/download?ids=${photos.png},${photos.video}`);
      expect(res.status).toBe(200);
      const entries = await readZip(res.body);
      expect(Object.keys(entries).sort()).toEqual(['IMG_0001.png', 'clip.mp4']);
      expect(sha256(entries['IMG_0001.png'].data)).toBe(sha256(bytes.png));
    });

    it('applies the list filters (min_rating)', async () => {
      await db('photos').where({ id: photos.png }).update({ average_rating: 4 });
      try {
        const res = await get(`/api/v1/events/${eventId}/photos/download?min_rating=3`);
        expect(res.status).toBe(200);
        expect(Object.keys(await readZip(res.body))).toEqual(['IMG_0001.png']);
      } finally {
        await db('photos').where({ id: photos.png }).update({ average_rating: 0 });
      }
    });

    it('rejects ids that do not belong to the event without naming them', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/download?ids=${photos.png},${photos.foreign}`);
      expect(res.status).toBe(400);
      const body = json(res);
      expect(body.code).toBe('INVALID_PHOTO_IDS');
      expect(JSON.stringify(body)).not.toContain(String(photos.foreign));
    });

    it('rejects malformed and oversized id lists', async () => {
      const bad = await get(`/api/v1/events/${eventId}/photos/download?ids=1,abc`);
      expect(bad.status).toBe(400);
      expect(json(bad).code).toBe('INVALID_PHOTO_IDS');

      const many = Array.from({ length: 501 }, (_, i) => i + 1).join(',');
      const tooMany = await get(`/api/v1/events/${eventId}/photos/download?ids=${many}`);
      expect(tooMany.status).toBe(400);
      expect(json(tooMany).code).toBe('TOO_MANY_PHOTO_IDS');
    });

    it('refuses an archive over the size cap before streaming anything', async () => {
      const res = await get(`/api/v1/events/${capEventId}/photos/download`);
      expect(res.status).toBe(400);
      expect(json(res).code).toBe('ZIP_TOO_LARGE');
    });

    it('answers 409 EVENT_ARCHIVED for an archived event', async () => {
      const res = await get(`/api/v1/events/${archivedEventId}/photos/download`);
      expect(res.status).toBe(409);
      expect(json(res).code).toBe('EVENT_ARCHIVED');
    });

    it('applies the same authorization chain', async () => {
      const noScope = await get(`/api/v1/events/${eventId}/photos/download`, noScopeToken);
      const noPerm = await get(`/api/v1/events/${editorEventId}/photos/download`, editorToken);
      const foreign = await get(`/api/v1/events/${eventId}/photos/download`, foreignAdminToken);
      expect(noScope.status).toBe(403);
      expect(noPerm.status).toBe(403);
      expect(foreign.status).toBe(403);
    });

    it('survives a client that hangs up mid-archive', async () => {
      // Big enough that the archive is still streaming when the socket dies.
      for (let i = 0; i < 4; i += 1) {
        await mkPhoto(`big${i}`, otherEventId, 'dl-other', `dl-other_big_${i}.jpg`, crypto.randomBytes(4 * 1024 * 1024));
      }
      const server = http.createServer(app);
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address();
      try {
        await new Promise((resolve, reject) => {
          const req = http.get({
            host: '127.0.0.1', port, path: `/api/v1/events/${otherEventId}/photos/download`,
            headers: { Authorization: `Bearer ${readToken}` },
          }, (res) => {
            if (res.statusCode !== 200) {
              req.destroy();
              reject(new Error(`expected 200, got ${res.statusCode}`));
              return;
            }
            res.once('data', () => { req.destroy(); resolve(); });
          });
          req.on('error', (err) => (err.code === 'ECONNRESET' ? resolve() : reject(err)));
        });
        await new Promise((r) => setTimeout(r, 200));

        // The process and the route are still healthy afterwards.
        const after = await get(`/api/v1/events/${eventId}/photos/${photos.png}/download`);
        expect(after.status).toBe(200);
        const zipRows = await db('activity_logs')
          .where({ event_id: otherEventId, activity_type: 'api_photos_zip_downloaded' });
        expect(zipRows).toHaveLength(0);
      } finally {
        await new Promise((r) => server.close(r));
      }
    });
  });
});
