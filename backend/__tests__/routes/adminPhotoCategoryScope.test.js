/**
 * Category scope on the admin photo update routes.
 *
 * The upload route validates a numeric category_id against
 * (event_id = this event OR is_global) and 400s an out-of-scope id
 * (#500 / #525), but PATCH /:eventId/photos/:photoId and
 * POST /:eventId/photos/bulk-update accepted ANY positive id — so a photo
 * could be filed under another event's category, where no grid filter
 * (neither the category filters nor the whereNull "uncategorized" one)
 * would ever show it again.
 *
 * Pins:
 *  - an id belonging to a different event is rejected with the same 400
 *    shape the upload route uses, on both routes
 *  - a global category and this event's own category are both accepted
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-cat-scope-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cat-scope-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-cat-scope-storage-'));

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('admin photo category scope (PATCH / bulk-update)', () => {
  let db;
  let cleanup;
  let app;
  let eventId;
  let otherEventId;
  let photoId;
  let adminToken;
  let ownCategoryId;
  let globalCategoryId;
  let foreignCategoryId;

  const unwrap = (rows) => {
    const row = rows[0];
    return typeof row === 'object' && row !== null ? row.id : row;
  };

  const seedEvent = async (slug) => {
    const inserted = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Cat Scope ${slug}`,
      event_date: '2026-09-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      share_token: `${slug}-share`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    return unwrap(inserted);
  };

  const patchCategory = (categoryId) => request(app)
    .patch(`/api/admin/photos/${eventId}/photos/${photoId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ category_id: categoryId });

  const bulkUpdateCategory = (categoryId) => request(app)
    .post(`/api/admin/photos/${eventId}/photos/bulk-update`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ photoIds: [photoId], updates: { category_id: categoryId } });

  const storedCategoryId = async () => {
    const row = await db('photos').where({ id: photoId }).first();
    return row.category_id;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    eventId = await seedEvent('cat-scope-event');
    otherEventId = await seedEvent('cat-scope-other-event');

    // is_global defaults to TRUE on this table, so the event-scoped rows have
    // to say so explicitly — otherwise every category is in scope everywhere.
    ownCategoryId = unwrap(await db('photo_categories').insert({
      event_id: eventId, name: 'Ceremony', slug: 'cs-ceremony', is_global: false, created_at: new Date().toISOString(),
    }).returning('id'));
    globalCategoryId = unwrap(await db('photo_categories').insert({
      event_id: null, name: 'Portraits', slug: 'cs-portraits', is_global: true, created_at: new Date().toISOString(),
    }).returning('id'));
    foreignCategoryId = unwrap(await db('photo_categories').insert({
      event_id: otherEventId, name: 'Reception', slug: 'cs-reception', is_global: false, created_at: new Date().toISOString(),
    }).returning('id'));

    photoId = unwrap(await db('photos').insert({
      event_id: eventId,
      filename: 'shot.jpg',
      path: 'cat-scope-event/shot.jpg',
      type: 'individual',
      uploaded_at: new Date().toISOString(),
    }).returning('id'));

    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const rootId = unwrap(await db('admin_users').insert({
      username: 'cat-scope-admin',
      email: 'cat-scope-admin@example.com',
      password_hash: await bcrypt.hash('CatScope123', 4),
      role_id: superRole.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id'));
    adminToken = jwt.sign(
      { id: rootId, username: 'cat-scope-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' }
    );

    app = express();
    app.use(express.json());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    await db('photos').where({ id: photoId }).update({ category_id: null });
  });

  it('PATCH rejects a category belonging to another event', async () => {
    const res = await patchCategory(foreignCategoryId);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Unknown or out-of-scope category_id ${foreignCategoryId}`);
    expect(await storedCategoryId()).toBeNull();
  });

  it('PATCH rejects a category id that does not exist at all', async () => {
    const res = await patchCategory(999999);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unknown or out-of-scope category_id 999999');
    expect(await storedCategoryId()).toBeNull();
  });

  it('PATCH accepts this event\'s own category and a global one', async () => {
    expect((await patchCategory(ownCategoryId)).status).toBe(200);
    expect(await storedCategoryId()).toBe(ownCategoryId);

    expect((await patchCategory(globalCategoryId)).status).toBe(200);
    expect(await storedCategoryId()).toBe(globalCategoryId);
  });

  it('bulk-update rejects a category belonging to another event', async () => {
    const res = await bulkUpdateCategory(foreignCategoryId);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Unknown or out-of-scope category_id ${foreignCategoryId}`);
    expect(await storedCategoryId()).toBeNull();
  });

  it('bulk-update accepts this event\'s own category and a global one', async () => {
    expect((await bulkUpdateCategory(ownCategoryId)).status).toBe(200);
    expect(await storedCategoryId()).toBe(ownCategoryId);

    expect((await bulkUpdateCategory(globalCategoryId)).status).toBe(200);
    expect(await storedCategoryId()).toBe(globalCategoryId);
  });

  it('still clears the category for 0 / individual without a scope lookup', async () => {
    await db('photos').where({ id: photoId }).update({ category_id: ownCategoryId });
    expect((await patchCategory('0')).status).toBe(200);
    expect(await storedCategoryId()).toBeNull();

    await db('photos').where({ id: photoId }).update({ category_id: ownCategoryId });
    expect((await bulkUpdateCategory('individual')).status).toBe(200);
    expect(await storedCategoryId()).toBeNull();
  });
});
