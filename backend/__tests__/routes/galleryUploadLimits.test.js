/**
 * Guest uploads and the limits the photographer set.
 *
 * POST /gallery/:eventId/upload never read events.photo_cap (only the admin
 * batch upload did), so a public event with guest uploads on grew past its
 * limit without end. It also filed a photo under any category id the guest
 * sent, including another event's, and when an upload failed after the file
 * was stored (a size mismatch, or an insert refused by the category foreign
 * key on Postgres) the stored object stayed behind with no photo row.
 */

const fs = require('fs');

const mockSizes = new Map();
const mockStatOverride = { size: null };
const mockStorage = {
  kind: () => 'local',
  putFromFile: jest.fn(async (key, localPath) => { mockSizes.set(key, fs.statSync(localPath).size); }),
  stat: jest.fn(async (key) => (mockStatOverride.size !== null
    ? { size: mockStatOverride.size }
    : { size: mockSizes.get(key) })),
  delete: jest.fn(async (key) => { mockSizes.delete(key); }),
  exists: jest.fn(async () => true),
};

jest.mock('../../src/services/storage', () => ({
  getStorage: () => mockStorage,
  initStorage: async () => mockStorage,
}));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'gallery-upload-limits-secret';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

describe('guest upload limits', () => {
  let db; let cleanup; let app;
  let seq = 0;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);

  const createEvent = async (extra = {}) => {
    seq += 1;
    const slug = `upload-limits-${seq}`;
    const id = unwrap(await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Upload Limits ${seq}`,
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      allow_user_uploads: 1,
      created_at: new Date().toISOString(),
      ...extra,
    }).returning('id'));
    return { id, slug };
  };

  const addPhotos = async (eventId, count) => {
    for (let i = 0; i < count; i += 1) {
      await db('photos').insert({
        event_id: eventId,
        filename: `existing-${eventId}-${i}.jpg`,
        path: `events/existing-${eventId}-${i}.jpg`,
        type: 'individual',
        uploaded_at: new Date().toISOString(),
      });
    }
  };

  const photoCount = async (eventId) => Number((await db('photos').where({ event_id: eventId }).count('id as n').first()).n);

  const upload = (event, { files = ['guest.jpg'], categoryId } = {}) => {
    const token = jwt.sign(
      { eventId: event.id, eventSlug: event.slug, type: 'gallery' },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' },
    );
    let req = request(app)
      .post(`/api/gallery/${event.id}/upload`)
      .set('Authorization', `Bearer ${token}`);
    if (categoryId !== undefined) req = req.field('category_id', String(categoryId));
    for (const name of files) req = req.attach('photos', JPEG, { filename: name, contentType: 'image/jpeg' });
    return req;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(() => {
    mockStatOverride.size = null;
    mockSizes.clear();
    jest.clearAllMocks();
  });

  describe('photo cap', () => {
    it('refuses a guest upload once the event is at its cap, before storing anything', async () => {
      const event = await createEvent({ photo_cap: 2 });
      await addPhotos(event.id, 2);

      const res = await upload(event);

      expect(res.status).toBe(409);
      expect(res.body).toEqual(expect.objectContaining({ code: 'PHOTO_CAP_REACHED', limit: 2 }));
      expect(mockStorage.putFromFile).not.toHaveBeenCalled();
      expect(await photoCount(event.id)).toBe(2);
    });

    it('queues only the files that fit under the cap and refuses the rest', async () => {
      const event = await createEvent({ photo_cap: 3 });
      await addPhotos(event.id, 2);

      const res = await upload(event, { files: ['one.jpg', 'two.jpg'] });

      expect(res.status).toBe(202);
      expect(res.body.count).toBe(1);
      expect(res.body.errors).toEqual([expect.objectContaining({ code: 'PHOTO_CAP_REACHED', limit: 3 })]);
      expect(mockStorage.putFromFile).toHaveBeenCalledTimes(1);
      expect(await photoCount(event.id)).toBe(3);
    });

    it('lets only one of two simultaneous uploads take the last slot', async () => {
      const event = await createEvent({ photo_cap: 3 });
      await addPhotos(event.id, 2);

      const results = await Promise.all([upload(event, { files: ['a.jpg'] }), upload(event, { files: ['b.jpg'] })]);

      expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
      expect(await photoCount(event.id)).toBe(3);
      // The refused upload leaves no stored object behind.
      expect(mockSizes.size).toBe(mockStorage.putFromFile.mock.calls.length - mockStorage.delete.mock.calls.length);
    });

    it('does not limit an event without a cap', async () => {
      const event = await createEvent();
      await addPhotos(event.id, 3);

      const res = await upload(event, { files: ['free.jpg'] });

      expect(res.status).toBe(202);
      expect(res.body.count).toBe(1);
    });
  });

  describe('category scope', () => {
    it('refuses another event\'s category and stores nothing', async () => {
      const event = await createEvent();
      const other = await createEvent();
      const foreign = unwrap(await db('photo_categories').insert({
        name: 'Foreign', slug: `foreign-${other.id}`, event_id: other.id, is_global: false,
      }).returning('id'));

      const res = await upload(event, { categoryId: foreign });

      expect(res.status).toBe(400);
      expect(mockStorage.putFromFile).not.toHaveBeenCalled();
      expect(await photoCount(event.id)).toBe(0);
    });

    it('answers a failed category lookup with an error instead of leaving the request hanging', async () => {
      // multer does not await the callback that resolves the category, so a
      // rejected lookup outside its try block became an unhandled rejection:
      // the request never answered and the process could exit.
      const event = await createEvent();
      const categoryScope = require('../../src/utils/categoryScope');
      const spy = jest.spyOn(categoryScope, 'findScopedCategory').mockRejectedValueOnce(new Error('lookup failed'));
      try {
        const res = await upload(event, { categoryId: 5 }).timeout({ response: 5000 });
        expect(res.status).toBe(500);
      } finally {
        spy.mockRestore();
      }
      expect(mockStorage.putFromFile).not.toHaveBeenCalled();
      expect(await photoCount(event.id)).toBe(0);
    }, 15000);

    it('refuses a category id beyond the integer range instead of failing the lookup', async () => {
      // Postgres rejects such an id in the query itself; the callback multer
      // runs is not awaited, so that rejection must never escape the route.
      const event = await createEvent();

      const res = await upload(event, { categoryId: '2147483648' });

      expect(res.status).toBe(400);
      expect(mockStorage.putFromFile).not.toHaveBeenCalled();
      expect(await photoCount(event.id)).toBe(0);
    });

    it('files the photo under the event\'s own category', async () => {
      const event = await createEvent();
      const own = unwrap(await db('photo_categories').insert({
        name: 'Own', slug: `own-${event.id}`, event_id: event.id, is_global: false,
      }).returning('id'));

      const res = await upload(event, { categoryId: own });

      expect(res.status).toBe(202);
      const row = await db('photos').where({ event_id: event.id }).first();
      expect(row.category_id).toBe(own);
    });
  });

  it('removes the stored object when the upload fails after storing it', async () => {
    const event = await createEvent();
    mockStatOverride.size = 1; // not the uploaded size: the queue refuses the file

    const res = await upload(event, { files: ['broken.jpg'] });

    expect(res.status).toBe(202);
    expect(res.body.count).toBe(0);
    const storedKey = mockStorage.putFromFile.mock.calls[0][0];
    expect(mockStorage.delete).toHaveBeenCalledWith(storedKey);
    expect(await photoCount(event.id)).toBe(0);
  });
});
