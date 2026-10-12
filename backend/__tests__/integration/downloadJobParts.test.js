/**
 * Split download archives (issue 1733).
 *
 * Pins the contract:
 *  - a job below the part size is one archive, on the route, key and filename
 *    it always had, with no part list
 *  - a larger job is written as several archives by one build; every photo
 *    lands in exactly one part, in a stable order
 *  - a part is addressed by the job token and its number and passes the same
 *    checks as the single archive: event, visibility scope, staleness
 *  - the parts of a job together charge the download limit what the one
 *    archive would, and a part taken twice is free
 *  - a change to the gallery makes every part stale at once
 *  - two builds of the same content never write the same storage key
 *  - the sweep removes every part
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const StreamZip = require('node-stream-zip');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'download-parts-test-secret';

describe('Split download archives (issue 1733)', () => {
  let db;
  let cleanup;
  let app;
  let jpeg;
  let jobService;
  let defaultLimits;
  let slugCounter = 0;

  const galleryToken = (event, extra = {}) => jwt.sign(
    { eventId: event.id, eventSlug: event.slug, type: 'gallery', ...extra },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  async function makeEvent({ limit = null, photos = 5 } = {}) {
    slugCounter += 1;
    const slug = `parts-test-${slugCounter}`;
    const inserted = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Parts Test ${slugCounter}`,
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      share_token: `parts-share-${slugCounter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      allow_downloads: 1,
      download_limit: limit,
      download_resolution_picker_enabled: 1,
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
        // Newest first is the archive order, so photoIds is in archive order.
        uploaded_at: new Date(Date.now() - i * 1000).toISOString(),
      }).returning('id');
      photoIds.push(p[0]?.id ?? p[0]);
    }
    const event = await db('events').where({ id }).first();
    return {
      event, photoIds, token: galleryToken(event, { accessLevel: 'client' }), guestToken: galleryToken(event),
    };
  }

  // Start a job over the route and wait for its build.
  async function prepare(event, token) {
    const created = await request(app)
      .post(`/api/gallery/${event.slug}/download-jobs`)
      .set('Authorization', `Bearer ${token}`)
      .send({ resolution: 'original' });
    expect(created.status).toBe(202);
    const row = await db('download_jobs').where({ token: created.body.token }).first();
    await jobService.liveBuilds.get(row.id);
    return created.body.token;
  }

  const status = (event, token, jobToken) => request(app)
    .get(`/api/gallery/${event.slug}/download-jobs/${jobToken}`)
    .set('Authorization', `Bearer ${token}`);
  const drain = (r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); };
  const fetchPart = (event, token, jobToken, part) => request(app)
    .get(`/api/gallery/${event.slug}/download-jobs/${jobToken}/parts/${part}/file`)
    .set('Authorization', `Bearer ${token}`)
    .buffer(true).parse(drain);
  const fetchWhole = (event, token, jobToken) => request(app)
    .get(`/api/gallery/${event.slug}/download-jobs/${jobToken}/file`)
    .set('Authorization', `Bearer ${token}`)
    .buffer(true).parse(drain);

  const storedPath = (key) => path.join(process.env.STORAGE_PATH, key);
  async function entryNames(key) {
    const zip = new StreamZip.async({ file: storedPath(key) });
    try {
      return Object.keys(await zip.entries());
    } finally {
      await zip.close();
    }
  }
  const grantCount = async (eventId) => {
    const row = await db('event_download_grants').where({ event_id: eventId }).count('id as count').first();
    return Number(row.count);
  };
  const eventuallyGrantCount = async (eventId, expected) => {
    for (let i = 0; i < 50; i += 1) {
      if (await grantCount(eventId) === expected) return expected;
      await new Promise((r) => setTimeout(r, 20));
    }
    return grantCount(eventId);
  };

  // Two photos fit a part, the third opens the next one.
  const twoPerPart = () => { jobService.partLimits = { maxBytes: jpeg.length * 2, maxFiles: 10000 }; };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    jobService = require('../../src/services/downloadJobService');
    defaultLimits = jobService.partLimits;

    jpeg = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 40, g: 80, b: 200 } },
    }).jpeg().toBuffer();

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterEach(() => { jobService.partLimits = defaultLimits; });

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  describe('where a part ends', () => {
    const limits = { maxBytes: 100, maxFiles: 3 };

    it('never leaves a part empty, so an oversized file gets one of its own', () => {
      expect(jobService.startsNewPart({ files: 0, bytes: 0 }, 500, limits)).toBe(false);
      expect(jobService.startsNewPart({ files: 1, bytes: 500 }, 1, limits)).toBe(true);
    });

    it('fills a part up to the limit and not a byte past it', () => {
      expect(jobService.startsNewPart({ files: 1, bytes: 60 }, 40, limits)).toBe(false);
      expect(jobService.startsNewPart({ files: 1, bytes: 60 }, 41, limits)).toBe(true);
    });

    it('caps the number of files as well', () => {
      expect(jobService.startsNewPart({ files: 2, bytes: 2 }, 1, limits)).toBe(false);
      expect(jobService.startsNewPart({ files: 3, bytes: 3 }, 1, limits)).toBe(true);
    });

    it('defaults to 2 GB', () => {
      expect(defaultLimits.maxBytes).toBe(2 * 1024 * 1024 * 1024);
    });
  });

  describe('a job below the part size', () => {
    it('is one archive on the route, key and filename it always had', async () => {
      const { event, photoIds, token } = await makeEvent({ photos: 3 });
      const jobToken = await prepare(event, token);

      const row = await db('download_jobs').where({ token: jobToken }).first();
      expect(row.status).toBe('ready');
      expect(row.parts).toBeNull();
      expect(row.zip_path).toBe(jobService.jobKey(event.slug, jobToken));
      expect(JSON.parse(row.delivered_photo_ids)).toEqual(photoIds);
      expect(Number(row.size_bytes)).toBe(fs.statSync(storedPath(row.zip_path)).size);

      const state = await status(event, token, jobToken);
      expect(state.body.status).toBe('ready');
      expect(state.body.parts).toBeUndefined();

      const file = await fetchWhole(event, token, jobToken);
      expect(file.status).toBe(200);
      expect(file.headers['content-disposition']).toBe(`attachment; filename="${event.slug}-original.zip"`);
      expect(Number(file.headers['content-length'])).toBe(Number(row.size_bytes));
      expect(await entryNames(row.zip_path)).toHaveLength(3);

      // It has no parts to address.
      expect((await fetchPart(event, token, jobToken, 1)).status).toBe(404);
    });
  });

  describe('a job above the part size', () => {
    it('puts every photo in exactly one part, in archive order', async () => {
      twoPerPart();
      const { event, photoIds, token } = await makeEvent({ photos: 5 });
      const jobToken = await prepare(event, token);

      const row = await db('download_jobs').where({ token: jobToken }).first();
      expect(row.status).toBe('ready');
      expect(row.zip_path).toBeNull();
      const parts = jobService.partsOf(row);
      expect(parts.map((p) => p.photo_ids)).toEqual([
        photoIds.slice(0, 2), photoIds.slice(2, 4), photoIds.slice(4),
      ]);
      expect(JSON.parse(row.delivered_photo_ids)).toEqual(photoIds);
      expect(Number(row.size_bytes)).toBe(parts.reduce((sum, p) => sum + p.size_bytes, 0));

      // The archives hold what the row says, under names unique across parts.
      const names = [];
      for (const part of parts) {
        const inPart = await entryNames(part.zip_path);
        expect(inPart).toHaveLength(part.photo_ids.length);
        names.push(...inPart);
      }
      expect(new Set(names).size).toBe(5);
    });

    it('splits the same job the same way again', async () => {
      twoPerPart();
      const { event, token } = await makeEvent({ photos: 5 });
      const first = jobService.partsOf(await db('download_jobs').where({ token: await prepare(event, token) }).first());
      await db('download_jobs').where({ event_id: event.id }).del();
      const second = jobService.partsOf(await db('download_jobs').where({ token: await prepare(event, token) }).first());
      expect(second.map((p) => p.photo_ids)).toEqual(first.map((p) => p.photo_ids));
    });

    it('lists the parts with their sizes and serves each under its own name', async () => {
      twoPerPart();
      const { event, token } = await makeEvent({ photos: 5 });
      const jobToken = await prepare(event, token);
      const parts = jobService.partsOf(await db('download_jobs').where({ token: jobToken }).first());

      const state = await status(event, token, jobToken);
      expect(state.body.parts).toEqual(parts.map((p, i) => ({
        part: i + 1, size_bytes: p.size_bytes, photo_count: p.photo_ids.length,
      })));
      // The storage key stays on the server.
      expect(JSON.stringify(state.body)).not.toContain('.download-cache');

      for (let n = 1; n <= 3; n += 1) {
        const file = await fetchPart(event, token, jobToken, n);
        expect(file.status).toBe(200);
        expect(file.headers['content-disposition'])
          .toBe(`attachment; filename="${event.slug}-original-part-${n}-of-3.zip"`);
        expect(Number(file.headers['content-length'])).toBe(parts[n - 1].size_bytes);
        expect(file.body.length).toBe(parts[n - 1].size_bytes);
      }

      // A second request for the same content joins the finished job.
      const again = await request(app)
        .post(`/api/gallery/${event.slug}/download-jobs`)
        .set('Authorization', `Bearer ${token}`)
        .send({ resolution: 'original' });
      expect(again.body).toMatchObject({ token: jobToken, status: 'ready' });
      expect(again.body.parts).toHaveLength(3);
    });

    it('checks every part like the single archive', async () => {
      twoPerPart();
      const { event, token, guestToken } = await makeEvent({ photos: 5 });
      const other = await makeEvent({ photos: 1 });
      const jobToken = await prepare(event, token);

      // No such part, and no single archive either.
      for (const part of [0, 4, -1, 'x', '1.5']) {
        expect((await fetchPart(event, token, jobToken, part)).status).toBe(404);
      }
      expect((await fetchWhole(event, token, jobToken)).status).toBe(404);
      // Built for the client's scope: a guest of the same gallery gets none of it.
      expect((await fetchPart(event, guestToken, jobToken, 1)).status).toBe(404);
      // Another gallery's visitor cannot reach it through their own slug.
      expect((await fetchPart(other.event, other.token, jobToken, 1)).status).toBe(404);
      // No token, no part.
      const anonymous = await request(app).get(`/api/gallery/${event.slug}/download-jobs/${jobToken}/parts/1/file`);
      expect(anonymous.status).toBe(401);
      // Downloads switched off after the build.
      await db('events').where({ id: event.id }).update({ allow_downloads: 0 });
      expect((await fetchPart(event, token, jobToken, 1)).status).toBe(403);
    });

    it('goes stale as a whole when the gallery changes', async () => {
      twoPerPart();
      const { event, photoIds, token } = await makeEvent({ photos: 5 });
      const jobToken = await prepare(event, token);
      expect((await fetchPart(event, token, jobToken, 1)).status).toBe(200);

      // The photo sits in part 3; parts 1 and 2 are refused with it.
      await db('photos').where({ id: photoIds[4] }).del();
      for (let n = 1; n <= 3; n += 1) {
        const file = await fetchPart(event, token, jobToken, n);
        expect(file.status).toBe(409);
        expect(JSON.parse(file.body.toString()).status).toBe('stale');
      }

      // The next request builds a fresh set under a new token.
      const freshToken = await prepare(event, token);
      expect(freshToken).not.toBe(jobToken);
      const fresh = jobService.partsOf(await db('download_jobs').where({ token: freshToken }).first());
      expect(fresh.map((p) => p.photo_ids)).toEqual([photoIds.slice(0, 2), photoIds.slice(2, 4)]);
    });

    it('charges the download limit once, whatever the number of parts', async () => {
      twoPerPart();
      const { event, token } = await makeEvent({ limit: 5, photos: 5 });
      const jobToken = await prepare(event, token);

      expect((await fetchPart(event, token, jobToken, 1)).status).toBe(200);
      expect(await eventuallyGrantCount(event.id, 2)).toBe(2);
      // The same part again is free.
      expect((await fetchPart(event, token, jobToken, 1)).status).toBe(200);
      expect(await eventuallyGrantCount(event.id, 2)).toBe(2);

      expect((await fetchPart(event, token, jobToken, 2)).status).toBe(200);
      expect((await fetchPart(event, token, jobToken, 3)).status).toBe(200);
      // Five photos, five grants: what the one archive would have cost.
      expect(await eventuallyGrantCount(event.id, 5)).toBe(5);
    });

    it('counts each photo once and logs the download once for the whole set', async () => {
      twoPerPart();
      const { event, token } = await makeEvent({ photos: 5 });
      const jobToken = await prepare(event, token);
      for (let n = 1; n <= 3; n += 1) {
        expect((await fetchPart(event, token, jobToken, n)).status).toBe(200);
      }
      // The counters are written after the response ends.
      const counted = async () => (await db('photos').where({ event_id: event.id }).pluck('download_count'))
        .map(Number).join(',');
      const logged = async () => Number((await db('access_logs')
        .where({ event_id: event.id, action: 'download' }).count('id as c').first()).c);
      for (let i = 0; i < 100 && (await counted() !== '1,1,1,1,1' || await logged() !== 1); i += 1) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(await counted()).toBe('1,1,1,1,1');
      // Only the first part writes the log line.
      expect(await logged()).toBe(1);
    });

    it('refuses a part the limit no longer covers and reports it on the status', async () => {
      twoPerPart();
      const { event, token } = await makeEvent({ limit: 5, photos: 5 });
      const jobToken = await prepare(event, token);
      await db('events').where({ id: event.id }).update({ download_limit: 1 });

      const state = await status(event, token, jobToken);
      expect(state.body.download_limit_reached).toMatchObject({ code: 'DOWNLOAD_LIMIT_REACHED' });
      expect((await fetchPart(event, token, jobToken, 1)).status).toBe(403);
      expect(await grantCount(event.id)).toBe(0);
    });

    it('two builds of the same content never share a storage key', async () => {
      twoPerPart();
      const { event } = await makeEvent({ photos: 5 });
      // A second replica: its own process state, the same table.
      const replica = new jobService.constructor();
      replica.partLimits = jobService.partLimits;

      const [a, b] = await Promise.all([
        jobService.createJob({ event, resolution: 'original', photoIds: null, accessLevel: 'client' }),
        replica.createJob({ event, resolution: 'original', photoIds: null, accessLevel: 'client' }),
      ]);
      expect(a.token).not.toBe(b.token);
      await Promise.all([jobService.liveBuilds.get(a.id), replica.liveBuilds.get(b.id)]);

      const rows = await db('download_jobs').whereIn('id', [a.id, b.id]);
      const keys = rows.flatMap((row) => jobService.partsOf(row).map((p) => p.zip_path));
      expect(keys).toHaveLength(6);
      expect(new Set(keys).size).toBe(6);
      for (const key of keys) expect(fs.existsSync(storedPath(key))).toBe(true);

      // In one process, a request that arrives while the build runs joins it.
      await db('download_jobs').where({ event_id: event.id }).del();
      const first = await jobService.createJob({ event, resolution: 'original', photoIds: null, accessLevel: 'client' });
      const joined = await jobService.createJob({ event, resolution: 'original', photoIds: null, accessLevel: 'client' });
      expect(joined.token).toBe(first.token);
      await jobService.liveBuilds.get(first.id);
    });

    it('is swept with all of its parts', async () => {
      twoPerPart();
      const { event, token } = await makeEvent({ photos: 5 });
      const jobToken = await prepare(event, token);
      const parts = jobService.partsOf(await db('download_jobs').where({ token: jobToken }).first());
      await db('download_jobs').where({ token: jobToken })
        .update({ expires_at: new Date(Date.now() - 1000).toISOString() });

      // Past its time, no part is handed out, swept or not.
      expect((await fetchPart(event, token, jobToken, 1)).status).toBe(410);
      await jobService.sweepExpired();
      for (const part of parts) expect(fs.existsSync(storedPath(part.zip_path))).toBe(false);
      expect(await db('download_jobs').where({ token: jobToken }).first()).toBeUndefined();
    });

    it('leaves no archive behind when the build fails after a part was stored', async () => {
      twoPerPart();
      const { event } = await makeEvent({ photos: 5 });
      const { getStorage } = require('../../src/services/storage');
      const storage = getStorage();
      const original = storage.putFromFile.bind(storage);
      const stored = [];
      const spy = jest.spyOn(storage, 'putFromFile').mockImplementation(async (key, file, ...rest) => {
        if (stored.length === 1) throw new Error('disk full');
        stored.push(key);
        return original(key, file, ...rest);
      });
      try {
        const job = await jobService.createJob({ event, resolution: 'original', photoIds: null, accessLevel: 'client' });
        await jobService.liveBuilds.get(job.id);
        const row = await db('download_jobs').where({ id: job.id }).first();
        expect(row.status).toBe('failed');
        expect(row.parts).toBeNull();
        expect(stored).toHaveLength(1);
        expect(fs.existsSync(storedPath(stored[0]))).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
