/**
 * Blurred tile placeholders (issue 1733, B1).
 *
 * Pins the contract:
 *  - migration 292 adds photos.thumb_hash and seeds the job row, and re-runs
 *  - the worker writes the hash of the thumbnail it generates
 *  - a replacement replaces the hash with the new image's
 *  - the guest and the admin photo list carry `thumb_hash`
 *  - the backfill reads thumbnails (the originals are deleted in the test),
 *    fills only rows without a hash, counts an unreadable thumbnail as failed
 *    and leaves it a candidate
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

process.env.JWT_SECRET = process.env.JWT_SECRET || 'thumb-hash-test-secret';

describe('Tile placeholders (issue 1733)', () => {
  let db;
  let cleanup;
  let app;
  let adminToken;
  let orangeJpeg;
  let blueJpeg;
  let slugCounter = 0;

  const admin = (req) => req.set('Cookie', [`admin_token=${adminToken}`]).set('Authorization', `Bearer ${adminToken}`);
  const storagePath = (...parts) => path.join(process.env.STORAGE_PATH, ...parts);

  async function makeEvent() {
    slugCounter += 1;
    const slug = `thumb-hash-test-${slugCounter}`;
    const inserted = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Placeholder Test ${slugCounter}`,
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      share_token: `thumb-hash-share-${slugCounter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    const id = inserted[0]?.id ?? inserted[0];
    await fs.promises.mkdir(storagePath('events', 'active', slug), { recursive: true });
    return db('events').where({ id }).first();
  }

  async function addPhoto(event, fields = {}, bytes = orangeJpeg) {
    const filename = `p-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
    await fs.promises.writeFile(storagePath('events', 'active', event.slug, filename), bytes);
    const r = await db('photos').insert({
      event_id: event.id,
      filename,
      path: `${event.slug}/${filename}`,
      type: 'individual',
      media_type: 'image',
      mime_type: 'image/jpeg',
      size_bytes: bytes.length,
      uploaded_at: new Date().toISOString(),
      ...fields,
    }).returning('id');
    return r[0]?.id ?? r[0];
  }

  // A row as a pre-292 library has it: a thumbnail in storage, no hash.
  async function addLegacyPhoto(event, bytes = orangeJpeg) {
    const id = await addPhoto(event, { processing_status: 'complete' }, bytes);
    const key = `thumbnails/thumb_legacy_${id}.jpg`;
    await fs.promises.mkdir(storagePath('thumbnails'), { recursive: true });
    await fs.promises.writeFile(storagePath(key), bytes);
    await db('photos').where({ id }).update({ thumbnail_path: key });
    return id;
  }

  // The average colour a hash carries, 0-255 per channel.
  function averageOf(base64) {
    const hash = Buffer.from(base64, 'base64');
    const header = hash[0] | (hash[1] << 8) | (hash[2] << 16);
    const l = (header & 63) / 63;
    const p = ((header >> 6) & 63) / 31.5 - 1;
    const q = ((header >> 12) & 63) / 31.5 - 1;
    const b = l - 2 / 3 * p;
    const r = (3 * l - b + q) / 2;
    return { r: r * 255, g: (r - q) * 255, b: b * 255 };
  }

  async function runBackfill() {
    const res = await admin(request(app).post('/api/admin/photos/repair-thumb-hashes'));
    expect(res.status).toBe(200);
    const deadline = Date.now() + 15000;
    let state;
    do {
      // eslint-disable-next-line no-await-in-loop
      state = (await admin(request(app).get('/api/admin/photos/repair-thumb-hashes/status'))).body;
      if (!state.isRunning) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 100));
    } while (Date.now() < deadline);
    expect(state.isRunning).toBe(false);
    return { started: res.body, state };
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    orangeJpeg = await sharp({ create: { width: 60, height: 40, channels: 3, background: { r: 220, g: 120, b: 20 } } }).jpeg().toBuffer();
    blueJpeg = await sharp({ create: { width: 40, height: 60, channels: 3, background: { r: 20, g: 60, b: 220 } } }).jpeg().toBuffer();

    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const [rootId] = await db('admin_users').insert({
      username: 'thumb-hash-admin',
      email: 'thumb-hash-admin@example.com',
      password_hash: await bcrypt.hash('ThumbHash123', 4),
      role_id: superRole.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id').then((r) => [r[0]?.id || r[0]]);
    adminToken = jwt.sign(
      { id: rootId, username: 'thumb-hash-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' }
    );

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/admin/photos', require('../../src/routes/adminPhotoDimensions'));
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
  }, 120000);

  afterAll(async () => {
    await require('../../src/services/isolatedSharp').shutdown();
    if (cleanup) await cleanup();
  });

  it('migration 292 adds the column and the job row, and re-runs cleanly', async () => {
    const migration = require('../../migrations/core/292_photo_thumb_hash');
    expect(await db.schema.hasColumn('photos', 'thumb_hash')).toBe(true);
    await migration.up(db);
    expect(await db('maintenance_jobs').where({ job_name: 'photo_thumb_hash_backfill' })).toHaveLength(1);
  });

  it('the worker stores the hash of the thumbnail it generates', async () => {
    const { processPhoto } = require('../../src/services/photoProcessor');
    const event = await makeEvent();
    const id = await addPhoto(event, { processing_status: 'pending' });

    await processPhoto(id);

    const row = await db('photos').where({ id }).first();
    expect(row.thumbnail_path).toBeTruthy();
    expect(row.thumb_hash).toMatch(/^[A-Za-z0-9+/]{20,36}={0,2}$/);
    const colour = averageOf(row.thumb_hash);
    expect(Math.abs(colour.r - 220)).toBeLessThan(16);
    expect(Math.abs(colour.b - 20)).toBeLessThan(16);
  }, 30000);

  it('a replacement replaces the hash', async () => {
    const { replacePhoto } = require('../../src/services/photoReplacementService');
    const event = await makeEvent();
    const id = await addPhoto(event, { thumb_hash: 'c3RhbGU=' });
    const temp = storagePath(`replace-${id}.jpg`);
    await fs.promises.writeFile(temp, blueJpeg);

    const existing = await db('photos').where({ id }).first();
    const result = await replacePhoto(existing, temp, { originalFilename: 'new.jpg', mimeType: 'image/jpeg', event });
    expect(result.success).toBe(true);

    const row = await db('photos').where({ id }).first();
    expect(row.thumb_hash).not.toBe('c3RhbGU=');
    expect(averageOf(row.thumb_hash).b).toBeGreaterThan(180);
  }, 30000);

  it('the guest and the admin photo list carry thumb_hash', async () => {
    const event = await makeEvent();
    const hashed = await addPhoto(event, { processing_status: 'complete', thumb_hash: 'HwgKPZpgh3dwh3eHdXh2eKCACPeH' });
    const plain = await addPhoto(event, { processing_status: 'complete' });
    const galleryToken = jwt.sign(
      { eventId: event.id, eventSlug: event.slug, type: 'gallery' },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' }
    );

    const guest = await request(app)
      .get(`/api/gallery/${event.slug}/photos`)
      .set('Authorization', `Bearer ${galleryToken}`);
    expect(guest.status).toBe(200);
    const guestById = Object.fromEntries(guest.body.photos.map((p) => [p.id, p]));
    expect(guestById[hashed].thumb_hash).toBe('HwgKPZpgh3dwh3eHdXh2eKCACPeH');
    expect(guestById[plain].thumb_hash).toBeNull();

    const list = await admin(request(app).get(`/api/admin/photos/${event.id}/photos`));
    expect(list.status).toBe(200);
    const adminById = Object.fromEntries(list.body.photos.map((p) => [p.id, p]));
    expect(adminById[hashed].thumb_hash).toBe('HwgKPZpgh3dwh3eHdXh2eKCACPeH');
    expect(adminById[plain].thumb_hash).toBeNull();
  });

  it('the backfill hashes thumbnails without touching originals', async () => {
    // The counts below are library-wide.
    await db('photos').del();
    const event = await makeEvent();
    const orange = await addLegacyPhoto(event, orangeJpeg);
    const blue = await addLegacyPhoto(event, blueJpeg);
    const kept = await addLegacyPhoto(event, orangeJpeg);
    await db('photos').where({ id: kept }).update({ thumb_hash: 'a2VwdA==' });
    const broken = await addLegacyPhoto(event, orangeJpeg);
    await fs.promises.unlink(storagePath(`thumbnails/thumb_legacy_${broken}.jpg`));
    const noThumbnail = await addPhoto(event, { processing_status: 'complete' });
    // Thumbnails only: with the originals gone the run must still succeed.
    await fs.promises.rm(storagePath('events', 'active', event.slug), { recursive: true });

    const before = (await admin(request(app).get('/api/admin/photos/repair-thumb-hashes/status'))).body;
    expect(before).toMatchObject({ total: 4, withPlaceholder: 1, withoutPlaceholder: 3, isRunning: false });

    const { started, state } = await runBackfill();
    expect(started.count).toBe(3);
    expect(state.lastResult).toMatchObject({ success: 2, failed: 1, skipped: 0 });
    expect(state).toMatchObject({ total: 4, withPlaceholder: 3, withoutPlaceholder: 1 });

    expect(averageOf((await db('photos').where({ id: orange }).first()).thumb_hash).r).toBeGreaterThan(180);
    expect(averageOf((await db('photos').where({ id: blue }).first()).thumb_hash).b).toBeGreaterThan(180);
    expect((await db('photos').where({ id: kept }).first()).thumb_hash).toBe('a2VwdA==');
    expect((await db('photos').where({ id: broken }).first()).thumb_hash).toBeNull();
    expect((await db('photos').where({ id: noThumbnail }).first()).thumb_hash).toBeNull();

    // Resumable: the unreadable one is still a candidate once it is back.
    await fs.promises.writeFile(storagePath(`thumbnails/thumb_legacy_${broken}.jpg`), blueJpeg);
    const second = await runBackfill();
    expect(second.started.count).toBe(1);
    expect(second.state.lastResult).toMatchObject({ success: 1, failed: 0 });
    expect((await db('photos').where({ id: broken }).first()).thumb_hash).toBeTruthy();

    const done = await admin(request(app).post('/api/admin/photos/repair-thumb-hashes'));
    expect(done.body.count).toBe(0);
  }, 60000);

  it('the backfill needs system.manage', async () => {
    const res = await request(app).post('/api/admin/photos/repair-thumb-hashes');
    expect(res.status).toBe(401);
  });
});
