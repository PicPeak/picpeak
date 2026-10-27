/**
 * gallery_lightbox_max_zoom_percent (issue 2281): how far guests may zoom
 * into a loaded original, in percent of its pixels. PUT /general stores an
 * integer from 100 to 1000 and refuses anything else; the public settings
 * hand the gallery 100 unless a valid value is stored.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-lightbox-zoom-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'lightbox-zoom-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-lightbox-zoom-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { decodeSettingValue } = require('../helpers/settingValue');

const KEY = 'gallery_lightbox_max_zoom_percent';

describe('gallery_lightbox_max_zoom_percent (issue 2281)', () => {
  let db; let cleanup; let app; let token;

  const unwrap = (r) => (typeof r[0] === 'object' && r[0] !== null ? r[0].id : r[0]);
  const put = (body) => request(app)
    .put('/api/admin/settings/general')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
  const stored = async () => {
    const row = await db('app_settings').where({ setting_key: KEY }).first();
    return row ? decodeSettingValue(db, row.setting_value) : undefined;
  };
  const publicValue = async () => (await request(app).get('/api/public/settings')).body[KEY];

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const role = await db('roles').where({ name: 'super_admin' }).first();
    const adminId = unwrap(await db('admin_users').insert({
      username: 'zoom-root', email: 'zoom-root@example.com',
      password_hash: await bcrypt.hash('Passw0rd!', 4), role_id: role.id, is_active: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id'));
    token = jwt.sign(
      { id: adminId, username: 'zoom-root', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' },
    );

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/settings', require('../../src/routes/adminSettings'));
    app.use('/api/public/settings', require('../../src/routes/publicSettings'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('is 100 for the gallery while nothing is stored', async () => {
    expect(await stored()).toBeUndefined();
    expect(await publicValue()).toBe(100);
  });

  it.each([100, 800, 1000, '450'])('stores %p as an integer and hands it to the gallery', async (value) => {
    const res = await put({ [KEY]: value });
    expect(res.status).toBe(200);
    expect(await stored()).toBe(Number(value));
    expect(await publicValue()).toBe(Number(value));
  });

  it.each([99, 0, -5, 1001, 5000, 250.5, 'abc', '', null, true])('refuses %p and keeps the stored value', async (value) => {
    await put({ [KEY]: 300 });
    const res = await put({ [KEY]: value });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between 100 and 1000/);
    expect(await stored()).toBe(300);
  });

  it('hands the gallery 100 when an out-of-range value was stored some other way', async () => {
    await db('app_settings').where({ setting_key: KEY }).update({ setting_value: JSON.stringify(5000) });
    expect(await publicValue()).toBe(100);
  });
});
