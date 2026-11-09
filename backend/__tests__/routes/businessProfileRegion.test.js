/**
 * GET /business-profile/region (issue 2439, luap round 1 on PR 2447): the
 * business's country, readable by an admin who writes invoices but may not
 * read the rest of the profile, so the invoice editor shows the GBP rate
 * field a UK send asks for. It returns the country and nothing else.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-region-')), 'db.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'region-test-secret';

const request = require('supertest');
const { bootCrmDb, seedMinimal, mintAdminToken, buildRouteApp } = require('../integration/helpers/crmDb');
const { clearPermissionCache } = require('../../src/middleware/permissions');

describe('GET /business-profile/region', () => {
  let db; let cleanup; let app; let billsToken; let noneToken;

  const roleWith = async (name, permNames) => {
    const roleIns = await db('roles').insert({ name, display_name: name, priority: 10 }).returning('id');
    const roleId = roleIns[0]?.id ?? roleIns[0];
    const perms = await db('permissions').whereIn('name', permNames).select('id');
    if (perms.length) await db('role_permissions').insert(perms.map((p) => ({ role_id: roleId, permission_id: p.id })));
    const userIns = await db('admin_users').insert({
      username: name, email: `${name}@example.com`, password_hash: 'x',
      must_change_password: false, role_id: roleId, created_at: new Date().toISOString(),
    }).returning('id');
    return mintAdminToken(userIns[0]?.id ?? userIns[0]);
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    await db('business_profile').where({ id: 1 }).update({ country_code: 'GB' });
    billsToken = await roleWith('bill_writer', ['bills.view', 'bills.manage']);
    noneToken = await roleWith('gallery_only', ['events.view']);
    clearPermissionCache();
    app = buildRouteApp('/api/admin/business-profile', require('../../src/routes/adminBusinessProfile'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  const get = (url, tok) => request(app).get(url).set('Authorization', `Bearer ${tok}`);

  it('gives a bill writer the country, and only the country', async () => {
    const res = await get('/api/admin/business-profile/region', billsToken);
    expect(res.status).toBe(200);
    const body = res.body.data || res.body;
    expect(body).toEqual({ countryCode: 'GB' });
  });

  it('still keeps the full profile from that admin', async () => {
    expect((await get('/api/admin/business-profile', billsToken)).status).toBe(403);
  });

  it('refuses an admin who writes no invoices, quotes or customers', async () => {
    expect((await get('/api/admin/business-profile/region', noneToken)).status).toBe(403);
  });
});
