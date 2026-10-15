/**
 * Guest, chunked and API v1 uploads apply the same content check as the multipart
 * admin upload: bytes must match the declared type and an image must decode.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'photo-duplicates-test-secret';
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

// The ZIP warm-up timer is unrelated to uploads.
jest.mock('../../src/services/downloadZipService', () => ({ invalidate: jest.fn() }));

describe('Upload content validation on guest and chunked uploads', () => {
  let db; let cleanup; let app; let adminToken; let apiToken; let jpeg; let gif; let tiff;
  let counter = 0;
  const idOf = (rows) => rows[0]?.id ?? rows[0];

  async function makeEvent() {
    counter += 1;
    const slug = `dup-test-${counter}`;
    const id = idOf(await db('events').insert({
      slug, event_type: 'wedding', event_name: `Dup Test ${counter}`, event_date: '2026-10-12',
      host_email: 'host@example.com', admin_email: 'admin@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/share`, share_token: `dup-share-${counter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, allow_user_uploads: 1, guest_name_mode: 'off',
      created_at: new Date().toISOString(),
    }).returning('id'));
    return db('events').where({ id }).first();
  }

  const photosOf = (event) => db('photos').where({ event_id: event.id });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    await db('admin_users').where({ id: adminId }).update({ role_id: superRole.id, is_active: 1 });
    adminToken = jwt.sign({ id: adminId, username: 'tester', type: 'admin', loginTime: Date.now() },
      process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' });

    const issued = require('../../src/middleware/apiTokenAuth').generateApiToken();
    await db('api_tokens').insert({ name: 'Content', hashed_token: issued.hashed, scopes: 'write', created_by: adminId });
    apiToken = issued.plaintext;

    const image = (r) => sharp({ create: { width: 32, height: 24, channels: 3, background: { r, g: 120, b: 200 } } }).jpeg().toBuffer();
    jpeg = await image(10);
    gif = await sharp({ create: { width: 32, height: 24, channels: 3, background: 'white' } }).gif().toBuffer();
    tiff = await sharp({ create: { width: 32, height: 24, channels: 3, background: 'white' } }).tiff().toBuffer();

    app = express();
    app.use(express.json());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/v1', require('../../src/routes/v1/events'));
  }, 120000);

  afterAll(async () => {
    require('../../src/services/chunkedUploadService').stop();
    if (cleanup) await cleanup();
  });

  describe('guest upload', () => {
    const guestUpload = (event, bytes, filename = 'guest.jpg', contentType = 'image/jpeg') => request(app)
      .post(`/api/gallery/${event.id}/upload`)
      .set('Authorization', `Bearer ${jwt.sign({ eventId: event.id, eventSlug: event.slug, type: 'gallery' },
        process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' })}`)
      .attach('photos', bytes, { filename, contentType });

    it('refuses text named .jpg and stores no photo', async () => {
      const event = await makeEvent();
      const res = await guestUpload(event, Buffer.from('127.0.0.1 localhost\n'), 'evil.jpg');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/does not match declared type/);
      expect(await photosOf(event)).toHaveLength(0);
    });

    it('refuses a JPEG signature with no decodable image', async () => {
      const event = await makeEvent();
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2000)]);
      const res = await guestUpload(event, bytes, 'broken.jpg');
      expect(res.status).toBe(400);
      expect(await photosOf(event)).toHaveLength(0);
    });

    it('still accepts a valid JPEG', async () => {
      const event = await makeEvent();
      const res = await guestUpload(event, jpeg);
      expect(res.status).toBe(202);
      expect(await photosOf(event)).toHaveLength(1);
    });

    it('accepts a valid GIF when GIF is allowed', async () => {
      const settings = require('../../src/services/uploadSettings');
      await db('app_settings').insert({
        setting_key: 'general_allowed_file_types', setting_value: JSON.stringify('jpg,jpeg,png,webp,gif'), setting_type: 'general',
      }).onConflict('setting_key').merge();
      settings.clearAllowedTypesCache();
      try {
        const event = await makeEvent();
        const res = await guestUpload(event, gif, 'guest.gif', 'image/gif');
        expect(res.status).toBe(202);
        expect(await photosOf(event)).toHaveLength(1);
      } finally {
        await db('app_settings').where({ setting_key: 'general_allowed_file_types' }).del();
        settings.clearAllowedTypesCache();
      }
    });
  });

  describe('chunked admin upload', () => {
    const chunked = async (event, bytes, filename = 'large.jpg') => {
      const base = `/api/admin/photos/${event.id}/chunked-upload`;
      const init = await request(app).post(`${base}/init`).set('Authorization', `Bearer ${adminToken}`)
        .send({ filename, fileSize: bytes.length });
      expect(init.status).toBe(200);
      await request(app).post(`${base}/${init.body.uploadId}/chunk/0`).set('Authorization', `Bearer ${adminToken}`)
        .set('Content-Type', 'application/octet-stream').send(bytes);
      return request(app).post(`${base}/${init.body.uploadId}/complete`).set('Authorization', `Bearer ${adminToken}`).send({});
    };
    const mergeDirs = () => {
      const tempRoot = path.join(require('../../src/config/storage').getStoragePath(), 'temp');
      return fs.existsSync(tempRoot) ? fs.readdirSync(tempRoot).filter((n) => n.startsWith('merge_')) : [];
    };

    it('refuses random bytes named .jpg: no row, no leftover merge dir', async () => {
      const event = await makeEvent();
      const before = mergeDirs();
      const res = await chunked(event, crypto.randomBytes(5000));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/does not match declared type/);
      expect(await photosOf(event)).toHaveLength(0);
      expect(mergeDirs()).toEqual(before);
    });

    it('refuses an 8-byte HTML file named .jpg', async () => {
      const event = await makeEvent();
      const res = await chunked(event, Buffer.from('<html/>\n'));
      expect(res.status).toBe(400);
      expect(await photosOf(event)).toHaveLength(0);
    });

    it('still accepts a valid JPEG', async () => {
      const event = await makeEvent();
      const res = await chunked(event, jpeg);
      expect(res.status).toBe(200);
      expect(await photosOf(event)).toHaveLength(1);
    });
  });

  describe('API v1 upload', () => {
    const v1Upload = (event, bytes, filename = 'api.jpg', contentType = 'image/jpeg') => request(app)
      .post(`/api/v1/events/${event.id}/photos`).set('Authorization', `Bearer ${apiToken}`)
      .attach('photo', bytes, { filename, contentType });
    const filesUnder = (dir) => {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
        e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    };
    const storedFiles = () => filesUnder(require('../../src/config/storage').getStoragePath()).sort();

    it('refuses text named .jpg: no row, no leftover file', async () => {
      const event = await makeEvent();
      const before = storedFiles();
      const res = await v1Upload(event, Buffer.from('127.0.0.1 localhost\n'), 'evil.jpg');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/does not match declared type/);
      expect(await photosOf(event)).toHaveLength(0);
      expect(storedFiles()).toEqual(before);
    });

    it('refuses a JPEG signature with no decodable image', async () => {
      const event = await makeEvent();
      const before = storedFiles();
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2000)]);
      const res = await v1Upload(event, bytes, 'broken.jpg');
      expect(res.status).toBe(400);
      expect(await photosOf(event)).toHaveLength(0);
      expect(storedFiles()).toEqual(before);
    });

    it('still accepts a valid JPEG', async () => {
      const event = await makeEvent();
      const res = await v1Upload(event, jpeg);
      expect(res.status).toBe(201);
      expect(await photosOf(event)).toHaveLength(1);
    });

    // v1 checks no extension, so the declared type picks the decode check.
    it('refuses undecodable JPEG bytes under a non-image filename', async () => {
      const event = await makeEvent();
      const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2000)]);
      const res = await v1Upload(event, bytes, 'broken.bin');
      expect(res.status).toBe(400);
      expect(await photosOf(event)).toHaveLength(0);
    });

    // v1 takes any image/* type; one the signature table does not know must
    // be an image Sharp reads.
    it('accepts a valid TIFF and refuses text named .tiff', async () => {
      const event = await makeEvent();
      const ok = await v1Upload(event, tiff, 'scan.tiff', 'image/tiff');
      expect(ok.status).toBe(201);
      const bad = await v1Upload(event, Buffer.from('not an image at all\n'), 'evil.tiff', 'image/tiff');
      expect(bad.status).toBe(400);
      expect(await photosOf(event)).toHaveLength(1);
    });
  });
});
