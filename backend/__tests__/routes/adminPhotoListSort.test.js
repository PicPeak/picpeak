/**
 * Sorting of the admin photo list, GET /api/admin/photos/:eventId/photos
 * (issue 1739).
 *
 *  - by name is natural order: JH9 before JH10, not 1, 10, 100, 2
 *  - by capture date uses the EXIF date and falls back to the upload date,
 *    across the storage classes SQLite keeps in photos.captured_at
 *  - by rating reads the rating; the filter bar offered it and the route
 *    ignored it
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-photolist-sort-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'photolist-sort-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-photolist-sort-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken,
} = require('../integration/helpers/crmDb');

const SLUG = 'photolist-sort-event';

describe('admin photo list sorting (issue 1739)', () => {
  let db; let cleanup; let app; let eventId; let token;

  // A managed upload stores captured_at as epoch milliseconds on SQLite (the
  // binding converts the Date photoProcessor hands it); jest cannot reproduce
  // that conversion, so write the integer production would have written.
  // PostgreSQL has one timestamp type and takes the ISO string.
  const managed = (iso) => (db.client.config.client === 'pg' ? iso : new Date(iso).getTime());

  const addPhoto = async (filename, fields = {}) => {
    const row = await db('photos').insert({
      event_id: eventId,
      filename,
      path: `${SLUG}/${filename}`,
      type: 'individual',
      uploaded_at: '2026-09-26 12:00:00',
      ...fields,
    }).returning('id');
    return row[0]?.id ?? row[0];
  };

  const list = async (query) => {
    const res = await request(app)
      .get(`/api/admin/photos/${eventId}/photos?${query}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body.photos;
  };
  const names = async (query) => (await list(query)).map((p) => p.filename);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);
    require('../../src/middleware/permissions').clearPermissionCache();

    const ev = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Photo List Sort',
      event_date: '2026-09-26',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'photolist-sort-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = ev[0]?.id ?? ev[0];

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    await db('photos').where('event_id', eventId).del();
  });

  describe('by name', () => {
    beforeEach(async () => {
      // Inserted out of order, so insertion order cannot pass for a sort.
      for (const name of ['JH60.jpg', 'JH9.jpg', 'JH100.jpg', 'JH1.jpg', 'JH10.jpg', 'JH2.jpg', 'JH59.jpg']) {
        await addPhoto(name);
      }
    });

    it('lists digit runs as numbers, ascending', async () => {
      expect(await names('sort=name&order=asc')).toEqual([
        'JH1.jpg', 'JH2.jpg', 'JH9.jpg', 'JH10.jpg', 'JH59.jpg', 'JH60.jpg', 'JH100.jpg',
      ]);
    });

    it('and descending', async () => {
      expect(await names('sort=name&order=desc')).toEqual([
        'JH100.jpg', 'JH60.jpg', 'JH59.jpg', 'JH10.jpg', 'JH9.jpg', 'JH2.jpg', 'JH1.jpg',
      ]);
    });

    it('does not split names on letter case', async () => {
      await db('photos').where('event_id', eventId).del();
      for (const name of ['b2.jpg', 'B10.jpg', 'a3.jpg', 'B1.jpg']) await addPhoto(name);
      expect(await names('sort=name&order=asc')).toEqual(['a3.jpg', 'B1.jpg', 'b2.jpg', 'B10.jpg']);
    });
  });

  describe('by capture date', () => {
    it('orders by the EXIF date across storage classes, upload date where there is none', async () => {
      await addPhoto('managed-2027.jpg', { captured_at: managed('2027-01-01T10:00:00.000Z') });
      await addPhoto('imported-2020.jpg', { captured_at: '2020-05-05T08:00:00.000Z' });
      await addPhoto('no-exif-2026.jpg', { captured_at: null, uploaded_at: '2026-09-26 12:00:00' });
      await addPhoto('managed-2019.jpg', { captured_at: managed('2019-03-03T09:00:00.000Z') });

      expect(await names('sort=capture_date&order=asc')).toEqual([
        'managed-2019.jpg', 'imported-2020.jpg', 'no-exif-2026.jpg', 'managed-2027.jpg',
      ]);
      expect(await names('sort=capture_date&order=desc')).toEqual([
        'managed-2027.jpg', 'no-exif-2026.jpg', 'imported-2020.jpg', 'managed-2019.jpg',
      ]);
    });
  });

  it('by rating puts the best rated first and unrated photos last', async () => {
    await addPhoto('unrated.jpg');
    await addPhoto('three.jpg', { average_rating: 3 });
    await addPhoto('five.jpg', { average_rating: 5 });
    expect(await names('sort=rating&order=desc')).toEqual(['five.jpg', 'three.jpg', 'unrated.jpg']);
  });

  it('breaks ties on id, so rows written in the same second keep one order', async () => {
    const ids = [];
    for (const name of ['c.jpg', 'a.jpg', 'b.jpg']) ids.push(await addPhoto(name));
    expect((await list('sort=date&order=asc')).map((p) => p.id)).toEqual(ids);
    expect((await list('sort=date&order=desc')).map((p) => p.id)).toEqual([...ids].reverse());
  });
});
