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
const EXTERNAL_ROOT = fs.mkdtempSync(path.join(require('os').tmpdir(), 'picpeak-limit-ext-'));
process.env.EXTERNAL_MEDIA_ROOT = EXTERNAL_ROOT;

// The real service, with grantDownloads wrapped so a test can stage a race
// the route loses (or a photo deleted just before the grant).
jest.mock('../../src/services/downloadQuota', () => {
  const actual = jest.requireActual('../../src/services/downloadQuota');
  return { ...actual, grantDownloads: jest.fn(actual.grantDownloads) };
});

// A deterministic fingerprint, so a token minted below verifies on the
// secure-image serve route.
jest.mock('../../src/middleware/secureImageMiddleware', () => ({
  secureImageAccess: (req, _res, next) => {
    req.clientInfo = { fingerprint: 'test-fp', ip: '127.0.0.1', userAgent: 'jest' };
    next();
  },
  getSecurityStatus: (_req, res) => res.json({ ok: true }),
}));

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
    // The PIN client draws on the quota; a share-link guest does not.
    return {
      event, photoIds, token: galleryToken(event, { accessLevel: 'client' }), guestToken: galleryToken(event),
    };
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
    app.use('/api/secure-images', require('../../src/routes/secureImages'));
    app.use('/api/images', require('../../src/routes/protectedImages'));
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

    it('an aborted zip cannot take back a slot another download reused', async () => {
      const { event, photoIds } = await makeEvent({ limit: 3 });
      const zip = await quota.grantDownloads(event, photoIds.slice(0, 2), { reserve: true });
      expect(zip.ok).toBe(true);
      // While the zip is reserved, its photos keep the preview.
      expect(await quota.isOriginalWithheld(event, { id: photoIds[0] })).toBe(true);
      // A single download of the first photo while the zip is still streaming.
      expect((await quota.grantDownloads(event, [photoIds[0]])).newIds).toEqual([]);
      expect(await quota.isOriginalWithheld(event, { id: photoIds[0] })).toBe(false);
      // The zip is cancelled before either photo went out.
      await quota.settleReservation(event.id, zip, []);
      expect([...(await quota.grantedPhotoIds(event.id))]).toEqual([photoIds[0]]);
    });

    it('overlapping zips keep a photo neither shipped refundable, and one that shipped counted', async () => {
      const { event, photoIds } = await makeEvent({ limit: 3 });
      const a = await quota.grantDownloads(event, photoIds.slice(0, 2), { reserve: true });
      const b = await quota.grantDownloads(event, photoIds.slice(0, 2), { reserve: true });
      expect(b.newIds).toEqual([]);
      // b ships the second photo, then a is cancelled having shipped nothing.
      await quota.settleReservation(event.id, b, [photoIds[1]]);
      await quota.settleReservation(event.id, a, []);
      expect([...(await quota.grantedPhotoIds(event.id))]).toEqual([photoIds[1]]);
      expect(await quota.isOriginalWithheld(event, { id: photoIds[1] })).toBe(false);
    });

    it('a slot stays charged while another zip can still deliver it', async () => {
      const { event, photoIds } = await makeEvent({ limit: 1 });
      const a = await quota.grantDownloads(event, [photoIds[0]], { reserve: true });
      const b = await quota.grantDownloads(event, [photoIds[0]], { reserve: true });
      await quota.settleReservation(event.id, a, []);
      // b may still ship it, so nothing else fits yet.
      expect((await quota.grantDownloads(event, [photoIds[1]])).ok).toBe(false);
      await quota.settleReservation(event.id, b, []);
      expect(await grantCount(event.id)).toBe(0);
    });

    it('a single download settles as delivered only once its bytes went out', async () => {
      const { event, photoIds, token } = await makeEvent({ limit: 2 });
      await db('photos').where({ id: photoIds[0] }).update({ path: `${event.slug}/missing.jpg` });
      await request(app)
        .get(`/api/gallery/${event.slug}/download/${photoIds[0]}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
      await request(app)
        .get(`/api/gallery/${event.slug}/download/${photoIds[1]}`)
        .set('Authorization', `Bearer ${token}`)
        .buffer(true).parse(drain)
        .expect(200);
      expect(await eventuallyGrantCount(event.id, 1)).toBe(1);
      // Settled after the response closed.
      let withheld = true;
      for (let i = 0; i < 50 && withheld; i += 1) {
        withheld = await quota.isOriginalWithheld(event, { id: photoIds[1] });
        if (withheld) await new Promise((r) => setTimeout(r, 20));
      }
      expect(withheld).toBe(false);
      expect([...(await quota.grantedPhotoIds(event.id))]).toEqual([photoIds[1]]);
    });

    it('a pending grant whose download never settled stops counting after a day', async () => {
      const { event, photoIds } = await makeEvent({ limit: 1 });
      await quota.grantDownloads(event, [photoIds[0]], { reserve: true });
      expect((await quota.grantDownloads(event, [photoIds[1]])).ok).toBe(false);
      // The process died mid-download: the row was never settled.
      await db('event_download_grants').where({ event_id: event.id })
        .update({ granted_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString() });
      expect((await quota.getQuota(event)).remaining).toBe(1);
      expect((await quota.grantDownloads(event, [photoIds[1]])).ok).toBe(true);
      expect([...(await quota.grantedPhotoIds(event.id))]).toEqual([photoIds[1]]);
    });

    it('honours a limit set after an unlimited request loaded the event', async () => {
      const { event, photoIds } = await makeEvent({ limit: null });
      await db('events').where({ id: event.id }).update({ download_limit: 1 });
      expect((await quota.grantDownloads(event, photoIds.slice(0, 2))).ok).toBe(false);
    });

    it('a zip cancelled in the middle of a photo still charges that photo', async () => {
      const { event, photoIds, token } = await makeEvent({ limit: 3, photos: 2 });
      // Incompressible and large, so its bytes flow before its entry completes.
      const big = require('crypto').randomBytes(8 * 1024 * 1024);
      const rows = await db('photos').whereIn('id', photoIds).orderBy('uploaded_at', 'desc');
      await fs.promises.writeFile(path.join(process.env.STORAGE_PATH, 'events', 'active', rows[0].path), big);

      const http = require('http');
      const server = app.listen(0);
      try {
        await new Promise((resolve, reject) => {
          const req = http.request({
            port: server.address().port,
            method: 'POST',
            path: `/api/gallery/${event.slug}/download-selected`,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          }, (res) => {
            res.once('data', () => { req.destroy(); resolve(); });
          });
          req.on('error', () => resolve());
          req.on('timeout', reject);
          req.end(JSON.stringify({ photo_ids: [rows[0].id] }));
        });
        // The first photo started going out and stays charged.
        let granted = [];
        for (let i = 0; i < 50; i += 1) {
          granted = [...(await quota.grantedPhotoIds(event.id, null, undefined, { deliveredOnly: true }))];
          if (granted.length) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        expect(granted).toEqual([rows[0].id]);
      } finally {
        await new Promise((r) => server.close(r));
      }
    });

    it('zips external photos and charges each one it shipped', async () => {
      const { event, photoIds, token } = await makeEvent({ limit: 3, photos: 2 });
      await fs.promises.mkdir(path.join(EXTERNAL_ROOT, event.slug), { recursive: true });
      for (const [i, id] of photoIds.entries()) {
        await fs.promises.writeFile(path.join(EXTERNAL_ROOT, event.slug, `ext-${i}.jpg`), jpeg);
        await db('photos').where({ id }).update({ source_origin: 'external', external_relpath: `${event.slug}/ext-${i}.jpg` });
      }
      const res = await request(app)
        .post(`/api/gallery/${event.slug}/download-selected`)
        .set('Authorization', `Bearer ${token}`)
        .send({ photo_ids: photoIds })
        .buffer(true).parse(drain);
      expect(res.status).toBe(200);
      let delivered = [];
      for (let i = 0; i < 50 && delivered.length < 2; i += 1) {
        delivered = [...(await quota.grantedPhotoIds(event.id, null, undefined, { deliveredOnly: true }))];
        if (delivered.length < 2) await new Promise((r) => setTimeout(r, 20));
      }
      expect(delivered.sort()).toEqual([...photoIds].sort());
    });

    it('a download from before a reset cannot release a reservation made after it', async () => {
      const { event, photoIds } = await makeEvent({ limit: 1 });
      const before = await quota.grantDownloads(event, [photoIds[0]], { reserve: true });
      await quota.resetGrants(event.id);
      const after = await quota.grantDownloads(event, [photoIds[0]], { reserve: true });
      expect(after.ok).toBe(true);
      await quota.settleReservation(event.id, before, []);
      expect(await grantCount(event.id)).toBe(1);
      expect((await quota.grantDownloads(event, [photoIds[1]])).ok).toBe(false);
    });

    it('settles what shipped even when one of the photos was deleted meanwhile', async () => {
      const { event, photoIds } = await makeEvent({ limit: 3 });
      const zip = await quota.grantDownloads(event, photoIds.slice(0, 2), { reserve: true });
      await db('photos').where({ id: photoIds[0] }).del();
      await quota.settleReservation(event.id, zip, photoIds.slice(0, 2));
      expect(await quota.isOriginalWithheld(event, { id: photoIds[1] })).toBe(false);
    });

    it('a HEAD probe of download-all takes none of the quota', async () => {
      const { event, token } = await makeEvent({ limit: 10, photos: 3 });
      const res = await request(app)
        .head(`/api/gallery/${event.slug}/download-all`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/zip');
      expect(await grantCount(event.id)).toBe(0);
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

  describe('prepared archives', () => {
    it('a ready job reports when the limit would now refuse it', async () => {
      const { event, photoIds, token } = await makeEvent({ limit: 2, photos: 3 });
      const jobToken = 'a'.repeat(64);
      await db('download_jobs').insert({
        token: jobToken,
        event_id: event.id,
        resolution: 'original',
        photo_ids: JSON.stringify(photoIds.slice(0, 2)),
        delivered_photo_ids: JSON.stringify(photoIds.slice(0, 2)),
        dedup_key: 'b'.repeat(64),
        status: 'ready',
        zip_path: 'download-jobs/x.zip',
        photo_count: 2,
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        created_at: new Date().toISOString(),
      });
      const status = () => request(app)
        .get(`/api/gallery/${event.slug}/download-jobs/${jobToken}`)
        .set('Authorization', `Bearer ${token}`);

      expect((await status()).body.download_limit_reached).toBeUndefined();
      // Another viewer takes a slot while the archive waits.
      await quota.grantDownloads(event, [photoIds[2]]);
      const res = await status();
      expect(res.status).toBe(200);
      expect(res.body.download_limit_reached).toMatchObject({ code: 'DOWNLOAD_LIMIT_REACHED', remaining: 1 });
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

    it('the secure-image route serves the preview, not the original, of a non-granted image', async () => {
      const { event, photoIds } = await makeEvent({ limit: 2 });
      await db('events').where({ id: event.id }).update({ protection_level: 'basic', require_password: 0 });
      const secureImageService = require('../../src/services/secureImageService');
      const mint = (photoId, extra = {}) => secureImageService.generateSecureToken(
        photoId,
        `gallery_public_${event.id}_${Date.now()}`,
        {
          clientFingerprint: 'test-fp', maxUses: 100, expiresIn: 3600,
          galleryAccess: require('../../src/services/galleryAccessService').grant({ id: event.id }, 'public'),
          ...extra,
        },
      );
      const view = (photoId, token) => request(app)
        .get(`/api/secure-images/${event.slug}/secure/${photoId}/${token}`)
        .buffer(true)
        .parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

      // Basic protection hands out the source bytes unchanged — the original.
      const withheld = await view(photoIds[1], mint(photoIds[1]));
      expect(withheld.status).toBe(200);
      expect(Buffer.compare(withheld.body, jpeg)).not.toBe(0);

      const exempt = await view(photoIds[1], mint(photoIds[1], { downloadLimitExempt: true }));
      expect(exempt.status).toBe(200);
      expect(Buffer.compare(exempt.body, jpeg)).toBe(0);

      await quota.grantDownloads(event, [photoIds[0]]);
      const granted = await view(photoIds[0], mint(photoIds[0]));
      expect(granted.status).toBe(200);
      expect(Buffer.compare(granted.body, jpeg)).toBe(0);
    });

    it('the legacy protected-image route serves the preview of a non-granted image', async () => {
      const { event, photoIds, token } = await makeEvent({ limit: 2 });
      await db('events').where({ id: event.id }).update({ protection_level: 'basic', add_fingerprint: 0 });
      const view = (photoId) => request(app)
        .get(`/api/images/${event.slug}/photo/${photoId}/view`)
        .set('Authorization', `Bearer ${token}`)
        .buffer(true)
        .parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

      const withheld = await view(photoIds[1]);
      expect(withheld.status).toBe(200);
      expect(Buffer.compare(withheld.body, jpeg)).not.toBe(0);

      await quota.grantDownloads(event, [photoIds[0]]);
      const granted = await view(photoIds[0]);
      expect(granted.status).toBe(200);
      expect(Buffer.compare(granted.body, jpeg)).toBe(0);
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

    it('reports an admin preview as unlimited, since the limit exempts it', async () => {
      const { event } = await makeEvent({ limit: 1 });
      await quota.grantDownloads(event, (await db('photos').where({ event_id: event.id }).pluck('id')).slice(0, 1));
      const res = await request(app)
        .get(`/api/gallery/${event.slug}/photos?admin_preview=1`)
        .set('Cookie', [`admin_token=${adminToken}`]);
      expect(res.status).toBe(200);
      expect(res.body.event).toMatchObject({ download_limit: null, downloads_remaining: null });
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

    it('lets a role that sees every event read the usage of one it does not own, not reset it', async () => {
      const { event, photoIds } = await makeEvent({ limit: 2 });
      await quota.grantDownloads(event, photoIds.slice(0, 1));
      const owner = await db('admin_users').where({ username: 'limit-admin' }).first();
      await db('events').where({ id: event.id }).update({ created_by: owner.id });
      const adminRole = await db('roles').where({ name: 'admin' }).first();
      const [otherId] = await db('admin_users').insert({
        username: `limit-other-${event.id}`,
        email: `limit-other-${event.id}@example.com`,
        password_hash: 'x',
        role_id: adminRole.id,
        is_active: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id').then((r) => [r[0]?.id || r[0]]);
      const otherToken = jwt.sign(
        { id: otherId, username: `limit-other-${event.id}`, type: 'admin', role: 'admin', loginTime: Date.now() },
        process.env.JWT_SECRET,
        { expiresIn: '1h', issuer: 'picpeak-auth' }
      );

      const usage = await request(app)
        .get(`/api/admin/events/${event.id}/download-limit`)
        .set('Authorization', `Bearer ${otherToken}`);
      expect(usage.status).toBe(200);
      expect(usage.body.downloads_used).toBe(1);
      const reset = await request(app)
        .post(`/api/admin/events/${event.id}/download-limit/reset`)
        .set('Authorization', `Bearer ${otherToken}`);
      expect(reset.status).toBe(403);
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

  // ── Review round: videos, guests, conditional GETs, races ──────────────
  const drainBody = (r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); };
  const eventually = async (read, expected) => {
    // Grants settle when the response closes, after supertest resolves.
    let value;
    for (let i = 0; i < 50; i += 1) {
      value = await read();
      if (value === expected) return value;
      await new Promise((r) => setTimeout(r, 20));
    }
    return value;
  };
  const deliveredCount = async (eventId) => (await quota.grantedPhotoIds(eventId, null, undefined, { deliveredOnly: true })).size;

  async function makeVideo(event, photoId) {
    const bytes = require('crypto').randomBytes(64 * 1024);
    const filename = `clip-${photoId}.mp4`;
    await fs.promises.writeFile(path.join(process.env.STORAGE_PATH, 'events', 'active', event.slug, filename), bytes);
    await db('photos').where({ id: photoId }).update({
      filename, path: `${event.slug}/${filename}`, media_type: 'video', mime_type: 'video/mp4', size_bytes: bytes.length,
    });
    return bytes;
  }

  describe('video playback (decision 1)', () => {
    const play = (event, id, token, range) => {
      const r = request(app).get(`/api/gallery/${event.slug}/photo/${id}`).set('Authorization', `Bearer ${token}`);
      if (range) r.set('Range', range);
      return r.buffer(true).parse(drainBody);
    };

    it('takes one slot per video, and replays and Range requests of it are free', async () => {
      const { event, photoIds, token } = await makeEvent({ limit: 2 });
      const bytes = await makeVideo(event, photoIds[0]);

      const first = await play(event, photoIds[0], token, 'bytes=0-1023');
      expect(first.status).toBe(206);
      expect(Buffer.compare(first.body, bytes.subarray(0, 1024))).toBe(0);
      expect(await eventually(() => deliveredCount(event.id), 1)).toBe(1);

      expect((await play(event, photoIds[0], token, 'bytes=1024-')).status).toBe(206);
      expect((await play(event, photoIds[0], token)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      expect(await grantCount(event.id)).toBe(1);
      expect((await quota.getQuota(event)).remaining).toBe(1);
    });

    it('refuses an ungranted video once the quota is used up, with the download refusal', async () => {
      const { event, photoIds, token } = await makeEvent({ limit: 1 });
      await makeVideo(event, photoIds[0]);
      await quota.grantDownloads(event, [photoIds[1]]);

      const res = await request(app)
        .get(`/api/gallery/${event.slug}/photo/${photoIds[0]}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Range', 'bytes=0-');
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'DOWNLOAD_LIMIT_REACHED', limit: 1, used: 1, remaining: 0 });
      expect(await grantCount(event.id)).toBe(1);
    });

    it('an unsatisfiable Range request takes no slot', async () => {
      const { event, photoIds, token } = await makeEvent({ limit: 1 });
      await makeVideo(event, photoIds[0]);
      const res = await play(event, photoIds[0], token, 'bytes=999999999-');
      expect(res.status).toBe(416);
      expect(await eventually(() => grantCount(event.id), 0)).toBe(0);
    });

    it('a guest plays a granted video free and is refused any other', async () => {
      const { event, photoIds, guestToken } = await makeEvent({ limit: 3 });
      await makeVideo(event, photoIds[0]);
      await makeVideo(event, photoIds[1]);
      await quota.grantDownloads(event, [photoIds[0]]);

      expect((await play(event, photoIds[0], guestToken, 'bytes=0-99')).status).toBe(206);
      const refused = await play(event, photoIds[1], guestToken, 'bytes=0-99');
      expect(refused.status).toBe(403);
      expect(JSON.parse(refused.body.toString())).toMatchObject({ code: 'DOWNLOAD_LIMIT_REACHED', preview_only: true });
      await new Promise((r) => setTimeout(r, 50));
      expect(await grantCount(event.id)).toBe(1);
    });

    it('an unlimited gallery and an admin preview stream videos without grants', async () => {
      const unlimited = await makeEvent({ limit: null });
      await makeVideo(unlimited.event, unlimited.photoIds[0]);
      expect((await play(unlimited.event, unlimited.photoIds[0], unlimited.guestToken)).status).toBe(200);

      const limited = await makeEvent({ limit: 1 });
      await makeVideo(limited.event, limited.photoIds[0]);
      const preview = await request(app)
        .get(`/api/gallery/${limited.event.slug}/photo/${limited.photoIds[0]}?admin_preview=1`)
        .set('Cookie', [`admin_token=${adminToken}`])
        .buffer(true).parse(drainBody);
      expect(preview.status).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      expect(await grantCount(unlimited.event.id)).toBe(0);
      expect(await grantCount(limited.event.id)).toBe(0);
    });

    it('the hero and preview routes of a video lead back to the counted route', async () => {
      const { event, photoIds, guestToken } = await makeEvent({ limit: 1 });
      await makeVideo(event, photoIds[0]);
      for (const route of ['hero', 'preview']) {
        const res = await request(app)
          .get(`/api/gallery/${event.slug}/${route}/${photoIds[0]}`)
          .set('Authorization', `Bearer ${guestToken}`);
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe(`/api/gallery/${event.slug}/photo/${photoIds[0]}`);
      }
    });
  });

  describe('share-link guests on a limited gallery (decision 2)', () => {
    it('get the preview-size copy of a single photo and use no slot', async () => {
      const { event, photoIds, guestToken } = await makeEvent({ limit: 1 });
      const res = await request(app)
        .get(`/api/gallery/${event.slug}/download/${photoIds[0]}`)
        .set('Authorization', `Bearer ${guestToken}`)
        .buffer(true).parse(drainBody);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^image\/(jpeg|webp)/);
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(Buffer.compare(res.body, jpeg)).not.toBe(0);
      await new Promise((r) => setTimeout(r, 50));
      expect(await grantCount(event.id)).toBe(0);
      // Not refused at the limit either: they never draw on it.
      await quota.grantDownloads(event, [photoIds[1]]);
      await request(app)
        .get(`/api/gallery/${event.slug}/download/${photoIds[2]}`)
        .set('Authorization', `Bearer ${guestToken}`)
        .expect(200);
    });

    it('are refused a video, which has no preview-size copy', async () => {
      const { event, photoIds, guestToken } = await makeEvent({ limit: 2 });
      await makeVideo(event, photoIds[0]);
      const res = await request(app)
        .get(`/api/gallery/${event.slug}/download/${photoIds[0]}`)
        .set('Authorization', `Bearer ${guestToken}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'DOWNLOAD_LIMIT_REACHED', preview_only: true });
      expect(await grantCount(event.id)).toBe(0);
    });

    it('get zips of preview-size copies from download-selected and download-all, using no slot', async () => {
      const { event, photoIds, guestToken } = await makeEvent({ limit: 1, photos: 3 });
      const selected = await request(app)
        .post(`/api/gallery/${event.slug}/download-selected`)
        .set('Authorization', `Bearer ${guestToken}`)
        .send({ photo_ids: photoIds })
        .buffer(true).parse(drainBody);
      expect(selected.status).toBe(200);
      expect(selected.headers['content-type']).toBe('application/zip');
      expect(selected.body.length).toBeGreaterThan(0);

      const all = await request(app)
        .get(`/api/gallery/${event.slug}/download-all`)
        .set('Authorization', `Bearer ${guestToken}`)
        .buffer(true).parse(drainBody);
      expect(all.status).toBe(200);
      expect(all.headers['content-type']).toBe('application/zip');
      await new Promise((r) => setTimeout(r, 50));
      expect(await grantCount(event.id)).toBe(0);
    });

    it('cannot start or collect a resolution job', async () => {
      const { event, photoIds, guestToken } = await makeEvent({ limit: 5, photos: 2 });
      await db('events').where({ id: event.id }).update({ download_resolution_picker_enabled: 1 });
      const created = await request(app)
        .post(`/api/gallery/${event.slug}/download-jobs`)
        .set('Authorization', `Bearer ${guestToken}`)
        .send({ resolution: 'original' });
      expect(created.status).toBe(403);
      expect(created.body).toMatchObject({ preview_only: true });

      const jobToken = 'c'.repeat(64);
      const zipKey = `download-jobs/${event.slug}-guest.zip`;
      await fs.promises.mkdir(path.join(process.env.STORAGE_PATH, 'download-jobs'), { recursive: true });
      await fs.promises.writeFile(path.join(process.env.STORAGE_PATH, zipKey), Buffer.from('PK'));
      await db('download_jobs').insert({
        token: jobToken, event_id: event.id, resolution: 'original',
        photo_ids: JSON.stringify(photoIds), delivered_photo_ids: JSON.stringify(photoIds),
        dedup_key: 'd'.repeat(64), status: 'ready', zip_path: zipKey, photo_count: 2,
        visibility_scope: require('../../src/services/downloadJobService').visibilityScopeFor('guest'),
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(), created_at: new Date().toISOString(),
      });
      const file = await request(app)
        .get(`/api/gallery/${event.slug}/download-jobs/${jobToken}/file`)
        .set('Authorization', `Bearer ${guestToken}`);
      expect(file.status).toBe(403);
      expect(file.body).toMatchObject({ preview_only: true });
      expect(await grantCount(event.id)).toBe(0);
    });

    it('get the preview-size copy from secure-download', async () => {
      const { event, photoIds, guestToken } = await makeEvent({ limit: 1 });
      await db('events').where({ id: event.id }).update({ require_password: 0 });
      const current = await db('events').where({ id: event.id }).first();
      const secureImageService = require('../../src/services/secureImageService');
      const token = secureImageService.generateSecureToken(photoIds[0], `gallery_public_${event.id}_${Date.now()}`, {
        clientFingerprint: 'test-fp', maxUses: 10, expiresIn: 3600,
        galleryAccess: require('../../src/services/galleryAccessService').grant(current, 'public'),
      });
      const res = await request(app)
        .get(`/api/secure-images/${event.slug}/secure-download/${photoIds[0]}/${token}`)
        .set('Authorization', `Bearer ${guestToken}`)
        .buffer(true).parse(drainBody);
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(Buffer.compare(res.body, jpeg)).not.toBe(0);
      expect(await grantCount(event.id)).toBe(0);
    });

    it('get the original on an unlimited gallery, as before', async () => {
      const { event, photoIds, guestToken } = await makeEvent({ limit: null });
      const res = await request(app)
        .get(`/api/gallery/${event.slug}/download/${photoIds[0]}`)
        .set('Authorization', `Bearer ${guestToken}`)
        .buffer(true).parse(drainBody);
      expect(res.status).toBe(200);
      expect(Buffer.compare(res.body, jpeg)).toBe(0);
    });

    it('the PIN client still gets the original and draws on the quota', async () => {
      const { event, photoIds, token } = await makeEvent({ limit: 1 });
      const res = await request(app)
        .get(`/api/gallery/${event.slug}/download/${photoIds[0]}`)
        .set('Authorization', `Bearer ${token}`)
        .buffer(true).parse(drainBody);
      expect(res.status).toBe(200);
      expect(Buffer.compare(res.body, jpeg)).toBe(0);
      expect(await eventually(() => deliveredCount(event.id), 1)).toBe(1);
    });

    it('a portal session draws on the quota like the PIN client', () => {
      expect(quota.drawsOnQuota({ accessLevel: 'guest', viaCustomer: true })).toBe(true);
      expect(quota.drawsOnQuota({ accessLevel: 'client' })).toBe(true);
      expect(quota.drawsOnQuota({ accessLevel: 'guest' })).toBe(false);
    });

    it('the photos payload gives a guest no counter and no picker, and the client both', async () => {
      const { event, token, guestToken } = await makeEvent({ limit: 3 });
      await db('events').where({ id: event.id }).update({ download_resolution_picker_enabled: 1 });
      const guest = await request(app)
        .get(`/api/gallery/${event.slug}/photos`)
        .set('Authorization', `Bearer ${guestToken}`);
      expect(guest.status).toBe(200);
      expect(guest.body.event).toMatchObject({
        download_limit: null, downloads_remaining: null, download_preview_only: true,
      });
      expect(guest.body.event.download_resolution).toMatchObject({ picker_enabled: false, choices: [] });

      const client = await request(app)
        .get(`/api/gallery/${event.slug}/photos`)
        .set('Authorization', `Bearer ${token}`);
      expect(client.body.event).toMatchObject({
        download_limit: 3, downloads_remaining: 3, download_preview_only: false,
      });
    });
  });

  describe('review fixes', () => {
    it('a 304 to a conditional GET takes no slot', async () => {
      const { event, photoIds, token } = await makeEvent({ limit: 1 });
      const dl = (headers = {}) => request(app)
        .get(`/api/gallery/${event.slug}/download/${photoIds[0]}`)
        .set('Authorization', `Bearer ${token}`)
        .set(headers)
        .buffer(true).parse(drainBody);
      const first = await dl();
      expect(first.status).toBe(200);
      expect(first.headers.etag).toBeTruthy();
      expect(await eventually(() => deliveredCount(event.id), 1)).toBe(1);

      // An admin reset, then the browser revalidates what it already holds.
      await quota.resetGrants(event.id);
      const revalidated = await dl({ 'If-None-Match': first.headers.etag });
      expect(revalidated.status).toBe(304);
      expect(await eventually(() => grantCount(event.id), 0)).toBe(0);
      await new Promise((r) => setTimeout(r, 50));
      expect((await quota.getQuota(event)).remaining).toBe(1);
    });

    it('a download that loses the race for the last slot is not counted in the stats', async () => {
      const { event, photoIds, token } = await makeEvent({ limit: 1 });
      quota.grantDownloads.mockResolvedValueOnce({ ok: false, limit: 1, used: 1, remaining: 0 });
      const res = await request(app)
        .get(`/api/gallery/${event.slug}/download/${photoIds[0]}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect((await db('photos').where({ id: photoIds[0] }).first()).download_count || 0).toBe(0);
      const { c } = await db('access_logs').where({ event_id: event.id, action: 'download' }).count('id as c').first();
      expect(Number(c)).toBe(0);
    });

    it('the preview redirect keeps the cache-buster query', async () => {
      const { event, photoIds, token } = await makeEvent({ limit: 1 });
      const res = await request(app)
        .get(`/api/gallery/${event.slug}/photo/${photoIds[0]}?v=abc123`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/api/gallery/${event.slug}/preview/${photoIds[0]}?v=abc123`);
    });

    it('a photo deleted just before its grant answers 404, not 500', async () => {
      const { event, photoIds, token } = await makeEvent({ limit: 2 });
      const actual = jest.requireActual('../../src/services/downloadQuota').grantDownloads;
      // Enforce the grant's foreign key as PostgreSQL does.
      await db.raw('PRAGMA foreign_keys = ON');
      try {
        quota.grantDownloads.mockImplementationOnce(async (...args) => {
          await db('photos').where({ id: photoIds[0] }).del();
          return actual(...args);
        });
        const res = await request(app)
          .get(`/api/gallery/${event.slug}/download/${photoIds[0]}`)
          .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(404);
        expect(await grantCount(event.id)).toBe(0);
      } finally {
        await db.raw('PRAGMA foreign_keys = OFF');
      }
    });

    it('deleteEventCascade locks the event row before deleting grants and photos', () => {
      const src = fs.readFileSync(path.join(__dirname, '../../src/routes/adminEvents/helpers.js'), 'utf8');
      const body = src.slice(src.indexOf('await db.transaction(async (trx) => {'));
      const lock = body.indexOf('trx(\'events\').where({ id: eventId }).forUpdate()');
      expect(lock).toBeGreaterThan(-1);
      for (const table of ['activity_logs', 'event_download_grants', 'photos']) {
        expect(lock).toBeLessThan(body.indexOf(`trx('${table}')`));
      }
    });
  });
});
