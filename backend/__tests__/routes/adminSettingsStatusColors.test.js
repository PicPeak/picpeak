/**
 * Status colours (Branding › Colours) travel with PUT /admin/settings/branding
 * as `status_colors` and come back in the public settings. A malformed set is
 * refused rather than stored cleaned, which would wipe the saved hues and
 * still report success; a save that leaves the key out keeps them.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-statuscolors-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'statuscolors-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-statuscolors-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');
const { clearPermissionCache } = require('../../src/middleware/permissions');
const { decodeSettingValue } = require('../helpers/settingValue');

describe('status colours on PUT /api/admin/settings/branding', () => {
  let db; let cleanup; let app; let tok;
  const auth = (req) => req.set('Authorization', `Bearer ${tok}`);
  const stored = async () => {
    const row = await db('app_settings').where({ setting_key: 'branding_status_colors' }).first();
    return row ? decodeSettingValue(db, row.setting_value) : undefined;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    tok = mintAdminToken(adminId);
    clearPermissionCache();
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/settings', require('../../src/routes/adminSettings'));
    app.use('/api/public/settings', require('../../src/routes/publicSettings'));
  }, 120000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('stores the picked hues and publishes them', async () => {
    const res = await auth(request(app).put('/api/admin/settings/branding'))
      .send({ company_name: 'Studio', status_colors: { danger: '#E11D48', success: '' } });
    expect(res.status).toBe(200);
    expect(await stored()).toEqual({ danger: '#e11d48' });
    const pub = await request(app).get('/api/public/settings');
    expect(pub.body.branding_status_colors).toEqual({ danger: '#e11d48' });
  });

  it('refuses a malformed set and keeps the saved hues', async () => {
    for (const status_colors of ['x', ['#000000'], { danger: 'red' }, { primary: '#000000' }]) {
      const res = await auth(request(app).put('/api/admin/settings/branding')).send({ company_name: 'Studio', status_colors });
      expect(res.status).toBe(400);
    }
    expect(await stored()).toEqual({ danger: '#e11d48' });
  });

  it('keeps them when a save leaves the key out', async () => {
    const res = await auth(request(app).put('/api/admin/settings/branding')).send({ company_name: 'Studio' });
    expect(res.status).toBe(200);
    expect(await stored()).toEqual({ danger: '#e11d48' });
  });
});
