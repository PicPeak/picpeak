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

    it('takes a .HEIC sent as a generic type and stores its real type', async () => {
      const heic = fs.readFileSync(path.join(__dirname, '../fixtures/hevc-display-p3.heic'));
      const event = await makeEvent();
      // CI's ffmpeg is too old to demux HEIC, as in imageProcessorHeif.test.js.
      const decoded = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c33' } }).jpeg().toBuffer();
      const ffmpeg = jest.spyOn(require('../../src/services/mediaProcessService'), 'run').mockImplementation(async (_command, args) => {
        fs.writeFileSync(args[args.length - 1], decoded);
        return { stdout: Buffer.alloc(0) };
      });
      const res = await v1Upload(event, heic, 'IMG_3974.HEIC', 'application/octet-stream');
      ffmpeg.mockRestore();
      expect(res.status).toBe(201);
      const [photo] = await photosOf(event);
      expect(photo.mime_type).toBe('image/heic');
      // A HEVC HEIC only decodes through ffmpeg: this route writes a finished row.
      expect(photo.thumbnail_path).toBeTruthy();
    });

    // Issue 2404: an untyped file is named by its extension, and its bytes
    // still have to match that type.
    it('takes a generic type on a known extension and checks the bytes', async () => {
      const event = await makeEvent();
      const res = await v1Upload(event, jpeg, 'api.jpg', 'application/octet-stream');
      expect(res.status).toBe(201);
      const [photo] = await photosOf(event);
      expect(photo.mime_type).toBe('image/jpeg');

      // MOV allowed, so the refusal comes from the bytes, not the type list.
      const settings = require('../../src/services/uploadSettings');
      await db('app_settings').insert({
        setting_key: 'general_allowed_file_types', setting_value: JSON.stringify('jpg,jpeg,png,webp,mov'), setting_type: 'general',
      }).onConflict('setting_key').merge();
      settings.clearAllowedTypesCache();
      try {
        const other = await makeEvent();
        const renamed = await v1Upload(other, jpeg, 'clip.mov', 'application/octet-stream');
        expect(renamed.status).toBe(400);
        expect(renamed.body.error).toBe('Invalid video file content.');
        expect(await photosOf(other)).toHaveLength(0);
      } finally {
        await db('app_settings').where({ setting_key: 'general_allowed_file_types' }).del();
        settings.clearAllowedTypesCache();
      }
    });

    it('still refuses a generic type on an unknown extension', async () => {
      const event = await makeEvent();
      const res = await v1Upload(event, jpeg, 'api.bin', 'application/octet-stream');
      expect(res.status).toBe(400);
      expect(await photosOf(event)).toHaveLength(0);
    });

    it('refuses a bare container header under a .heic name', async () => {
      const event = await makeEvent();
      const res = await v1Upload(event, Buffer.from('\0\0\0\x18ftypisom-not-an-image-at-all'), 'empty.heic', 'image/jpeg');
      expect(res.status).toBe(400);
      expect(await photosOf(event)).toHaveLength(0);
    });

    it('refuses JPEG bytes under a .heic name', async () => {
      const event = await makeEvent();
      const res = await v1Upload(event, jpeg, 'renamed.heic', 'image/jpeg');
      expect(res.status).toBe(400);
      expect(await photosOf(event)).toHaveLength(0);
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

  // A valid photo over the server's image limits is refused with the limit
  // named (issue 2395), not as an empty request, a corrupt file or a 500.
  describe('image limit refusals', () => {
    let large; let largeTiff;
    const limit = { code: 'IMAGE_RESOURCE_LIMIT', imageLimit: 'pixels', imageMax: 1 };
    const adminUpload = (event, files) => {
      let req = request(app).post(`/api/admin/photos/${event.id}/upload`).set('Authorization', `Bearer ${adminToken}`);
      for (const [bytes, filename] of files) req = req.attach('photos', bytes, { filename, contentType: 'image/jpeg' });
      return req;
    };
    const chunked = async (event, bytes, filename) => {
      const base = `/api/admin/photos/${event.id}/chunked-upload`;
      const init = await request(app).post(`${base}/init`).set('Authorization', `Bearer ${adminToken}`)
        .send({ filename, fileSize: bytes.length });
      expect(init.status).toBe(200);
      await request(app).post(`${base}/${init.body.uploadId}/chunk/0`).set('Authorization', `Bearer ${adminToken}`)
        .set('Content-Type', 'application/octet-stream').send(bytes);
      return request(app).post(`${base}/${init.body.uploadId}/complete`).set('Authorization', `Bearer ${adminToken}`).send({});
    };
    const v1Upload = (event, bytes, filename, contentType) => request(app)
      .post(`/api/v1/events/${event.id}/photos`).set('Authorization', `Bearer ${apiToken}`)
      .attach('photo', bytes, { filename, contentType });
    const filesUnder = (dir) => {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
        e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    };
    const storedFiles = () => filesUnder(require('../../src/config/storage').getStoragePath()).sort();

    beforeAll(async () => {
      const create = { create: { width: 2000, height: 1000, channels: 3, background: 'white' } };
      large = await sharp(create).jpeg().toBuffer();
      largeTiff = await sharp(create).tiff().toBuffer();
    });
    beforeEach(() => { process.env.IMAGE_MAX_PIXELS = '1000000'; });
    afterEach(() => { delete process.env.IMAGE_MAX_PIXELS; });

    it('multipart: answers 422 with each refusal when every file is over a limit', async () => {
      const event = await makeEvent();
      const before = storedFiles();
      const res = await adminUpload(event, [[large, 'big-1.jpg'], [large, 'big-2.jpg']]);
      expect(res.status).toBe(422);
      expect(res.body.error).not.toMatch(/No files uploaded/);
      expect(res.body.errors).toHaveLength(2);
      expect(res.body.errors[0]).toMatchObject({ filename: 'big-1.jpg', ...limit });
      expect(res.body.errors[0].error).toMatch(/^Image has 2 megapixels.*up to 1 megapixels \(IMAGE_MAX_PIXELS\)/);
      expect(res.body.errors[1]).toMatchObject({ filename: 'big-2.jpg', ...limit });
      expect(await photosOf(event)).toHaveLength(0);
      expect(storedFiles()).toEqual(before);
    });

    it('multipart: answers 400 when the refusals are not all limits', async () => {
      const event = await makeEvent();
      const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2000)]);
      const res = await adminUpload(event, [[large, 'big.jpg'], [broken, 'broken.jpg']]);
      expect(res.status).toBe(400);
      expect(res.body.errors).toHaveLength(2);
      expect(res.body.errors[0]).toMatchObject({ filename: 'big.jpg', ...limit });
      expect(res.body.errors[1]).toMatchObject({ filename: 'broken.jpg' });
      expect(res.body.errors[1].code).toBeUndefined();
      expect(await photosOf(event)).toHaveLength(0);
    });

    it('multipart: a request with no file still answers "No files uploaded"', async () => {
      const event = await makeEvent();
      const res = await request(app).post(`/api/admin/photos/${event.id}/upload`).set('Authorization', `Bearer ${adminToken}`)
        .field('category_id', '');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No files uploaded');
    });

    it('chunked: answers 422 with the limit, no row, no leftover merge dir', async () => {
      const event = await makeEvent();
      const tempRoot = path.join(require('../../src/config/storage').getStoragePath(), 'temp');
      const mergeDirs = () => (fs.existsSync(tempRoot) ? fs.readdirSync(tempRoot).filter((n) => n.startsWith('merge_')) : []);
      const before = mergeDirs();
      const res = await chunked(event, large, 'big.jpg');
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject(limit);
      expect(res.body.error).toMatch(/^Image has 2 megapixels.*up to 1 megapixels/);
      expect(await photosOf(event)).toHaveLength(0);
      expect(mergeDirs()).toEqual(before);
    });

    it.each([['decode check', 'big.jpg', 'image/jpeg'], ['image read of an unlisted type', 'big.tiff', 'image/tiff']])(
      'v1: answers 422 with the limit from the %s, no row, no leftover file', async (_path, filename, contentType) => {
        const event = await makeEvent();
        const before = storedFiles();
        const res = await v1Upload(event, filename.endsWith('.tiff') ? largeTiff : large, filename, contentType);
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject(limit);
        expect(res.body.error).toMatch(/^Image has 2 megapixels.*up to 1 megapixels/);
        expect(await photosOf(event)).toHaveLength(0);
        expect(storedFiles()).toEqual(before);
      });
  });

  // The HEIF signature is only a container's `ftyp`, so a HEIF name has to read
  // as an image on every upload route, as on v1 above.
  describe('HEIF names on admin and guest uploads', () => {
    const bareFtyp = Buffer.from('\0\0\0\x18ftypisom-not-an-image-at-all');
    let heic;
    // CI's ffmpeg is too old to demux HEIC, as in imageProcessorHeif.test.js.
    const fakeHevcDecode = async () => {
      const decoded = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c33' } }).jpeg().toBuffer();
      return jest.spyOn(require('../../src/services/mediaProcessService'), 'run').mockImplementation(async (_command, args) => {
        fs.writeFileSync(args[args.length - 1], decoded);
        return { stdout: Buffer.alloc(0) };
      });
    };
    const adminUpload = (event, bytes, filename, fields = {}) => {
      let req = request(app).post(`/api/admin/photos/${event.id}/upload`).set('Authorization', `Bearer ${adminToken}`);
      for (const [name, value] of Object.entries(fields)) req = req.field(name, value);
      return req.attach('photos', bytes, { filename, contentType: 'application/octet-stream' });
    };
    const chunked = async (event, bytes, filename) => {
      const base = `/api/admin/photos/${event.id}/chunked-upload`;
      const init = await request(app).post(`${base}/init`).set('Authorization', `Bearer ${adminToken}`)
        .send({ filename, fileSize: bytes.length });
      expect(init.status).toBe(200);
      await request(app).post(`${base}/${init.body.uploadId}/chunk/0`).set('Authorization', `Bearer ${adminToken}`)
        .set('Content-Type', 'application/octet-stream').send(bytes);
      return request(app).post(`${base}/${init.body.uploadId}/complete`).set('Authorization', `Bearer ${adminToken}`).send({});
    };
    const guestUpload = (event, bytes, filename) => request(app)
      .post(`/api/gallery/${event.id}/upload`)
      .set('Authorization', `Bearer ${jwt.sign({ eventId: event.id, eventSlug: event.slug, type: 'gallery' },
        process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' })}`)
      .attach('photos', bytes, { filename, contentType: 'application/octet-stream' });

    beforeAll(async () => {
      heic = fs.readFileSync(path.join(__dirname, '../fixtures/hevc-display-p3.heic'));
      await db('app_settings').insert({
        setting_key: 'general_allowed_file_types', setting_value: JSON.stringify('jpg,jpeg,png,webp,heic,heif'), setting_type: 'general',
      }).onConflict('setting_key').merge();
      require('../../src/services/uploadSettings').clearAllowedTypesCache();
    });

    afterAll(async () => {
      await db('app_settings').where({ setting_key: 'general_allowed_file_types' }).del();
      require('../../src/services/uploadSettings').clearAllowedTypesCache();
    });

    it('multipart: refuses a bare container header under a .heic name', async () => {
      const event = await makeEvent();
      const res = await adminUpload(event, bareFtyp, 'empty.heic');
      expect(res.status).toBe(400);
      expect(await photosOf(event)).toHaveLength(0);
    });

    it('multipart: refuses it under a .HEIF name too', async () => {
      const event = await makeEvent();
      const res = await adminUpload(event, bareFtyp, 'EMPTY.HEIF');
      expect(res.status).toBe(400);
      expect(await photosOf(event)).toHaveLength(0);
    });

    it('multipart: accepts a real HEIC', async () => {
      const event = await makeEvent();
      const ffmpeg = await fakeHevcDecode();
      try {
        const res = await adminUpload(event, heic, 'IMG_3974.HEIC');
        expect(res.status).toBe(202);
      } finally { ffmpeg.mockRestore(); }
      const [photo] = await photosOf(event);
      expect(photo.mime_type).toBe('image/heic');
    });

    it('multipart replace_by_name: does not replace a real HEIC with a bare header', async () => {
      const event = await makeEvent();
      const ffmpeg = await fakeHevcDecode();
      try {
        expect((await adminUpload(event, heic, 'IMG_4000.heic')).status).toBe(202);
      } finally { ffmpeg.mockRestore(); }
      const [before] = await photosOf(event);
      const res = await adminUpload(event, bareFtyp, 'IMG_4000.heic', { replace_by_name: 'true' });
      expect(res.status).toBe(400);
      expect(res.body.replaced || []).toHaveLength(0);
      const rows = await photosOf(event);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: before.id, path: before.path, size_bytes: before.size_bytes });
    });

    it('chunked: refuses a bare container header under a .heic name', async () => {
      const event = await makeEvent();
      const res = await chunked(event, bareFtyp, 'large.heic');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid image file: large\.heic/);
      expect(await photosOf(event)).toHaveLength(0);
    });

    it('chunked: accepts a real HEIC', async () => {
      const event = await makeEvent();
      const ffmpeg = await fakeHevcDecode();
      try {
        const res = await chunked(event, heic, 'IMG_3975.heic');
        expect(res.status).toBe(200);
      } finally { ffmpeg.mockRestore(); }
      expect(await photosOf(event)).toHaveLength(1);
    });

    it('guest: refuses a bare container header under a .heic name', async () => {
      const event = await makeEvent();
      const res = await guestUpload(event, bareFtyp, 'guest.heic');
      expect(res.status).toBe(400);
      expect(await photosOf(event)).toHaveLength(0);
    });

    it('guest: accepts a real HEIC', async () => {
      const event = await makeEvent();
      const ffmpeg = await fakeHevcDecode();
      try {
        const res = await guestUpload(event, heic, 'IMG_3976.HEIC');
        expect(res.status).toBe(202);
      } finally { ffmpeg.mockRestore(); }
      expect(await photosOf(event)).toHaveLength(1);
    });
  });
});
