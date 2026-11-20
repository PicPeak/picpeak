/**
 * Views and downloads per guest in the admin guests list (issue 2503).
 *
 * Galleries that ask guests who they are before downloading log views and
 * downloads under the guest (access_logs.guest_id). The admin list shows the
 * counts per guest, the detail lists the downloads, the "export all" CSV
 * carries a summary row per guest, and erasing or merging a guest takes the
 * rows along: anonymised on erase, moved to the survivor on merge.
 */

const request = require('supertest');
const express = require('express');
const StreamZip = require('node-stream-zip');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('guest views and downloads in the admin (issue 2503)', () => {
  let db; let cleanup; let app; let eventId; let photoA; let photoB;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);

  const addGuest = async (name, email) => unwrap(await db('gallery_guests').insert({
    event_id: eventId, name, email,
    identifier: `id-${name}-${Math.random()}`,
    created_at: new Date().toISOString(),
    last_seen_at: '2026-11-01T10:00:00.000Z',
    is_deleted: false,
  }).returning('id'));

  const log = (guestId, action, photoId = null, timestamp = '2026-11-14T09:30:00.000Z') => db('access_logs').insert({
    event_id: eventId, ip_address: '127.0.0.1', user_agent: 'jest', action,
    photo_id: photoId == null ? null : String(photoId), guest_id: guestId, timestamp,
  });

  const listGuests = async () => {
    const res = await request(app).get(`/api/admin/events/${eventId}/guests`);
    expect(res.status).toBe(200);
    return res.body.guests;
  };

  beforeAll(async () => {
    jest.resetModules();
    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester' }; next(); },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      requirePermission: () => (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/middleware/ownership', () => ({
      requireEventOwnership: (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/utils/logger', () => ({
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));

    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    eventId = unwrap(await db('events').insert({
      slug: 'guest-activity', event_type: 'wedding', event_name: 'Guest Activity',
      event_date: '2026-08-01', host_email: 'h@example.com', admin_email: 'a@example.com',
      password_hash: 'x', share_link: '/gallery/guest-activity/share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id'));
    const addPhoto = async (filename, original) => unwrap(await db('photos').insert({
      event_id: eventId, filename, original_filename: original,
      path: `guest-activity/${filename}`, type: 'individual',
      uploaded_at: new Date().toISOString(),
    }).returning('id'));
    photoA = await addPhoto('a.jpg', 'IMG_0001.jpg');
    photoB = await addPhoto('b.jpg', null);

    app = express();
    app.use(express.json());
    app.use('/api/admin', require('../../src/routes/adminGuests'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    await db('access_logs').where({ event_id: eventId }).del();
    await db('gallery_guests').where({ event_id: eventId }).del();
  });

  it('counts views, downloaded photos and zips per guest', async () => {
    const anna = await addGuest('Anna', 'anna@example.com');
    const ben = await addGuest('Ben', 'ben@example.com');
    await log(anna, 'view');
    await log(anna, 'view');
    await log(anna, 'download', photoA);
    await log(anna, 'download', photoA); // the same photo again: one photo
    await log(anna, 'download', photoB);
    await log(anna, 'download_all');
    await log(anna, 'download'); // a prepared archive
    await log(anna, 'download_selected', null, '2026-11-15T08:00:00.000Z');
    // Anonymous activity stays out of every guest's numbers.
    await log(null, 'view');
    await log(null, 'download', photoA);

    const guests = await listGuests();
    const a = guests.find((g) => g.id === anna);
    const b = guests.find((g) => g.id === ben);
    expect(a.stats).toMatchObject({ views: 2, downloads: 2, zip_downloads: 3 });
    expect(a.last_activity_at).toBe('2026-11-15T08:00:00.000Z');
    expect(b.stats).toMatchObject({ views: 0, downloads: 0, zip_downloads: 0 });
    expect(b.last_activity_at).toBeNull();
  });

  it('lists a guest\'s downloads with file names and dates in the detail', async () => {
    const anna = await addGuest('Anna', 'anna@example.com');
    await log(anna, 'view');
    await log(anna, 'download', photoA, '2026-11-14T09:00:00.000Z');
    await log(anna, 'download_all', null, '2026-11-14T10:00:00.000Z');

    const res = await request(app).get(`/api/admin/events/${eventId}/guests/${anna}`);
    expect(res.status).toBe(200);
    expect(res.body.activity).toMatchObject({ views: 1, photo_downloads: 1, zip_downloads: 1 });
    expect(res.body.activity.downloads).toEqual([
      { kind: 'all', photo_id: null, filename: null, at: '2026-11-14T10:00:00.000Z' },
      { kind: 'photo', photo_id: photoA, filename: 'IMG_0001.jpg', at: '2026-11-14T09:00:00.000Z' },
    ]);
  });

  it('puts a summary row per guest into the CSV export', async () => {
    const anna = await addGuest('Anna', 'anna@example.com');
    await addGuest('=Ben', null);
    await log(anna, 'view');
    await log(anna, 'download', photoA);
    await log(anna, 'download_all', null, '2026-11-14T10:00:00.000Z');

    const res = await request(app)
      .get(`/api/admin/events/${eventId}/guests/export-all?format=csv`)
      .buffer(true)
      .parse((r, cb) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(res.status).toBe(200);

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guest-activity-')), 'export.zip');
    fs.writeFileSync(file, res.body);
    const zip = new StreamZip.async({ file });
    try {
      const csv = (await zip.entryData('guest-activity.summary.csv')).toString('utf8').split('\n');
      expect(csv[0]).toBe('name,email,views,photo_downloads,zip_downloads,likes,favorites,last_active');
      expect(csv).toContain('Anna,anna@example.com,1,1,1,0,0,2026-11-14T10:00:00.000Z');
      // Formula-neutralised like every other cell of the guest exports.
      expect(csv.find((line) => line.includes('Ben'))).toMatch(/^'=Ben,,0,0,0,0,0,/);
    } finally {
      await zip.close();
    }
  });

  it('anonymises the guest\'s rows when the admin removes them, keeping the totals', async () => {
    const anna = await addGuest('Anna', 'anna@example.com');
    await log(anna, 'view');
    await log(anna, 'download', photoA);

    const res = await request(app).delete(`/api/admin/events/${eventId}/guests/${anna}`);
    expect(res.status).toBe(200);

    expect(await db('access_logs').where({ guest_id: anna })).toHaveLength(0);
    expect(await db('access_logs').where({ event_id: eventId })).toHaveLength(2);
  });

  it('moves the merged guests\' rows to the survivor', async () => {
    const keep = await addGuest('Anna', 'anna@example.com');
    const dupe = await addGuest('Anna', 'anna@example.com');
    await log(keep, 'view');
    await log(dupe, 'download', photoA);

    const res = await request(app)
      .post(`/api/admin/events/${eventId}/guests/${keep}/merge`)
      .send({ mergeIds: [dupe] });
    expect(res.status).toBe(200);

    const survivor = (await listGuests()).find((g) => g.id === keep);
    expect(survivor.stats).toMatchObject({ views: 1, downloads: 1 });
    expect(await db('access_logs').where({ guest_id: dupe })).toHaveLength(0);
  });
});
