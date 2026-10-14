/**
 * A feature-flag change is logged as the admin who made it. The actor used to
 * be { type: 'admin' } with no id or name, so the activity feed showed a blank
 * actor for it.
 */

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');

describe('PUT /api/admin/feature-flags activity actor', () => {
  let db; let cleanup; let app; let adminId; let token;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId } = await seedMinimal(db));
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);
    app = buildRouteApp('/api/admin/feature-flags', require('../../src/routes/adminFeatureFlags'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('stores the acting admin\'s id and username', async () => {
    const current = await request(app).get('/api/admin/feature-flags').set('Authorization', `Bearer ${token}`);
    expect(current.status).toBe(200);

    const res = await request(app)
      .put('/api/admin/feature-flags')
      .set('Authorization', `Bearer ${token}`)
      .send({ calendar: !current.body.calendar });
    expect(res.status).toBe(200);

    const row = await db('activity_logs').where({ activity_type: 'feature_flags_updated' })
      .orderBy('id', 'desc').first();
    const { username } = await db('admin_users').where({ id: adminId }).first('username');
    expect(row.actor_type).toBe('admin');
    expect(Number(row.actor_id)).toBe(Number(adminId));
    expect(row.actor_name).toBe(username);
  });
});
