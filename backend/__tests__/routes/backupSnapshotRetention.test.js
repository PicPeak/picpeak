/**
 * The backup_retention_count setting. Every local and S3 run is a complete
 * standalone snapshot, so it decides how much storage a destination ends up
 * holding.
 */
const request = require('supertest');
const { decodeSettingValue } = require('../helpers/settingValue');
const express = require('express');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken,
} = require('../integration/helpers/crmDb');

describe('standalone snapshot retention routes', () => {
  let db; let cleanup; let app; let token;
  const stored = async key => {
    const row = await db('app_settings').where('setting_key', key).first();
    return row ? decodeSettingValue(db, row.setting_value) : undefined;
  };
  const put = body => request(app).put('/backup/config').set('Authorization', 'Bearer ' + token).send(body);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId);
    token = mintAdminToken(adminId);
    app = express();
    app.use(express.json());
    app.use('/backup', require('../../src/routes/adminBackup'));
  }, 120000);
  afterAll(async () => { await cleanup(); });

  it.each([0, 1, 7, 1000])('stores backup_retention_count %j', async value => {
    expect((await put({ backup_retention_count: value })).status).toBe(200);
    expect(await stored('backup_retention_count')).toBe(value);
  });

  it.each([-1, 1001, 2.5, '3', '3; rm -rf /', null, true, [3]])('refuses backup_retention_count %j', async value => {
    await put({ backup_retention_count: 5 });
    const res = await put({ backup_retention_count: value });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/backup_retention_count/);
    expect(await stored('backup_retention_count')).toBe(5);
  });
});
