/**
 * Issue 2139: a HEAD probe (browser, download manager, link previewer) of a
 * bulk download is not a download. It answers the headers and counts nothing:
 * no photo download_count, no access_logs row, no gallery_downloaded entry.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-head-probe-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'head-probe-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-head-probe-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const SLUG = 'head-probe-event';
const ZIP_BYTES = Buffer.from('PK-head-probe');

describe('HEAD probes of bulk downloads count nothing (issue 2139)', () => {
  let db;
  let cleanup;
  let app;
  let eventId;
  let photoIds;

  const galleryToken = (extra = {}) => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery', ...extra },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  const downloadCounts = async () => (await db('photos').whereIn('id', photoIds).orderBy('id').select('download_count'))
    .map((p) => Number(p.download_count || 0));
  const activityCount = async () => Number((await db('activity_logs')
    .where({ event_id: eventId, activity_type: 'gallery_downloaded' }).count('id as c').first()).c);
  const accessLogCount = async () => Number((await db('access_logs')
    .where({ event_id: eventId }).count('id as c').first()).c);
  // The counters run on 'finish' or fire-and-forget, after supertest resolved.
  const settle = () => new Promise((r) => setTimeout(r, 400));

  async function makeReadyJob(tokenChar) {
    const jobs = require('../../src/services/downloadJobService');
    const jobToken = tokenChar.repeat(64);
    const zipKey = `download-jobs/${SLUG}-${tokenChar}.zip`;
    await fs.promises.mkdir(path.join(process.env.STORAGE_PATH, 'download-jobs'), { recursive: true });
    await fs.promises.writeFile(path.join(process.env.STORAGE_PATH, zipKey), ZIP_BYTES);
    const scope = jobs.visibilityScopeFor('guest');
    await db('download_jobs').insert({
      token: jobToken,
      event_id: eventId,
      resolution: 'original',
      photo_ids: JSON.stringify(photoIds),
      delivered_photo_ids: JSON.stringify(photoIds),
      // The real identity, so isStillDeliverable lets the archive through.
      dedup_key: jobs.dedupKey(eventId, 'original', photoIds, null, scope),
      status: 'ready',
      zip_path: zipKey,
      photo_count: photoIds.length,
      visibility_scope: scope,
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      created_at: new Date().toISOString(),
    });
    return jobToken;
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const inserted = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'HEAD Probe Test',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'head-probe-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      allow_downloads: 1,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = inserted[0]?.id ?? inserted[0];

    const photoDir = path.join(process.env.STORAGE_PATH, 'events/active', SLUG);
    fs.mkdirSync(photoDir, { recursive: true });
    photoIds = [];
    for (let i = 0; i < 2; i++) {
      const filename = `photo-${i}.jpg`;
      fs.writeFileSync(path.join(photoDir, filename), Buffer.from(`fake-jpeg-bytes-${i}`));
      const p = await db('photos').insert({
        event_id: eventId,
        filename,
        path: `${SLUG}/${filename}`,
        type: 'individual',
        uploaded_at: new Date().toISOString(),
      }).returning('id');
      photoIds.push(p[0]?.id ?? p[0]);
    }

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    await db('photos').where('event_id', eventId).update({ download_count: 0 });
    await db('access_logs').where('event_id', eventId).del();
    await db('activity_logs').where('event_id', eventId).del();
  });

  describe('download-jobs/:token/file', () => {
    it('a HEAD answers the headers and counts nothing', async () => {
      const jobToken = await makeReadyJob('1');
      const res = await request(app)
        .head(`/api/gallery/${SLUG}/download-jobs/${jobToken}/file`)
        .set('Authorization', `Bearer ${galleryToken()}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/zip');
      expect(res.headers['content-length']).toBe(String(ZIP_BYTES.length));
      expect(res.headers['content-disposition']).toBe(`attachment; filename="${SLUG}-original.zip"`);
      await settle();
      expect(await downloadCounts()).toEqual([0, 0]);
      expect(await activityCount()).toBe(0);
      expect(await accessLogCount()).toBe(0);
    });

    it('a GET still counts once', async () => {
      const jobToken = await makeReadyJob('2');
      const res = await request(app)
        .get(`/api/gallery/${SLUG}/download-jobs/${jobToken}/file`)
        .set('Authorization', `Bearer ${galleryToken()}`);
      expect(res.status).toBe(200);
      await settle();
      expect(await downloadCounts()).toEqual([1, 1]);
      expect(await activityCount()).toBe(1);
      expect(await accessLogCount()).toBe(1);
    });
  });

  describe('download-all', () => {
    it('a HEAD of the streamed archive counts nothing', async () => {
      // A client always streams, never the prebuilt cache.
      const res = await request(app)
        .head(`/api/gallery/${SLUG}/download-all`)
        .set('Authorization', `Bearer ${galleryToken({ accessLevel: 'client' })}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/zip');
      expect(res.headers['content-disposition']).toBe(`attachment; filename="${SLUG}.zip"`);
      await settle();
      expect(await downloadCounts()).toEqual([0, 0]);
      expect(await activityCount()).toBe(0);
      expect(await accessLogCount()).toBe(0);
    });

    it('a HEAD of the prebuilt archive counts nothing', async () => {
      const built = await require('../../src/services/downloadZipService').generateZip(eventId);
      expect(built.success).toBe(true);
      const res = await request(app)
        .head(`/api/gallery/${SLUG}/download-all`)
        .set('Authorization', `Bearer ${galleryToken()}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/zip');
      expect(res.headers['content-length']).toBe(String(built.size));
      expect(res.headers['content-disposition']).toBe(`attachment; filename="${SLUG}.zip"`);
      await settle();
      expect(await downloadCounts()).toEqual([0, 0]);
      expect(await activityCount()).toBe(0);
      expect(await accessLogCount()).toBe(0);
    });

    it('a GET of the prebuilt archive still counts once', async () => {
      const res = await request(app)
        .get(`/api/gallery/${SLUG}/download-all`)
        .set('Authorization', `Bearer ${galleryToken()}`);
      expect(res.status).toBe(200);
      await settle();
      expect(await downloadCounts()).toEqual([1, 1]);
      expect(await activityCount()).toBe(1);
      expect(await accessLogCount()).toBe(1);
    });
  });
});
