/**
 * What a gallery's bulk downloads hand out.
 *
 *  - only the photos the gallery list shows: a photo the worker has not
 *    finished, or failed on, is in no archive (Download All streamed or
 *    prebuilt, selected ZIP, resolution job), though its original is stored
 *  - a prebuilt archive is not served while the event has such a photo, and
 *    a photo finishing processing drops it, as it was built without it
 *  - a selection over the cap is refused with a code, never cut down to the
 *    first 500
 */

const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'gallery-download-set-secret';

describe('gallery bulk download set', () => {
  let db; let cleanup; let app; let storage; let jpeg; let zipService;
  let seq = 0;

  const now = () => new Date().toISOString();
  const firstId = (rows) => rows[0]?.id ?? rows[0];

  async function mkEvent(overrides = {}) {
    seq += 1;
    const slug = `download-set-${seq}`;
    const eventId = firstId(await db('events').insert({
      slug, event_type: 'wedding', event_name: `Download set ${seq}`, event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/t`, share_token: crypto.randomBytes(8).toString('hex'),
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, allow_downloads: 1, created_at: now(),
      ...overrides,
    }).returning('id'));
    return db('events').where({ id: eventId }).first();
  }

  // Names no other name contains, so a byte search of the ZIP is exact.
  async function mkPhoto(event, fields = {}) {
    const filename = `photo-${crypto.randomUUID()}.jpg`;
    const key = `events/active/${event.slug}/${filename}`;
    const thumb = `thumbnails/thumb_${filename}`;
    for (const k of [key, thumb]) await storage.put(k, jpeg);
    const photoId = firstId(await db('photos').insert({
      event_id: event.id, filename, original_filename: filename, path: `${event.slug}/${filename}`,
      thumbnail_path: thumb, type: 'individual', media_type: 'image', mime_type: 'image/jpeg',
      size_bytes: jpeg.length, uploaded_at: now(), processing_status: 'complete', visibility: 'visible',
      ...fields,
    }).returning('id'));
    return { id: photoId, filename };
  }

  const guest = (event, method, url, accessLevel) => request(app)[method](`/api/gallery/${event.slug}${url}`)
    .set('Authorization', `Bearer ${jwt.sign(
      { eventId: event.id, eventSlug: event.slug, type: 'gallery', ...(accessLevel ? { accessLevel } : {}) },
      process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' })}`);
  const asBuffer = (req) => req.buffer(true)
    .parse((res, done) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => done(null, Buffer.concat(chunks))); });
  const has = (zip, photo) => zip.includes(photo.filename);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#557799' } }).jpeg().toBuffer();
    storage = require('../../src/services/storage').getStorage();
    zipService = require('../../src/services/downloadZipService');
    jest.spyOn(require('../../src/services/webhookService'), 'fire').mockResolvedValue();

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 180000);

  afterAll(async () => {
    await zipService.stop();
    if (cleanup) await cleanup();
  });

  describe('photos the gallery does not show yet', () => {
    let event; let done; let other; let pending; let processing; let failed;

    beforeAll(async () => {
      event = await mkEvent();
      done = await mkPhoto(event);
      other = await mkPhoto(event);
      pending = await mkPhoto(event, { processing_status: 'pending' });
      processing = await mkPhoto(event, { processing_status: 'processing' });
      failed = await mkPhoto(event, { processing_status: 'failed', processing_error: 'broken' });

      const list = await guest(event, 'get', '/photos');
      expect(list.status).toBe(200);
      expect(list.body.photos.map((p) => p.id).sort((a, b) => a - b)).toEqual([done.id, other.id].sort((a, b) => a - b));
    });

    const unfinished = () => [pending, processing, failed];

    it.each([[undefined], ['client']])('Download All streams only the listed photos (access %s)', async (accessLevel) => {
      const zip = await asBuffer(guest(event, 'get', '/download-all', accessLevel));
      expect(zip.status).toBe(200);
      expect(has(zip.body, done)).toBe(true);
      expect(has(zip.body, other)).toBe(true);
      for (const photo of unfinished()) expect(has(zip.body, photo)).toBe(false);
    });

    it('the prebuilt Download All archive is built without them', async () => {
      const built = await zipService.generateZip(event.id);
      expect(built.success).toBe(true);
      const info = await zipService.getZipInfo(event.id);
      const chunks = [];
      for await (const chunk of await storage.get(info.key)) chunks.push(chunk);
      const zip = Buffer.concat(chunks);
      expect(has(zip, done)).toBe(true);
      for (const photo of unfinished()) expect(has(zip, photo)).toBe(false);
    });

    it('an archive built while one was complete is not served once it is not', async () => {
      // As after an upgrade (archives were built from every photo) or an
      // admin retry that sends a complete photo back to the worker.
      const other = await mkEvent();
      const kept = await mkPhoto(other);
      const redone = await mkPhoto(other);
      expect((await zipService.generateZip(other.id)).success).toBe(true);
      await db('photos').where({ id: redone.id }).update({ processing_status: 'failed' });

      const zip = await asBuffer(guest(other, 'get', '/download-all'));
      expect(zip.status).toBe(200);
      expect(has(zip.body, kept)).toBe(true);
      expect(has(zip.body, redone)).toBe(false);
    });

    it('a selected ZIP leaves them out', async () => {
      const only = await guest(event, 'post', '/download-selected').send({ photo_ids: unfinished().map((p) => p.id) });
      expect(only.status).toBe(404);

      const zip = await asBuffer(guest(event, 'post', '/download-selected')
        .send({ photo_ids: [done.id, ...unfinished().map((p) => p.id)] }));
      expect(zip.status).toBe(200);
      expect(has(zip.body, done)).toBe(true);
      for (const photo of unfinished()) expect(has(zip.body, photo)).toBe(false);
    });

    it.each([['guest'], ['client']])('a resolution job resolves without them (%s)', async (accessLevel) => {
      const jobs = require('../../src/services/downloadJobService');
      const all = await jobs.photoQuery(event.id, null, accessLevel).select('photos.id');
      expect(all.map((r) => r.id).sort((a, b) => a - b)).toEqual([done.id, other.id].sort((a, b) => a - b));
      const picked = await jobs.photoQuery(event.id, unfinished().map((p) => p.id), accessLevel).select('photos.id');
      expect(picked).toHaveLength(0);
    });

    it('a single download of one answers as for an unknown id', async () => {
      expect((await guest(event, 'get', `/download/${done.id}`)).status).toBe(200);
      const unknown = await guest(event, 'get', '/download/987654');
      for (const photo of unfinished()) {
        const res = await guest(event, 'get', `/download/${photo.id}`);
        expect(res.status).toBe(unknown.status);
        expect(res.body).toEqual(unknown.body);
      }
    });

    it('finishing one drops the prebuilt archive that was built without it', async () => {
      expect(await zipService.getZipInfo(event.id)).not.toBeNull();
      const invalidate = jest.spyOn(zipService, 'invalidate');
      try {
        await require('../../src/services/photoProcessor').processPhoto(pending.id);
        expect((await db('photos').where({ id: pending.id }).first()).processing_status).toBe('complete');
        expect(invalidate).toHaveBeenCalledWith(event.id);
      } finally {
        invalidate.mockRestore();
      }
    });
  });

  // Issue 2121: an external photo whose file is gone from the share.
  describe('a photo whose file is gone from the share', () => {
    let event; let kept; let gone;

    beforeAll(async () => {
      event = await mkEvent();
      kept = await mkPhoto(event);
      gone = await mkPhoto(event, { unavailable_reason: 'source_missing' });
    });

    it.each([[undefined], ['client']])('is in no list, count or Download All (access %s)', async (accessLevel) => {
      const list = await guest(event, 'get', '/photos', accessLevel);
      expect(list.status).toBe(200);
      expect(list.body.photos.map((p) => p.id)).toEqual([kept.id]);
      const zip = await asBuffer(guest(event, 'get', '/download-all', accessLevel));
      expect(zip.status).toBe(200);
      expect(has(zip.body, kept)).toBe(true);
      expect(has(zip.body, gone)).toBe(false);
      const jobs = require('../../src/services/downloadJobService');
      const all = await jobs.photoQuery(event.id, null, accessLevel || 'guest').select('photos.id');
      expect(all.map((r) => r.id)).toEqual([kept.id]);
    });

    it('is not in the prebuilt archive, a selected ZIP or a single download', async () => {
      expect((await zipService.generateZip(event.id)).success).toBe(true);
      const info = await zipService.getZipInfo(event.id);
      const chunks = [];
      for await (const chunk of await storage.get(info.key)) chunks.push(chunk);
      expect(has(Buffer.concat(chunks), gone)).toBe(false);

      expect((await guest(event, 'post', '/download-selected').send({ photo_ids: [gone.id] })).status).toBe(404);
      const unknown = await guest(event, 'get', '/download/987654');
      const single = await guest(event, 'get', `/download/${gone.id}`);
      expect(single.status).toBe(unknown.status);
    });
  });

  it('finishing a photo of an event without an archive leaves the cache alone', async () => {
    // A large upload finishes photo after photo: no cleanup and no rebuild
    // armed for each one when there is nothing to drop.
    const event = await mkEvent();
    const photo = await mkPhoto(event, { processing_status: 'pending' });
    expect(await zipService.getZipInfo(event.id)).toBeNull();
    const invalidate = jest.spyOn(zipService, 'invalidate');
    try {
      await require('../../src/services/photoProcessor').processPhoto(photo.id);
      expect((await db('photos').where({ id: photo.id }).first()).processing_status).toBe('complete');
      expect(invalidate).not.toHaveBeenCalled();
    } finally {
      invalidate.mockRestore();
    }
  });

  describe('selection size', () => {
    let event; let photo;
    const ids = (n) => [photo.id, ...Array.from({ length: n - 1 }, (_, i) => 900000 + i)];

    beforeAll(async () => {
      event = await mkEvent({ download_resolution_picker_enabled: 1 });
      photo = await mkPhoto(event);
    });

    it('a selected ZIP over 500 photos is refused, not cut down', async () => {
      const res = await guest(event, 'post', '/download-selected').send({ photo_ids: ids(501) });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'TOO_MANY_PHOTO_IDS', limit: 500 });
    });

    it('a selected ZIP of 500 photos goes through', async () => {
      const zip = await asBuffer(guest(event, 'post', '/download-selected').send({ photo_ids: ids(500) }));
      expect(zip.status).toBe(200);
      expect(has(zip.body, photo)).toBe(true);
    });

    it('repeated ids count once', async () => {
      const zip = await asBuffer(guest(event, 'post', '/download-selected')
        .send({ photo_ids: [...ids(500), ...ids(500)] }));
      expect(zip.status).toBe(200);
    });

    it('a resolution job over 500 photos is refused, not cut down', async () => {
      const res = await guest(event, 'post', '/download-jobs').send({ resolution: 'original', photo_ids: ids(501) });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'TOO_MANY_PHOTO_IDS', limit: 500 });
    });
  });
});
