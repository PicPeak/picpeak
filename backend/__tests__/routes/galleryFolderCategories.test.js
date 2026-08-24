/**
 * Gallery folders reach the guest payload (#1160).
 *
 * `is_folder` is what tells the frontend a category CONTAINS its photos rather
 * than filtering them. The category block in gallery.js selects an explicit
 * column list (not `c.*`), so a new column that isn't added there is silently
 * dropped — every folder would render as a plain filter and the root grid would
 * still show the foldered photos. These assertions pin that contract.
 *
 * Also pins the SQLite side: the engine stores 0/1, so a strict `=== true`
 * consumer would see every folder as a filter (the #1028 class of bug).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-folders-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'folders-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-folders-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const SLUG = 'folders-gallery';

describe('folder categories in the gallery payload (#1160)', () => {
  let db; let cleanup; let app; let eventId; let folderId; let filterId;

  async function getCategories() {
    const res = await request(app).get(`/api/gallery/${SLUG}/photos`);
    expect(res.status).toBe(200);
    return res.body.categories;
  }

  async function addPhoto(filename, categoryId) {
    const row = await db('photos').insert({
      event_id: eventId,
      filename,
      path: `${SLUG}/${filename}`,
      type: 'individual',
      category_id: categoryId,
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    return row[0]?.id ?? row[0];
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const ev = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Folders',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/s`,
      share_token: 'folders-share',
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      require_password: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = ev[0]?.id ?? ev[0];

    const folder = await db('photo_categories').insert({
      name: 'Selects', slug: 'selects', is_global: 0, event_id: eventId, is_folder: 1,
    }).returning('id');
    folderId = folder[0]?.id ?? folder[0];

    const filter = await db('photo_categories').insert({
      name: 'Ceremony', slug: 'ceremony', is_global: 0, event_id: eventId, is_folder: 0,
    }).returning('id');
    filterId = filter[0]?.id ?? filter[0];

    await addPhoto('in-folder.jpg', folderId);
    await addPhoto('in-filter.jpg', filterId);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  test('the engine under test stores booleans as 0/1', async () => {
    expect(['sqlite3', 'better-sqlite3']).toContain(db.client.config.client);
    const row = await db('photo_categories').where('id', folderId).first('is_folder');
    expect(row.is_folder).toBe(1);
  });

  test('a folder category is reported with is_folder true', async () => {
    const folder = (await getCategories()).find((c) => c.id === folderId);
    expect(folder).toBeDefined();
    expect(folder.is_folder).toBe(true);
  });

  test('a plain category keeps filtering — is_folder is false, not undefined', async () => {
    const filter = (await getCategories()).find((c) => c.id === filterId);
    expect(filter.is_folder).toBe(false);
  });

  test('a category predating the column defaults to filtering, never folder', async () => {
    const legacy = await db('photo_categories').insert({
      name: 'Legacy', slug: 'legacy', is_global: 0, event_id: eventId,
    }).returning('id');
    const legacyId = legacy[0]?.id ?? legacy[0];
    await addPhoto('legacy.jpg', legacyId);

    const found = (await getCategories()).find((c) => c.id === legacyId);
    expect(found.is_folder).toBe(false);
  });

  test('folders are not an access boundary — the photo is still in the payload', async () => {
    // Containment is a rendering rule, not authorisation. If this ever starts
    // failing, folders have silently become a security feature they are not.
    const res = await request(app).get(`/api/gallery/${SLUG}/photos`);
    expect(res.body.photos.some((p) => p.filename === 'in-folder.jpg')).toBe(true);
  });
});
