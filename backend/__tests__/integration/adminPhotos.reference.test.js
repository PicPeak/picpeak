const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');

describe('Admin photos in reference mode', () => {
  let tmpDir;
  let storagePath;
  let db;
  let app;
  let categoryId;

  const resetModules = () => {
    jest.resetModules();
    jest.clearAllMocks();
  };

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-admin-photos-'));
    storagePath = path.join(tmpDir, 'storage');
    await fs.promises.mkdir(storagePath, { recursive: true });

    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'photo_sharing_test.db');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    try {
      await fs.promises.unlink(process.env.TEST_DATABASE_PATH);
    } catch (_) {
      /* ignore */
    }
    process.env.STORAGE_PATH = storagePath;

    resetModules();

    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => {
        req.admin = { id: 1, username: 'tester' };
        next();
      }
    }));

    // The routes gained requirePermission() after this fixture was written.
    // It resolves the caller's role through admin_users/roles, which this
    // minimal schema does not create, so every request died in the RBAC
    // lookup before reaching the handler. RBAC is not what this suite is
    // about — stub it out the same way adminAuth already is.
    jest.doMock('../../src/middleware/permissions', () => ({
      requirePermission: () => (_req, _res, next) => next()
    }));

    jest.doMock('../../src/services/imageProcessor', () => ({
      generateThumbnail: jest.fn().mockResolvedValue('thumbnails/mock-thumb.jpg'),
      ensureThumbnail: jest.fn()
    }));

    jest.doMock('../../src/middleware/uploadValidation', () => ({
      validateUploadedFiles: (_req, _res, next) => next()
    }));

    jest.doMock('../../src/utils/fileSecurityUtils', () => {
      const actual = jest.requireActual('../../src/utils/fileSecurityUtils');
      return {
        ...actual,
        validateFileType: () => true,
        createFileUploadValidator: () => (_req, _res, next) => next()
      };
    });

    jest.doMock('../../src/utils/logger', () => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    }));

    const dbModule = require('../../src/database/db');
    db = dbModule.db;

    await db.schema.dropTableIfExists('photo_feedback');
    await db.schema.dropTableIfExists('photos');
    await db.schema.dropTableIfExists('photo_categories');
    await db.schema.dropTableIfExists('events');

    await db.schema.createTable('events', (table) => {
      table.increments('id').primary();
      table.string('slug').notNullable();
      table.string('event_name').notNullable();
      table.string('source_mode').notNullable();
      table.string('external_path');
    });

    await db.schema.createTable('photo_categories', (table) => {
      table.increments('id').primary();
      table.string('name').notNullable();
      table.string('slug').notNullable();
      table.boolean('is_global').defaultTo(true);
      table.integer('event_id');
    });

    await db.schema.createTable('photos', (table) => {
      table.increments('id').primary();
      table.integer('event_id').notNullable();
      table.string('filename').notNullable();
      table.string('path').notNullable();
      table.string('thumbnail_path');
      table.string('type').notNullable();
      table.integer('size_bytes');
      table.integer('category_id');
      // Mirrors migration 041: the upload route never writes this column, it
      // relies on the NOT NULL DEFAULT 'managed' to mark managed originals.
      table.string('source_origin').notNullable().defaultTo('managed');
      table.string('external_relpath');
      // Columns the upload insert writes (migrations 048, 062, 071, 085, 193)
      // and the PATCH handler writes (migration 178). Without them the insert
      // and the update both fail on "no such column".
      table.string('original_filename', 512);
      table.string('source_filename', 255);
      table.datetime('captured_at').nullable();
      table.string('media_type').defaultTo('image');
      table.string('mime_type');
      table.string('processing_status', 16).notNullable().defaultTo('complete');
      table.string('upload_id', 64).nullable();
      table.boolean('auto_categorized');
      table.datetime('uploaded_at').defaultTo(db.fn.now());
      table.float('average_rating').defaultTo(0);
      table.integer('like_count').defaultTo(0);
      table.integer('favorite_count').defaultTo(0);
    });

    await db.schema.createTable('photo_feedback', (table) => {
      table.increments('id');
      table.integer('photo_id');
      table.string('feedback_type');
      table.boolean('is_approved');
      table.boolean('is_hidden');
    });

    await db('events').insert({
      id: 1,
      slug: 'test-event',
      event_name: 'Test Event',
      source_mode: 'reference',
      external_path: 'external/library'
    });

    const insertedCategory = await db('photo_categories').insert({
      name: 'Highlights',
      slug: 'highlights',
      is_global: true
    });
    categoryId = Array.isArray(insertedCategory) ? insertedCategory[0] : insertedCategory;

    const router = require('../../src/routes/adminPhotos');
    app = express();
    app.use(express.json());
    app.use('/api/admin/events', router);
  });

  afterAll(async () => {
    if (db) {
      await db.destroy();
    }
    resetModules();
    delete process.env.TEST_DATABASE_PATH;
    delete process.env.STORAGE_PATH;
    if (tmpDir) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('stores managed uploads with category information and managed origin', async () => {
    const uploadResponse = await request(app)
      .post(`/api/admin/events/1/upload`)
      .field('category_id', String(categoryId))
      .attach('photos', Buffer.from('fake image data'), 'photo.jpg');

    // 202 Accepted since the upload route went async (851744c3): the files are
    // stored and a pending row is inserted, thumbnails/EXIF follow in the
    // background worker. This assertion still said 200 from before that.
    expect(uploadResponse.status).toBe(202);
    expect(uploadResponse.body).toHaveProperty('photos');
    expect(Array.isArray(uploadResponse.body.photos)).toBe(true);

    const photo = await db('photos').first();
    expect(photo).toBeTruthy();
    expect(photo.category_id).toBe(categoryId);
    expect(photo.source_origin).toBe('managed');
    expect(photo.external_relpath).toBeNull();
  });

  it('returns numeric category metadata when listing photos', async () => {
    await db('photos').insert({
      event_id: 1,
      filename: 'external.jpg',
      path: 'test-event/external.jpg',
      thumbnail_path: null,
      type: 'individual',
      size_bytes: 123,
      source_origin: 'external',
      external_relpath: 'individual/external.jpg'
    });

    const response = await request(app)
      .get(`/api/admin/events/1/photos`)
      .expect(200);

    expect(Array.isArray(response.body.photos)).toBe(true);
    const managedPhoto = response.body.photos.find((p) => p.category_id === categoryId);
    expect(managedPhoto).toBeTruthy();
    expect(managedPhoto.category_name).toBe('Highlights');

    const filtered = await request(app)
      .get(`/api/admin/events/1/photos`)
      .query({ category_id: String(categoryId) })
      .expect(200);

    expect(filtered.body.photos.every((p) => p.category_id === categoryId)).toBe(true);
  });

  it('normalizes category updates', async () => {
    const photo = await db('photos').first();

    await request(app)
      .patch(`/api/admin/events/1/photos/${photo.id}`)
      .send({ category_id: '0' })
      .expect(200);

    const updated = await db('photos').where({ id: photo.id }).first();
    expect(updated.category_id).toBeNull();

    // A real id still round-trips — the '0' guard must not swallow it.
    await request(app)
      .patch(`/api/admin/events/1/photos/${photo.id}`)
      .send({ category_id: String(categoryId) })
      .expect(200);
    expect((await db('photos').where({ id: photo.id }).first()).category_id).toBe(categoryId);

    // Numeric 0 and unparseable input clear the category too, rather than
    // writing a category id that can never exist.
    for (const value of [0, 'not-a-category']) {
      await request(app)
        .patch(`/api/admin/events/1/photos/${photo.id}`)
        .send({ category_id: value })
        .expect(200);
      expect((await db('photos').where({ id: photo.id }).first()).category_id).toBeNull();

      await db('photos').where({ id: photo.id }).update({ category_id: categoryId });
    }
  });
});
