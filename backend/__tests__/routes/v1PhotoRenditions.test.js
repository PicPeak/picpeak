/**
 * Resized renditions and preview images through the v1 API.
 *
 * #1582 gave integrations the stored ORIGINAL. A website importer wants
 * neither extreme: not a 40 MB original in a WordPress media library, and not
 * a gallery-sized guess it has to resize itself. Pinned here:
 *
 *   - ?resolution=WxH resizes into the box, keeps the aspect ratio, never
 *     enlarges, and re-encodes in the SOURCE format;
 *   - `original`, no parameter, a video and an already-small photo all come
 *     back as the exact stored bytes — a rendition is never a silent re-encode;
 *   - a rendition is never watermarked, even with the gallery watermark on;
 *   - the same applies inside the ZIP, which is renamed after the box;
 *   - GET /preview serves the admin grid's preview tier, is NOT a download
 *     (no Content-Disposition, nothing logged), and answers 503/422 while the
 *     async worker is still on a photo.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-v1rend-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'v1rend-test-secret';

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const sharp = require('sharp');
const StreamZip = require('node-stream-zip');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { generateApiToken } = require('../../src/middleware/apiTokenAuth');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const binaryParser = (response, cb) => {
  const chunks = [];
  response.on('data', (c) => chunks.push(c));
  response.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function readZip(buffer) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-v1rend-zip-')), 'out.zip');
  fs.writeFileSync(file, buffer);
  const zip = new StreamZip.async({ file });
  const entries = await zip.entries();
  const out = {};
  for (const [name] of Object.entries(entries)) out[name] = await zip.entryData(name);
  await zip.close();
  return out;
}

// A real encoded image, so sharp has something it can actually resize —
// random bytes would fall straight through resizeToBox's catch.
const makeImage = (w, h, format = 'jpeg') => sharp({
  create: {
    width: w, height: h, channels: 3,
    background: { r: 10, g: 120, b: 200 },
  },
})[format]().toBuffer();

describe('v1 photo renditions and previews', () => {
  let db; let cleanup; let app; let storageRoot;
  let superId; let readToken; let noScopeToken; let otherAdminToken;
  let eventId; let archivedEventId; let otherEventId;
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

  const mkToken = async (ownerId, scopes) => {
    const { plaintext, hashed } = generateApiToken();
    const suffix = crypto.randomBytes(3).toString('hex');
    await db('api_tokens').insert({
      name: `tok-${suffix}`,
      hashed_token: hashed,
      scopes,
      created_by: ownerId,
      created_at: new Date().toISOString(),
    });
    return plaintext;
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

    superId = await mkAdmin('rend-root', 'super_admin');
    const otherId = await mkAdmin('rend-other', 'admin');
    readToken = await mkToken(superId, 'read');
    noScopeToken = await mkToken(superId, 'none');
    otherAdminToken = await mkToken(otherId, 'admin');

    eventId = await mkEvent('rend-main', superId);
    otherEventId = await mkEvent('rend-other', superId);
    archivedEventId = await mkEvent('rend-archived', superId, {
      is_archived: 1, archive_path: 'events/archived/rend-archived.zip',
    });

    await mkPhoto('large', eventId, 'rend-main', 'rend_0001.jpg',
      await makeImage(1200, 800), { width: 1200, height: 800, original_filename: 'big.jpg' });
    await mkPhoto('small', eventId, 'rend-main', 'rend_0002.jpg',
      await makeImage(200, 150), { width: 200, height: 150, original_filename: 'small.jpg' });
    await mkPhoto('png', eventId, 'rend-main', 'rend_0003.png',
      await makeImage(900, 600, 'png'), {
        mime_type: 'image/png', width: 900, height: 600, original_filename: 'shot.png',
      });
    await mkPhoto('video', eventId, 'rend-main', 'rend_0004.mp4', crypto.randomBytes(4096), {
      media_type: 'video', mime_type: 'video/mp4', original_filename: 'clip.mp4',
    });
    await mkPhoto('gone', eventId, 'rend-main', 'rend_0005.jpg',
      Buffer.from('absent'), { original_filename: 'gone.jpg' }, false);
    await mkPhoto('pending', eventId, 'rend-main', 'rend_0006.jpg',
      await makeImage(400, 300), { processing_status: 'pending' });
    await mkPhoto('failed', eventId, 'rend-main', 'rend_0007.jpg',
      await makeImage(400, 300), { processing_status: 'failed' });
    // Declared as RAW: resizeToBox's else-branch would re-encode it as JPEG,
    // which must never go out under a .dng name and image/x-adobe-dng.
    await mkPhoto('dng', eventId, 'rend-main', 'rend_0008.dng',
      await makeImage(1200, 800), {
        mime_type: 'image/x-adobe-dng', original_filename: 'RAW_0001.dng',
      });
    // Alpha channel: generatePreviewImage writes WebP for this, not JPEG.
    await mkPhoto('alpha', eventId, 'rend-main', 'rend_0009.png',
      await sharp({
        create: {
          width: 800, height: 600, channels: 4,
          background: { r: 10, g: 120, b: 200, alpha: 0.5 },
        },
      }).png().toBuffer(), {
        mime_type: 'image/png', width: 800, height: 600, original_filename: 'alpha.png',
      });
    // A row whose key climbs out of the storage root. The stored-bytes path
    // already answers 404; the rendition path must agree.
    const escapeRow = await db('photos').insert({
      event_id: eventId, filename: 'escape.jpg', path: '../../../escape.jpg',
      type: 'individual', source_origin: 'managed', mime_type: 'image/jpeg',
      size_bytes: 10, uploaded_at: new Date().toISOString(),
    }).returning('id');
    photos.escape = escapeRow[0]?.id ?? escapeRow[0];

    await mkPhoto('foreign', otherEventId, 'rend-other', 'rend-other_0001.jpg',
      await makeImage(300, 200));
    await mkPhoto('archived', archivedEventId, 'rend-archived', 'rend-arch_0001.jpg',
      Buffer.from('x'), {}, false);

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

  describe('?resolution on a single photo', () => {
    it('resizes into the box, keeping the aspect ratio', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/${photos.large}/download?resolution=400x400`);
      expect(res.status).toBe(200);
      const meta = await sharp(res.body).metadata();
      // 1200x800 into a 400x400 box is 400x267, not a squashed 400x400.
      expect(meta.width).toBe(400);
      expect(meta.height).toBe(267);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['content-length']).toBe(String(res.body.length));
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('keeps the original upload name on the rendition', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/${photos.large}/download?resolution=400x400`);
      expect(res.headers['content-disposition']).toContain('filename="big.jpg"');
    });

    it('re-encodes a PNG as a PNG, not a JPEG under a .png name', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/${photos.png}/download?resolution=300x300`);
      expect(res.status).toBe(200);
      const meta = await sharp(res.body).metadata();
      expect(meta.format).toBe('png');
      expect(meta.width).toBe(300);
      expect(res.headers['content-type']).toBe('image/png');
    });

    it('serves the exact stored bytes for `original` and for no parameter', async () => {
      const explicit = await get(`/api/v1/events/${eventId}/photos/${photos.large}/download?resolution=original`);
      const implicit = await get(`/api/v1/events/${eventId}/photos/${photos.large}/download`);
      expect(sha256(explicit.body)).toBe(sha256(bytes.large));
      expect(sha256(implicit.body)).toBe(sha256(bytes.large));
    });

    it('never enlarges: a photo already inside the box is returned untouched', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/${photos.small}/download?resolution=4000x4000`);
      expect(res.status).toBe(200);
      // Byte-identical, so it was not re-encoded at the same dimensions either.
      expect(sha256(res.body)).toBe(sha256(bytes.small));
      // Content-Length survives: the short-circuit puts this back on the
      // streaming path, where the size is known.
      expect(res.headers['content-length']).toBe(String(bytes.small.length));
    });

    it('keeps Content-Length on a HEAD for a type that is never resized', async () => {
      const video = await request(app)
        .head(`/api/v1/events/${eventId}/photos/${photos.video}/download?resolution=400x400`)
        .set('Authorization', `Bearer ${readToken}`);
      expect(video.status).toBe(200);
      // A video is served as stored whatever the box says, so the stored size
      // is exactly what a GET returns — dropping it would be its own lie.
      expect(video.headers['content-length']).toBe(String(bytes.video.length));
    });

    it('records the requested resolution on the audit row', async () => {
      await get(`/api/v1/events/${eventId}/photos/${photos.large}/download?resolution=400x400`);
      const row = await db('activity_logs')
        .where({ activity_type: 'api_photo_downloaded' })
        .orderBy('id', 'desc').first();
      const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
      expect(meta.resolution).toBe('400x400');
    });

    it('never resizes a video', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/${photos.video}/download?resolution=100x100`);
      expect(res.status).toBe(200);
      expect(sha256(res.body)).toBe(sha256(bytes.video));
      expect(res.headers['content-type']).toBe('video/mp4');
    });

    it('never re-encodes a RAW source into a format its name contradicts', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/${photos.dng}/download?resolution=400x400`);
      expect(res.status).toBe(200);
      // Untouched bytes under the RAW content type, rather than a JPEG
      // shipped as image/x-adobe-dng.
      expect(sha256(res.body)).toBe(sha256(bytes.dng));
      expect(res.headers['content-type']).toBe('image/x-adobe-dng');
    });

    // Convergence only: on a LOCAL backend this passes with or without the
    // containment check, because LocalFsStorage refuses the traversing key by
    // itself. The check itself is pinned in v1PhotoDownloadsS3, whose mock has
    // no filesystem to refuse anything.
    it('answers a path-traversing row with 404 on both branches', async () => {
      const rendition = await get(`/api/v1/events/${eventId}/photos/${photos.escape}/download?resolution=400x400`);
      const original = await get(`/api/v1/events/${eventId}/photos/${photos.escape}/download`);
      expect(original.status).toBe(404);
      expect(rendition.status).toBe(404);
    });

    it('rejects a malformed resolution instead of silently serving the original', async () => {
      for (const bad of ['abc', '0x0', '99999999x1', '400x', 'x400', '-1x-1']) {
        const res = await get(`/api/v1/events/${eventId}/photos/${photos.large}/download?resolution=${encodeURIComponent(bad)}`);
        expect([bad, res.status]).toEqual([bad, 400]);
      }
    });

    it('answers a missing file with 404, not a 500, when a rendition was asked for', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/${photos.gone}/download?resolution=400x400`);
      expect(res.status).toBe(404);
      expect(json(res).code).toBe('PHOTO_FILE_MISSING');
    });

    it('omits Content-Length on a HEAD asking for a rendition, and keeps it otherwise', async () => {
      const withBox = await request(app)
        .head(`/api/v1/events/${eventId}/photos/${photos.large}/download?resolution=400x400`)
        .set('Authorization', `Bearer ${readToken}`);
      const withoutBox = await request(app)
        .head(`/api/v1/events/${eventId}/photos/${photos.large}/download`)
        .set('Authorization', `Bearer ${readToken}`);
      expect(withBox.status).toBe(200);
      expect(withBox.headers['content-length']).toBeUndefined();
      expect(withoutBox.headers['content-length']).toBe(String(bytes.large.length));
    });

    it('does not watermark a rendition even with the gallery watermark on', async () => {
      await db('app_settings').insert({
        setting_key: 'general_watermark_settings',
        setting_value: JSON.stringify({ enabled: true, text: 'PROTECTED', position: 'center' }),
        setting_type: 'general',
      }).onConflict('setting_key').merge();
      await db('events').where({ id: eventId }).update({ watermark_downloads: 1 });
      try {
        // The same pipeline resizeToBox runs — keepMetadata() included, since
        // a download keeps the photo's metadata (issue 1649).
        const plain = await sharp(await makeImage(1200, 800))
          .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
          .keepMetadata()
          .jpeg({ quality: 90, mozjpeg: true }).toBuffer();
        const res = await get(`/api/v1/events/${eventId}/photos/${photos.large}/download?resolution=400x400`);
        expect(res.status).toBe(200);
        // Identical to an unwatermarked resize of the same source: the
        // watermark pipeline never ran.
        expect(sha256(res.body)).toBe(sha256(plain));
      } finally {
        await db('events').where({ id: eventId }).update({ watermark_downloads: 0 });
        await db('app_settings').where({ setting_key: 'general_watermark_settings' }).delete();
      }
    });
  });

  describe('?resolution on the ZIP', () => {
    it('names the archive after the box and packs renditions', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/download?resolution=400x400&ids=${photos.large}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('filename="rend-main-400x400.zip"');
      const entries = await readZip(res.body);
      const [name] = Object.keys(entries);
      const meta = await sharp(entries[name]).metadata();
      expect(meta.width).toBe(400);
      expect(meta.height).toBe(267);
    });

    it('still packs byte-identical originals without the parameter', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/download?ids=${photos.large}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('filename="rend-main-originals.zip"');
      const entries = await readZip(res.body);
      expect(sha256(Object.values(entries)[0])).toBe(sha256(bytes.large));
    });

    it('rejects a malformed resolution', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/download?resolution=huge`);
      expect(res.status).toBe(400);
    });
  });

  describe('GET /preview', () => {
    it('serves a JPEG preview that is not a download', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/${photos.large}/preview`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('private, max-age=3600');
      // Not a delivery: no attachment disposition.
      expect(res.headers['content-disposition']).toBeUndefined();
      expect((await sharp(res.body).metadata()).format).toBe('jpeg');
    });

    it('labels an alpha-channel preview as WebP, which is what it writes', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/${photos.alpha}/preview`);
      expect(res.status).toBe(200);
      const meta = await sharp(res.body).metadata();
      // nosniff is set, so the label has to match the bytes or nothing renders.
      expect(res.headers['content-type']).toBe(`image/${meta.format}`);
    });

    it('ignores a ?w it cannot serve instead of refusing the request', async () => {
      // The docs promise this, and the gallery's preview route does it. A 400
      // here would have made the two disagree.
      for (const w of ['abc', '777', '-5', '999999']) {
        const res = await get(`/api/v1/events/${eventId}/photos/${photos.large}/preview?w=${encodeURIComponent(w)}`);
        expect([w, res.status]).toEqual([w, 200]);
        expect([w, res.headers['content-type']]).toEqual([w, 'image/jpeg']);
      }
    });

    it('has no preview for a video, and does not try to make one', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/${photos.video}/preview`);
      expect(res.status).toBe(404);
      expect(json(res).code).toBe('PREVIEW_UNAVAILABLE');
    });

    it('serves a narrower tier for ?w', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/${photos.large}/preview?w=640`);
      expect(res.status).toBe(200);
      expect((await sharp(res.body).metadata()).width).toBeLessThanOrEqual(640);
    });

    it('leaves no download trail in the activity log', async () => {
      const before = Number((await db('activity_logs')
        .whereIn('activity_type', ['api_photo_downloaded', 'api_photos_zip_downloaded'])
        .count('id as count').first())?.count || 0);
      await get(`/api/v1/events/${eventId}/photos/${photos.large}/preview`);
      const after = Number((await db('activity_logs')
        .whereIn('activity_type', ['api_photo_downloaded', 'api_photos_zip_downloaded'])
        .count('id as count').first())?.count || 0);
      expect(after).toBe(before);
    });

    it('answers 503 with Retry-After while the photo is still processing', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/${photos.pending}/preview`);
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('2');
      expect(json(res).code).toBe('PHOTO_PROCESSING');
    });

    it('answers 422 when processing that photo failed', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/${photos.failed}/preview`);
      expect(res.status).toBe(422);
      expect(json(res).code).toBe('PHOTO_PROCESSING_FAILED');
    });

    it('answers a photo of another event with the same 404 as an unknown id', async () => {
      const foreign = await get(`/api/v1/events/${eventId}/photos/${photos.foreign}/preview`);
      const unknown = await get(`/api/v1/events/${eventId}/photos/999999/preview`);
      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
    });

    it('refuses an archived event the same way the downloads do', async () => {
      const res = await get(`/api/v1/events/${archivedEventId}/photos/${photos.archived}/preview`);
      expect(res.status).toBe(409);
      expect(json(res).code).toBe('EVENT_ARCHIVED');
    });

    it('requires the read scope', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/${photos.large}/preview`, noScopeToken);
      expect(res.status).toBe(403);
      expect(json(res).code).toBe('INSUFFICIENT_SCOPE');
    });

    it('refuses an event the token owner does not own', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos/${photos.large}/preview`, otherAdminToken);
      // created_by is set on the fixture, so requireEventOwnership refuses it
      // deterministically. Pinned so the guard cannot silently degrade into a
      // 404 that happens to come from somewhere else.
      expect(res.status).toBe(403);
    });
  });

  describe('photo list', () => {
    it('reports what a client needs to choose how to fetch each row', async () => {
      const res = await get(`/api/v1/events/${eventId}/photos?limit=100`);
      expect(res.status).toBe(200);
      const byId = new Map(json(res).photos.map((p) => [p.id, p]));

      const large = byId.get(photos.large);
      expect(large.size_bytes).toBe(bytes.large.length);
      expect(large.media_type).toBe('image');
      expect(large.mime_type).toBe('image/jpeg');
      expect(large.processing_status).toBe('complete');

      expect(byId.get(photos.video).media_type).toBe('video');
      expect(byId.get(photos.pending).processing_status).toBe('pending');
    });
  });
});
