/**
 * photo_categories.name is varchar(100). Without a length check the insert
 * hit Postgres' "value too long" and the route's catch turned it into a raw
 * 500 with no message the form could surface — a >100-char name must come
 * back as a normal 400 validation error instead.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-catlen-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'catlen-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-catlen-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

const TOO_LONG = 'z'.repeat(101);

describe('category name length validation', () => {
  let db; let cleanup; let app; let superTok;

  const auth = (req) => req.set('Authorization', `Bearer ${superTok}`);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId: superId } = await seedMinimal(db);
    await assignAdminRole(db, superId, 'super_admin');
    superTok = mintAdminToken(superId);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/categories', require('../../src/routes/adminCategories'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('rejects a >100-char name on create with a 400, not a 500', async () => {
    const res = await auth(request(app).post('/api/admin/categories'))
      .send({ name: TOO_LONG, is_global: true });

    expect(res.status).toBe(400);
    expect(res.body.errors.some((e) => e.path === 'name')).toBe(true);
    const rows = await db('photo_categories').where('name', TOO_LONG);
    expect(rows).toHaveLength(0);
  });

  it('rejects a >100-char name on update with a 400, not a 500', async () => {
    const created = await auth(request(app).post('/api/admin/categories'))
      .send({ name: 'zzcatlen-ok', is_global: true });
    expect(created.status).toBe(200);

    const res = await auth(request(app).put(`/api/admin/categories/${created.body.id}`))
      .send({ name: TOO_LONG });

    expect(res.status).toBe(400);
    expect(res.body.errors.some((e) => e.path === 'name')).toBe(true);
    const row = await db('photo_categories').where('id', created.body.id).first();
    expect(row.name).toBe('zzcatlen-ok');
  });

  it('still accepts a name at exactly the 100-char limit', async () => {
    const name = 'y'.repeat(100);
    const res = await auth(request(app).post('/api/admin/categories'))
      .send({ name, is_global: true });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe(name);
  });
});
