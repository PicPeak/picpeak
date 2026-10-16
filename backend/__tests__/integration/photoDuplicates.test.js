/**
 * Duplicate detection by content hash (issue 1733, C2).
 *
 * Pins the contract:
 *  - every upload path stores the SHA-256 of the original on its photo row
 *    (admin multipart, admin chunked, guest, API v1), and a replacement
 *    rewrites it
 *  - the admin upload does not store a file whose bytes the same gallery
 *    already holds when the request carries `detect_duplicates`: it comes back
 *    under `duplicates`, apart from `errors`, naming the existing photo;
 *    without the flag every file is stored, as before the check existed
 *  - the match never crosses galleries
 *  - a guest upload is never refused or told anything
 *  - two uploads of one file at the same moment both land without an error
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

describe('Duplicate detection by content hash (issue 1733)', () => {
  let db; let cleanup; let app; let adminToken; let apiToken;
  let jpegA; let jpegB;
  let counter = 0;
  const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
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

  const adminUpload = (event, files, fields = {}) => {
    let req = request(app).post(`/api/admin/photos/${event.id}/upload`).set('Authorization', `Bearer ${adminToken}`);
    for (const [name, value] of Object.entries(fields)) req = req.field(name, value);
    for (const [filename, bytes] of files) req = req.attach('photos', bytes, { filename, contentType: 'image/jpeg' });
    return req;
  };
  const photosOf = (event) => db('photos').where({ event_id: event.id }).orderBy('id');

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    await db('admin_users').where({ id: adminId }).update({ role_id: superRole.id, is_active: 1 });
    adminToken = jwt.sign({ id: adminId, username: 'tester', type: 'admin', loginTime: Date.now() },
      process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' });
    const issued = require('../../src/middleware/apiTokenAuth').generateApiToken();
    await db('api_tokens').insert({ name: 'Duplicates', hashed_token: issued.hashed, scopes: 'write', created_by: adminId });
    apiToken = issued.plaintext;

    const image = (r) => sharp({ create: { width: 32, height: 24, channels: 3, background: { r, g: 120, b: 200 } } }).jpeg().toBuffer();
    jpegA = await image(10);
    jpegB = await image(200);

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

  it('migration 290 is idempotent and reversible', async () => {
    const migration = require('../../migrations/core/290_photo_content_hash');
    await migration.up(db);
    expect(await db.schema.hasColumn('photos', 'content_sha256')).toBe(true);
    await migration.down(db);
    expect(await db.schema.hasColumn('photos', 'content_sha256')).toBe(false);
    await migration.down(db);
    await migration.up(db);
    expect(await db.schema.hasColumn('photos', 'content_sha256')).toBe(true);
  });

  it('stores the hash of an admin upload', async () => {
    const event = await makeEvent();
    const res = await adminUpload(event, [['a.jpg', jpegA]]);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ count: 1, duplicates: [], duplicateCount: 0 });
    expect((await photosOf(event))[0].content_sha256).toBe(sha(jpegA));
  });

  it('does not store a file the gallery already holds, and names the existing photo', async () => {
    const event = await makeEvent();
    await adminUpload(event, [['first.jpg', jpegA]]);

    const res = await adminUpload(event, [['copy.jpg', jpegA], ['other.jpg', jpegB]], { detect_duplicates: 'true' });
    expect(res.status).toBe(202);
    expect(res.body.count).toBe(1);
    expect(res.body.duplicates).toEqual([{ index: 0, filename: 'copy.jpg', duplicate_of: 'first.jpg' }]);
    // A duplicate is not a failure.
    expect(res.body.errors).toBeUndefined();
    expect(res.body.failureCount).toBe(0);
    expect((await photosOf(event)).map((p) => p.original_filename)).toEqual(['first.jpg', 'other.jpg']);
  });

  it('logs no photos_uploaded entry for a request that stored nothing (issue 2086)', async () => {
    const event = await makeEvent();
    await adminUpload(event, [['first.jpg', jpegA]]);
    const logged = () => db('activity_logs').where({ activity_type: 'photos_uploaded', event_id: event.id });
    expect(await logged()).toHaveLength(1);

    const res = await adminUpload(event, [['copy.jpg', jpegA]], { detect_duplicates: 'true' });
    expect(res.body.count).toBe(0);
    expect(await logged()).toHaveLength(1);
  });

  it('a photo in the trash is not a duplicate: the file is stored again', async () => {
    const event = await makeEvent();
    await adminUpload(event, [['first.jpg', jpegA]]);
    await db('photos').where({ event_id: event.id }).update({
      deleted_at: new Date().toISOString(), purge_after: new Date(Date.now() + 86400000).toISOString(),
    });

    const res = await adminUpload(event, [['again.jpg', jpegA]], { detect_duplicates: 'true' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ count: 1, duplicates: [], duplicateCount: 0 });
    expect((await photosOf(event)).map((p) => p.original_filename)).toEqual(['first.jpg', 'again.jpg']);

    // Restored, the older photo is the one a third upload is told about.
    await db('photos').where({ event_id: event.id }).update({ deleted_at: null, purge_after: null });
    const third = await adminUpload(event, [['third.jpg', jpegA]], { detect_duplicates: 'true' });
    expect(third.body.duplicates).toEqual([{ index: 0, filename: 'third.jpg', duplicate_of: 'first.jpg' }]);
  });

  it('catches the same file twice in one request', async () => {
    const event = await makeEvent();
    const res = await adminUpload(event, [['one.jpg', jpegA], ['two.jpg', jpegA]], { detect_duplicates: 'true' });
    expect(res.body.count).toBe(1);
    expect(res.body.duplicates).toEqual([{ index: 1, filename: 'two.jpg', duplicate_of: 'one.jpg' }]);
  });

  it('tells two files of one name apart by their place in the request', async () => {
    const event = await makeEvent();
    await adminUpload(event, [['first.jpg', jpegA]]);
    const res = await adminUpload(event, [['same.jpg', jpegB], ['same.jpg', jpegA]], { detect_duplicates: 'true' });
    expect(res.body.count).toBe(1);
    expect(res.body.duplicates).toEqual([{ index: 1, filename: 'same.jpg', duplicate_of: 'first.jpg' }]);
  });

  it('counts the place in the request across a file the validation dropped', async () => {
    const event = await makeEvent();
    await adminUpload(event, [['first.jpg', jpegA]]);
    const res = await adminUpload(event, [['broken.jpg', jpegB.subarray(0, 40)], ['copy.jpg', jpegA]], { detect_duplicates: 'true' });
    expect(res.body.errors).toMatchObject([{ filename: 'broken.jpg' }]);
    expect(res.body.duplicates).toEqual([{ index: 1, filename: 'copy.jpg', duplicate_of: 'first.jpg' }]);
  });

  describe('photo cap', () => {
    const capped = async (cap) => {
      const event = await makeEvent();
      await db('events').where({ id: event.id }).update({ photo_cap: cap });
      return event;
    };

    it('does not count a duplicate against the cap', async () => {
      const event = await capped(2);
      await adminUpload(event, [['first.jpg', jpegA]]);
      const res = await adminUpload(event, [['copy.jpg', jpegA], ['other.jpg', jpegB]], { detect_duplicates: 'true' });
      expect(res.status).toBe(202);
      expect(res.body.count).toBe(1);
      expect(res.body.duplicates).toEqual([{ index: 0, filename: 'copy.jpg', duplicate_of: 'first.jpg' }]);
      expect(await photosOf(event)).toHaveLength(2);
    });

    it('counts a file sent twice in one request once', async () => {
      const event = await capped(1);
      const res = await adminUpload(event, [['one.jpg', jpegA], ['two.jpg', jpegA]], { detect_duplicates: 'true' });
      expect(res.status).toBe(202);
      expect(res.body.count).toBe(1);
      expect(res.body.duplicates).toEqual([{ index: 1, filename: 'two.jpg', duplicate_of: 'one.jpg' }]);
    });

    it('reports a duplicate-only upload at the cap instead of refusing it', async () => {
      const event = await capped(1);
      await adminUpload(event, [['first.jpg', jpegA]]);
      const res = await adminUpload(event, [['copy.jpg', jpegA]], { detect_duplicates: 'true' });
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ count: 0, duplicateCount: 1 });
      expect(await photosOf(event)).toHaveLength(1);
    });

    it('counts a file with the bytes a replacement of the same request brings in as a duplicate', async () => {
      const event = await capped(1);
      await adminUpload(event, [['first.jpg', jpegA]]);
      const res = await adminUpload(event, [['first.jpg', jpegB], ['copy.jpg', jpegB]],
        { detect_duplicates: 'true', replace_by_name: 'true' });
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ count: 0, replacedCount: 1 });
      expect(res.body.duplicates).toEqual([{ index: 1, filename: 'copy.jpg', duplicate_of: 'first.jpg' }]);
      expect(await photosOf(event)).toHaveLength(1);
    });

    it('still refuses a batch whose new files do not fit', async () => {
      const event = await capped(1);
      await adminUpload(event, [['first.jpg', jpegA]]);
      const res = await adminUpload(event, [['copy.jpg', jpegA], ['other.jpg', jpegB]], { detect_duplicates: 'true' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Photo cap exceeded/);
      expect(res.body.error).toMatch(/upload 1 more/);
      expect(await photosOf(event)).toHaveLength(1);
    });

    it('refuses as before when the request does not ask for detection', async () => {
      const event = await capped(2);
      await adminUpload(event, [['first.jpg', jpegA]]);
      const res = await adminUpload(event, [['copy.jpg', jpegA], ['other.jpg', jpegB]]);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/upload 2 more/);
      expect(await photosOf(event)).toHaveLength(1);
    });
  });

  it('stores every file when the request does not ask for detection', async () => {
    const event = await makeEvent();
    await adminUpload(event, [['first.jpg', jpegA]]);
    const res = await adminUpload(event, [['copy.jpg', jpegA]]);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ count: 1, duplicates: [], duplicateCount: 0 });
    const rows = await photosOf(event);
    expect(rows).toHaveLength(2);
    expect(rows.map((p) => p.content_sha256)).toEqual([sha(jpegA), sha(jpegA)]);
  });

  it('does not report the same bytes in another gallery', async () => {
    const one = await makeEvent();
    const two = await makeEvent();
    await adminUpload(one, [['first.jpg', jpegA]]);
    const res = await adminUpload(two, [['first.jpg', jpegA]], { detect_duplicates: 'true' });
    expect(res.body).toMatchObject({ count: 1, duplicates: [] });
    expect(await photosOf(two)).toHaveLength(1);
  });

  it('never matches a photo without a hash', async () => {
    const event = await makeEvent();
    await db('photos').insert({
      event_id: event.id, filename: 'watched.jpg', path: `${event.slug}/watched.jpg`, type: 'individual',
      size_bytes: jpegA.length, uploaded_at: new Date().toISOString(),
    });
    const res = await adminUpload(event, [['a.jpg', jpegA]], { detect_duplicates: 'true' });
    expect(res.body).toMatchObject({ count: 1, duplicates: [] });
  });

  it('two uploads of one file at the same moment both answer without an error', async () => {
    const event = await makeEvent();
    const [a, b] = await Promise.all([
      adminUpload(event, [['a.jpg', jpegA]], { detect_duplicates: 'true' }),
      adminUpload(event, [['b.jpg', jpegA]], { detect_duplicates: 'true' }),
    ]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(a.body.errors).toBeUndefined();
    expect(b.body.errors).toBeUndefined();
    // One of them may have seen the other's row; neither is lost.
    expect(a.body.count + b.body.count + a.body.duplicateCount + b.body.duplicateCount).toBe(2);
    expect((await photosOf(event)).length).toBe(a.body.count + b.body.count);
  });

  describe('guest upload', () => {
    const guestUpload = (event, bytes) => request(app)
      .post(`/api/gallery/${event.id}/upload`)
      .set('Authorization', `Bearer ${jwt.sign({ eventId: event.id, eventSlug: event.slug, type: 'gallery' },
        process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' })}`)
      .attach('photos', bytes, { filename: 'guest.jpg', contentType: 'image/jpeg' });

    it('is hashed, and never refused or told about a duplicate', async () => {
      const event = await makeEvent();
      await adminUpload(event, [['first.jpg', jpegA]]);

      const res = await guestUpload(event, jpegA);
      expect(res.status).toBe(202);
      expect(res.body.count).toBe(1);
      expect(res.body.errors).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toMatch(/duplicate/i);

      const rows = await photosOf(event);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ uploaded_by: 'guest', content_sha256: sha(jpegA) });
    });

    it('is what a later admin upload of the same file is a duplicate of', async () => {
      const event = await makeEvent();
      await guestUpload(event, jpegB);
      const res = await adminUpload(event, [['mine.jpg', jpegB]], { detect_duplicates: 'true' });
      expect(res.body.duplicates).toEqual([{ index: 0, filename: 'mine.jpg', duplicate_of: 'guest.jpg' }]);
    });
  });

  describe('chunked upload', () => {
    const chunked = async (event, bytes, body = {}) => {
      const base = `/api/admin/photos/${event.id}/chunked-upload`;
      const init = await request(app).post(`${base}/init`).set('Authorization', `Bearer ${adminToken}`)
        .send({ filename: 'large.jpg', fileSize: bytes.length });
      expect(init.status).toBe(200);
      await request(app).post(`${base}/${init.body.uploadId}/chunk/0`).set('Authorization', `Bearer ${adminToken}`)
        .set('Content-Type', 'application/octet-stream').send(bytes);
      return request(app).post(`${base}/${init.body.uploadId}/complete`).set('Authorization', `Bearer ${adminToken}`).send(body);
    };

    it('stores the hash, refuses a duplicate with its own code only when asked to detect', async () => {
      const event = await makeEvent();
      const first = await chunked(event, jpegA);
      expect(first.status).toBe(200);
      expect((await photosOf(event))[0].content_sha256).toBe(sha(jpegA));

      const again = await chunked(event, jpegA, { detect_duplicates: true });
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ code: 'DUPLICATE_PHOTO', duplicate_of: 'large.jpg' });
      expect(await photosOf(event)).toHaveLength(1);
      // The refused upload holds no admission once the route has settled it.
      for (let n = 0; n < 100 && await db('public_upload_requests').where({ active: 1 }).first(); n++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await db('public_upload_requests').where({ active: 1 })).toHaveLength(0);

      const anyway = await chunked(event, jpegA);
      expect(anyway.status).toBe(200);
      expect(await photosOf(event)).toHaveLength(2);
    });

    it('at the cap a duplicate is still reported; any other file is refused, as without detection', async () => {
      const event = await makeEvent();
      await chunked(event, jpegA);
      await db('events').where({ id: event.id }).update({ photo_cap: 1 });

      const duplicate = await chunked(event, jpegA, { detect_duplicates: true });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body).toMatchObject({ code: 'DUPLICATE_PHOTO', duplicate_of: 'large.jpg' });

      const other = await chunked(event, jpegB, { detect_duplicates: true });
      expect(other.status).toBe(400);
      expect(other.body.error).toMatch(/Photo cap exceeded/);

      const plain = await chunked(event, jpegA);
      expect(plain.status).toBe(400);
      expect(plain.body.error).toMatch(/Photo cap exceeded/);

      expect(await photosOf(event)).toHaveLength(1);
      for (let n = 0; n < 100 && await db('public_upload_requests').where({ active: 1 }).first(); n++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await db('public_upload_requests').where({ active: 1 })).toHaveLength(0);
    });
  });

  it('the API v1 upload stores the hash', async () => {
    const event = await makeEvent();
    const res = await request(app).post(`/api/v1/events/${event.id}/photos`).set('Authorization', `Bearer ${apiToken}`)
      .attach('photo', jpegB, { filename: 'api.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(201);
    expect((await photosOf(event))[0].content_sha256).toBe(sha(jpegB));
  });

  // Issue 2072: a photo uploaded before the utf8 fix holds its name as
  // latin1-decoded mojibake; re-uploading the proper name has to replace it.
  it('replace_by_name replaces a legacy mojibake row with a re-upload of the proper name', async () => {
    const event = await makeEvent();
    await adminUpload(event, [['legacy.jpg', jpegA]]);
    const [legacy] = await photosOf(event);
    await db('photos').where({ id: legacy.id })
      .update({ original_filename: 'Ã¼mlÃ¤ut.jpg', source_filename: 'Ã¼mlÃ¤ut.jpg' });

    const res = await adminUpload(event, [['ümläut.jpg', jpegB]], { replace_by_name: 'true' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ count: 0, replacedCount: 1 });
    const rows = await photosOf(event);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(legacy.id);
    expect(rows[0].content_sha256).toBe(sha(jpegB));
    expect(rows[0].original_filename).toBe('ümläut.jpg');
    // The mangled camera name is repaired too, only because the match came
    // through the legacy form.
    expect(rows[0].source_filename).toBe('ümläut.jpg');
  });

  it('a legacy-name match keeps a different camera name in source_filename', async () => {
    const event = await makeEvent();
    await adminUpload(event, [['legacy.jpg', jpegA]]);
    const [legacy] = await photosOf(event);
    await db('photos').where({ id: legacy.id })
      .update({ original_filename: 'Ã¼mlÃ¤ut.jpg', source_filename: 'IMG_0042.CR2' });
    const res = await adminUpload(event, [['ümläut.jpg', jpegB]], { replace_by_name: 'true' });
    expect(res.body).toMatchObject({ count: 0, replacedCount: 1 });
    expect((await photosOf(event))[0].source_filename).toBe('IMG_0042.CR2');
  });

  it('a normal-name match leaves source_filename untouched (migration 193)', async () => {
    const event = await makeEvent();
    await adminUpload(event, [['ümläut.jpg', jpegA]]);
    const [row] = await photosOf(event);
    await db('photos').where({ id: row.id }).update({ source_filename: 'Ã¼mlÃ¤ut.jpg' });
    const res = await adminUpload(event, [['ümläut.jpg', jpegB]], { replace_by_name: 'true' });
    expect(res.body).toMatchObject({ count: 0, replacedCount: 1 });
    expect((await photosOf(event))[0].source_filename).toBe('Ã¼mlÃ¤ut.jpg');
  });

  it('a replacement rewrites the hash', async () => {
    const { replacePhoto } = require('../../src/services/photoReplacementService');
    const event = await makeEvent();
    await adminUpload(event, [['first.jpg', jpegA]]);
    const [existing] = await photosOf(event);
    const temp = path.join(process.env.STORAGE_PATH, `dup-replace-${existing.id}.jpg`);
    await fs.promises.writeFile(temp, jpegB);
    const result = await replacePhoto(existing, temp, { originalFilename: 'first.jpg', mimeType: 'image/jpeg', event });
    expect(result.success).toBe(true);
    expect((await photosOf(event))[0].content_sha256).toBe(sha(jpegB));

    // The old bytes are no longer in the gallery, the new ones are.
    const res = await adminUpload(event, [['old.jpg', jpegA], ['new.jpg', jpegB]], { detect_duplicates: 'true' });
    expect(res.body.count).toBe(1);
    expect(res.body.duplicates).toEqual([{ index: 1, filename: 'new.jpg', duplicate_of: 'first.jpg' }]);
  });
});
