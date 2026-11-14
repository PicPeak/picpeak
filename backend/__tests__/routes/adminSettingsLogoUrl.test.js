/**
 * branding_logo_url names a logo the upload route wrote, and the PDF logo
 * resolver reads it. PUT /branding accepts only such a value (or the one
 * already stored), and the generic settings writers do not write it.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-logourl-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'logourl-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-logourl-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');
const { clearPermissionCache } = require('../../src/middleware/permissions');
const { decodeSettingValue } = require('../helpers/settingValue');

describe('branding logo URL writers', () => {
  let db; let cleanup; let app; let tok;
  const auth = (req) => req.set('Authorization', `Bearer ${tok}`);
  const stored = async (key) => {
    const row = await db('app_settings').where({ setting_key: key }).first();
    return row ? decodeSettingValue(db, row.setting_value) : undefined;
  };
  const PHOTO = 'events/active/someone-else/IMG_0001.png';

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    // solo_photographer: settings.edit, not a Super Admin.
    await assignAdminRole(db, adminId, 'solo_photographer');
    tok = mintAdminToken(adminId);
    clearPermissionCache();
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/settings', require('../../src/routes/adminSettings'));
  }, 120000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('does not let PUT /general write the logo URLs', async () => {
    const res = await auth(request(app).put('/api/admin/settings/general')).send({
      branding_logo_url: PHOTO, branding_logo_url_dark: PHOTO, branding_watermark_logo_url: PHOTO,
      general_date_format: 'DD.MM.YYYY',
    });
    expect(res.status).toBe(200);
    expect(await stored('branding_logo_url')).toBeUndefined();
    expect(await stored('branding_logo_url_dark')).toBeUndefined();
    expect(await stored('branding_watermark_logo_url')).toBeUndefined();
  });

  it('refuses a PUT /branding logo_url that is not an uploaded logo', async () => {
    for (const logo_url of [PHOTO, '/uploads/logos/../../' + PHOTO, '/uploads/other/x.png']) {
      const res = await auth(request(app).put('/api/admin/settings/branding')).send({ company_name: 'Studio', logo_url });
      expect(res.status).toBe(400);
    }
    expect(await stored('branding_logo_url')).toBeUndefined();
  });

  it('accepts an uploaded logo, an empty value, and the value already stored', async () => {
    let res = await auth(request(app).put('/api/admin/settings/branding')).send({ company_name: 'Studio', logo_url: '/uploads/logos/logo-1.png' });
    expect(res.status).toBe(200);
    expect(await stored('branding_logo_url')).toBe('/uploads/logos/logo-1.png');

    // An older install may hold a value the check would refuse today; saving
    // the form unchanged must still work (the PDF resolver ignores it).
    await db('app_settings').where({ setting_key: 'branding_logo_url' }).update({ setting_value: JSON.stringify('https://cdn.example.com/logo.png') });
    res = await auth(request(app).put('/api/admin/settings/branding')).send({ company_name: 'Studio', logo_url: 'https://cdn.example.com/logo.png' });
    expect(res.status).toBe(200);

    res = await auth(request(app).put('/api/admin/settings/branding')).send({ company_name: 'Studio', logo_url: '' });
    expect(res.status).toBe(200);
  });
});
