/**
 * Per-event download limit (issue 1560).
 *
 * Pins the contract:
 *  - the quota counts distinct photos; downloading a granted photo again,
 *    single or in a zip, is free
 *  - every refusal is all-or-nothing and happens before any byte: a zip that
 *    does not fit records no grants at all
 *  - two parallel requests at 1 remaining cannot both pass
 *  - admin previews never consume the quota
 *  - while a limit applies, the lightbox original of a non-granted image is
 *    withheld (redirect to the preview tier), and the payload points at the
 *    preview instead
 *  - deleting a photo frees its slot; the admin reset clears every grant
 *  - an unlimited gallery records nothing
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'download-limit-test-secret';

describe('Download limit (issue 1560)', () => {
  let db;
  let cleanup;
  let app;
  let adminToken;
  let jpeg;
  let quota;
  let slugCounter = 0;

  const galleryToken = (event, extra = {}) => jwt.sign(
    { eventId: event.id, eventSlug: event.slug, type: 'gallery', ...extra },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  async function makeEvent({ limit = null, photos = 4 } = {}) {
    slugCounter += 1;
    const slug = `limit-test-${slugCounter}`;
    const inserted = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Limit Test ${slugCounter}`,
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      share_token: `limit-share-${slugCounter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      allow_downloads: 1,
      download_limit: limit,
      created_at: new Date().toISOString(),
    }).returning('id');
    const id = inserted[0]?.id ?? inserted[0];

    const dir = path.join(process.env.STORAGE_PATH, 'events', 'active', slug);
    await fs.promises.mkdir(dir, { recursive: true });
    const photoIds = [];
    for (let i = 0; i < photos; i += 1) {
      const filename = `photo-${i}.jpg`;
      await fs.promises.writeFile(path.join(dir, filename), jpeg);
      const p = await db('photos').insert({
        event_id: id,
        filename,
        path: `${slug}/${filename}`,
        type: 'individual',
        media_type: 'image',
        mime_type: 'image/jpeg',
        size_bytes: jpeg.length,
        uploaded_at: new Date(Date.now() - i * 1000).toISOString(),
      }).returning('id');
      photoIds.push(p[0]?.id ?? p[0]);
    }
    const event = await db('events').where({ id }).first();
    return { event, photoIds, token: galleryToken(event) };
  }

  const grantCount = async (eventId) => {
    const row = await db('event_download_grants').where({ event_id: eventId }).count('id as count').first();
    return Number(row.count);
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    quota = require('../../src/services/downloadQuota');

    jpeg = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 80, b: 40 } },
    }).jpeg().toBuffer();

    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const [rootId] = await db('admin_users').insert({
      username: 'limit-admin',
      email: 'limit-admin@example.com',
      password_hash: await bcrypt.hash('LimitAdmin123', 4),
      role_id: superRole.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id').then((r) => [r[0]?.id || r[0]]);
    adminToken = jwt.sign(
      { id: rootId, username: 'limit-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' }
    );

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  describe('single downloads', () => {
    it('counts distinct photos and refuses the one past the limit', async () => {
      const { event, photoIds, token } = await makeEvent({ limit: 2 });
      const dl = (id) => request(app)
        .get(`/api/gallery/${event.slug}/download/${id}`)
        .set('Authorization', `Bearer ${token}`);

      expect((await dl(photoIds[0])).status).toBe(200);
      // The same photo again is free.
      expect((await dl(photoIds[0])).status).toBe(200);
      expect(await grantCount(event.id)).toBe(1);
      expect((await dl(photoIds[1])).status).toBe(200);

      const refused = await dl(photoIds[2]);
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        code: 'DOWNLOAD_LIMIT_REACHED', limit: 2, used: 2, remaining: 0,
      });
      expect(await grantCount(event.id)).toBe(2);

      // Granted photos stay downloadable at the limit.
      expect((await dl(photoIds[1])).status).toBe(200);
    });

    it('does not charge a photo whose file is missing', async () => {
      const { event, photoIds, token } = await makeEvent({ limit: 1 });
      await db('photos').where({ id: photoIds[0] }).update({ path: `${event.slug}/missing.jpg` });
      const res = await request(app)
        .get(`/api/gallery/${event.slug}/download/${photoIds[0]}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
      expect(await grantCount(event.id)).toBe(0);
      // The slot is still there for a photo that exists.
      await request(app)
        .get(`/api/gallery/${event.slug}/download/${photoIds[1]}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });

    it('records nothing for an unlimited gallery', async () => {
      const { event, photoIds, token } = await makeEvent({ limit: null });
      const res = await request(app)
        .get(`/api/gallery/${event.slug}/download/${photoIds[0]}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(await grantCount(event.id)).toBe(0);
    });

    it('never charges an admin preview', async () => {
      const { event, photoIds } = await makeEvent({ limit: 1 });
      for (const id of photoIds.slice(0, 3)) {
        const res = await request(app)
          .get(`/api/gallery/${event.slug}/download/${id}?admin_preview=1`)
          .set('Cookie', [`admin_token=${adminToken}`]);
        expect(res.status).toBe(200);
      }
      expect(await grantCount(event.id)).toBe(0);
    });
  });

  describe('zip downloads', () => {
    it('refuses a selection that does not fit, whole, and grants none of it', async () => {
      const { event, photoIds, token } = await makeEvent({ limit: 3, photos: 5 });
      await request(app)
        .get(`/api/gallery/${event.slug}/download/${photoIds[0]}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Three new photos with two remaining: refused, nothing recorded.
      const refused = await request(app)
        .post(`/api/gallery/${event.slug}/download-selected`)
        .set('Authorization', `Bearer ${token}`)
        .send({ photo_ids: photoIds.slice(1, 4) });
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: 'DOWNLOAD_LIMIT_REACHED', remaining: 2 });
      expect(await grantCount(event.id)).toBe(1);

      // The granted photo is free, so these three cost two and fit.
      const ok = await request(app)
        .post(`/api/gallery/${event.slug}/download-selected`)
        .set('Authorization', `Bearer ${token}`)
        .send({ photo_ids: photoIds.slice(0, 3) })
        .buffer(true)
        .parse((res, cb) => { res.on('data', () => {}); res.on('end', () => cb(null, null)); });
      expect(ok.status).toBe(200);
      expect(await grantCount(event.id)).toBe(3);
    });

    const drain = (r, cb) => { r.on('data', () => {}); r.on('end', () => cb(null, null)); };
    const eventuallyGrantCount = async (eventId, expected) => {
      // The release of undelivered grants runs after the archive is finalized.
      for (let i = 0; i < 50; i += 1) {
        if (await grantCount(eventId) === expected) return expected;
        await new Promise((r) => setTimeout(r, 20));
      }
      return grantCount(eventId);
    };

    it('gives back the slots of photos a selected zip had to skip', async () => {
      const { event, photoIds, token } = await makeEvent({ limit: 3, photos: 3 });
      // Granted by an earlier download: must stay granted even though it is
      // skipped from this zip.
      await quota.grantDownloads(event, [photoIds[0]]);
      await db('photos').whereIn('id', [photoIds[0], photoIds[1]])
        .update({ path: `${event.slug}/missing.jpg` });

      const res = await request(app)
        .post(`/api/gallery/${event.slug}/download-selected`)
        .set('Authorization', `Bearer ${token}`)
        .send({ photo_ids: photoIds })
        .buffer(true)
        .parse(drain);
      expect(res.status).toBe(200);
      // photoIds[0] (earlier grant) + photoIds[2] (delivered); photoIds[1] released.
      expect(await eventuallyGrantCount(event.id, 2)).toBe(2);
      const granted = await quota.grantedPhotoIds(event.id);
      expect([...granted].sort()).toEqual([photoIds[0], photoIds[2]].sort());
    });

    it('gives back the slots of photos download-all had to skip', async () => {
      const { event, photoIds, token } = await makeEvent({ limit: 10, photos: 3 });
      await db('photos').where({ id: photoIds[1] }).update({ path: `${event.slug}/missing.jpg` });
      const res = await request(app)
        .get(`/api/gallery/${event.slug}/download-all`)
        .set('Authorization', `Bearer ${token}`)
        .buffer(true)
        .parse(drain);
      expect(res.status).toBe(200);
      expect(await eventuallyGrantCount(event.id, 2)).toBe(2);
      expect((await quota.grantedPhotoIds(event.id)).has(photoIds[1])).toBe(false);
    });

    it('download-all is refused while the gallery holds more photos than remain', async () => {
      const { event, token } = await makeEvent({ limit: 3, photos: 4 });
      const res = await request(app)
        .get(`/api/gallery/${event.slug}/download-all`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('DOWNLOAD_LIMIT_REACHED');
      expect(await grantCount(event.id)).toBe(0);
    });

    it('download-all streams and grants every photo when the gallery fits', async () => {
      const { event, token } = await makeEvent({ limit: 10, photos: 4 });
      const res = await request(app)
        .get(`/api/gallery/${event.slug}/download-all`)
        .set('Authorization', `Bearer ${token}`)
        .buffer(true)
        .parse((r, cb) => { r.on('data', () => {}); r.on('end', () => cb(null, null)); });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(await grantCount(event.id)).toBe(4);
    });

    it('a resolution job is refused at creation when it cannot be delivered', async () => {
      const { event, token } = await makeEvent({ limit: 2, photos: 3 });
      await db('events').where({ id: event.id }).update({ download_resolution_picker_enabled: 1 });
      const res = await request(app)
        .post(`/api/gallery/${event.slug}/download-jobs`)
        .set('Authorization', `Bearer ${token}`)
        .send({ resolution: 'original' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('DOWNLOAD_LIMIT_REACHED');
      // PostgreSQL returns COUNT as a string, SQLite as a number.
      const { c } = await db('download_jobs').where({ event_id: event.id }).count('id as c').first();
      expect(Number(c)).toBe(0);
    });
  });

  describe('grantDownloads', () => {
    it('lets exactly one of two parallel requests take the last slot', async () => {
      const { event, photoIds } = await makeEvent({ limit: 1 });
      const results = await Promise.all([
        quota.grantDownloads(event, [photoIds[0]]),
        quota.grantDownloads(event, [photoIds[1]]),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await grantCount(event.id)).toBe(1);
    });

    it('frees the slot of a deleted photo', async () => {
      const { event, photoIds } = await makeEvent({ limit: 1 });
      expect((await quota.grantDownloads(event, [photoIds[0]])).ok).toBe(true);
      expect((await quota.grantDownloads(event, [photoIds[1]])).ok).toBe(false);
      await db('photos').where({ id: photoIds[0] }).del();
      expect(await quota.getQuota(event)).toEqual({ limit: 1, used: 0, remaining: 1 });
      expect((await quota.grantDownloads(event, [photoIds[1]])).ok).toBe(true);
    });

    it('honours a limit changed after the request loaded the event', async () => {
      const { event, photoIds } = await makeEvent({ limit: 1 });
      await db('events').where({ id: event.id }).update({ download_limit: 3 });
      // `event` still says 1; the grant re-reads the row.
      expect((await quota.grantDownloads(event, photoIds.slice(0, 3))).ok).toBe(true);
    });
  });

  describe('lightbox original', () => {
    it('redirects a non-granted image to the preview tier and serves a granted one', async () => {
      const { event, photoIds, token } = await makeEvent({ limit: 2 });
      const withheld = await request(app)
        .get(`/api/gallery/${event.slug}/photo/${photoIds[1]}`)
        .set('Authorization', `Bearer ${token}`);
      expect(withheld.status).toBe(302);
      expect(withheld.headers.location).toBe(`/api/gallery/${event.slug}/preview/${photoIds[1]}`);

      await quota.grantDownloads(event, [photoIds[0]]);
      const served = await request(app)
        .get(`/api/gallery/${event.slug}/photo/${photoIds[0]}`)
        .set('Authorization', `Bearer ${token}`);
      expect(served.status).toBe(200);
    });

    it('serves the original to an unlimited gallery and to an admin preview', async () => {
      const unlimited = await makeEvent({ limit: null });
      await request(app)
        .get(`/api/gallery/${unlimited.event.slug}/photo/${unlimited.photoIds[0]}`)
        .set('Authorization', `Bearer ${unlimited.token}`)
        .expect(200);

      const limited = await makeEvent({ limit: 1 });
      await request(app)
        .get(`/api/gallery/${limited.event.slug}/photo/${limited.photoIds[0]}?admin_preview=1`)
        .set('Cookie', [`admin_token=${adminToken}`])
        .expect(200);
    });

    it('the preview route does not bounce back to a withheld original', async () => {
      const { event, photoIds, token } = await makeEvent({ limit: 1 });
      // A photo row whose source is gone: the preview cannot be generated.
      await db('photos').where({ id: photoIds[0] }).update({ path: `${event.slug}/missing.jpg` });
      const res = await request(app)
        .get(`/api/gallery/${event.slug}/preview/${photoIds[0]}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });
  });

  describe('photos payload', () => {
    it('carries the quota and per-photo grants, and points images at the preview', async () => {
      const { event, photoIds, token } = await makeEvent({ limit: 3 });
      await quota.grantDownloads(event, [photoIds[0]]);

      const res = await request(app)
        .get(`/api/gallery/${event.slug}/photos`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.event).toMatchObject({
        download_limit: 3, downloads_used: 1, downloads_remaining: 2,
      });
      const byId = Object.fromEntries(res.body.photos.map((p) => [p.id, p]));
      expect(byId[photoIds[0]].download_granted).toBe(true);
      expect(byId[photoIds[0]].url).toContain(`/photo/${photoIds[0]}`);
      expect(byId[photoIds[1]].download_granted).toBe(false);
      expect(byId[photoIds[1]].url).toContain(`/preview/${photoIds[1]}`);
      expect(byId[photoIds[1]].preview_url).toContain(`/preview/${photoIds[1]}`);
    });

    it('reports an unlimited gallery as such', async () => {
      const { event, token } = await makeEvent({ limit: null });
      const res = await request(app)
        .get(`/api/gallery/${event.slug}/photos`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.body.event).toMatchObject({
        download_limit: null, downloads_used: 0, downloads_remaining: null,
      });
    });
  });

  describe('admin usage + reset', () => {
    it('reports usage and resets it', async () => {
      const { event, photoIds } = await makeEvent({ limit: 2 });
      await quota.grantDownloads(event, photoIds.slice(0, 2));

      const usage = await request(app)
        .get(`/api/admin/events/${event.id}/download-limit`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(usage.status).toBe(200);
      expect(usage.body).toEqual({ download_limit: 2, downloads_used: 2, downloads_remaining: 0 });

      const reset = await request(app)
        .post(`/api/admin/events/${event.id}/download-limit/reset`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(reset.status).toBe(200);
      expect(reset.body).toEqual({ download_limit: 2, downloads_used: 0, downloads_remaining: 2 });
      expect(await grantCount(event.id)).toBe(0);
    });

    it('accepts and clears the limit through the event update', async () => {
      const { event } = await makeEvent({ limit: null });
      const set = await request(app)
        .put(`/api/admin/events/${event.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ download_limit: 10 });
      expect(set.status).toBe(200);
      expect((await db('events').where({ id: event.id }).first()).download_limit).toBe(10);

      const bad = await request(app)
        .put(`/api/admin/events/${event.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ download_limit: 0 });
      expect(bad.status).toBe(400);

      const cleared = await request(app)
        .put(`/api/admin/events/${event.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ download_limit: null });
      expect(cleared.status).toBe(200);
      expect((await db('events').where({ id: event.id }).first()).download_limit).toBeNull();
    });
  });
});
