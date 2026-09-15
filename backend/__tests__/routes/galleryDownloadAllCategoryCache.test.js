/**
 * Download All and per-category download restrictions.
 *
 * The streamed archive leaves out photos in categories with downloads turned
 * off (#640), but guests of an event with no hidden photos were served the
 * prebuilt zip instead, and that archive holds every photo of the event. A
 * category's download switch therefore did nothing for anyone who pressed
 * Download All once the cache existed.
 */

const { Readable } = require('stream');

const CACHED_KEY = 'zips/prebuilt-download-all.zip';
const mockCachedBody = Buffer.from('PREBUILT-ZIP-WITH-EVERY-PHOTO');

const mockStorage = {
  kind: () => 'local',
  stat: jest.fn(async () => ({ size: 8 })),
  get: jest.fn(async (key) => Readable.from([key === CACHED_KEY ? mockCachedBody : Buffer.from('photo-bytes')])),
  getRange: jest.fn(),
  delete: jest.fn(async () => undefined),
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

process.env.JWT_SECRET = process.env.JWT_SECRET || 'download-all-category-secret';

describe('Download All with a download-restricted category', () => {
  let db; let cleanup; let app; let downloadZipService;
  let seq = 0;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);

  const createEvent = async (categoryAllowsDownloads) => {
    seq += 1;
    const slug = `download-all-cat-${seq}`;
    const id = unwrap(await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Download All ${seq}`,
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      share_token: `${slug}-share`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      allow_downloads: 1,
      created_at: new Date().toISOString(),
    }).returning('id'));
    const categoryId = unwrap(await db('photo_categories').insert({
      name: 'Private', slug: `private-${seq}`, event_id: id, is_global: false,
      allow_downloads: categoryAllowsDownloads,
    }).returning('id'));
    await db('photos').insert([
      { event_id: id, filename: 'open.jpg', path: `${slug}/open.jpg`, type: 'individual', uploaded_at: new Date().toISOString() },
      { event_id: id, filename: 'restricted.jpg', path: `${slug}/restricted.jpg`, type: 'individual', category_id: categoryId, uploaded_at: new Date().toISOString() },
    ]);
    return { id, slug };
  };

  const downloadAll = (event) => request(app)
    .get(`/api/gallery/${event.slug}/download-all`)
    .set('Authorization', `Bearer ${jwt.sign(
      { eventId: event.id, eventSlug: event.slug, type: 'gallery' },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' },
    )}`)
    .buffer(true)
    .parse((response, cb) => {
      const chunks = [];
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => cb(null, Buffer.concat(chunks)));
    });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    downloadZipService = require('../../src/services/downloadZipService');
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(() => {
    jest.restoreAllMocks();
    mockStorage.get.mockClear();
    jest.spyOn(downloadZipService, 'getZipInfo').mockResolvedValue({ key: CACHED_KEY, size: mockCachedBody.length });
    jest.spyOn(downloadZipService, 'generateZip').mockResolvedValue(undefined);
  });

  it('streams the filtered archive instead of the prebuilt zip', async () => {
    const event = await createEvent(false);

    const res = await downloadAll(event);

    expect(res.status).toBe(200);
    expect(downloadZipService.getZipInfo).not.toHaveBeenCalled();
    expect(mockStorage.get).not.toHaveBeenCalledWith(CACHED_KEY);
    expect(res.body.equals(mockCachedBody)).toBe(false);
    // The restricted photo is never read for the archive.
    const readKeys = mockStorage.get.mock.calls.map(([key]) => key);
    expect(readKeys.some((key) => key.endsWith('restricted.jpg'))).toBe(false);
    expect(readKeys.some((key) => key.endsWith('open.jpg'))).toBe(true);
  });

  it('still serves the prebuilt zip when every category allows downloads', async () => {
    const event = await createEvent(true);

    const res = await downloadAll(event);

    expect(res.status).toBe(200);
    expect(downloadZipService.getZipInfo).toHaveBeenCalled();
    expect(res.body.equals(mockCachedBody)).toBe(true);
  });
});
