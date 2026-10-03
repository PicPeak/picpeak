/**
 * A project's customer is customers.view data.
 *
 * Project create / update (events.edit) accepted any customerAccountId and
 * returned the joined customer email, so a project editor without
 * customers.view could enumerate the roster (valid ids succeed, invalid ones
 * fail the FK) and read addresses. Linking now needs customers.view, and
 * project payloads drop the customer fields for a caller without it.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-proj-cust-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'proj-cust-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-proj-cust-storage-'));

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');
const { clearPermissionCache } = require('../../src/middleware/permissions');

describe('projects — customer fields need customers.view', () => {
  let db; let cleanup; let app;
  let superTok; let editorId; let editorTok; let customerId; let linkedProjectId;

  const auth = (req, tok) => req.set('Authorization', `Bearer ${tok}`);
  const insertId = async (table, row) => {
    const ins = await db(table).insert(row).returning('id');
    return ins[0]?.id ?? ins[0];
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    let superId;
    ({ adminId: superId, customerId } = await seedMinimal(db));
    await assignAdminRole(db, superId, 'super_admin');
    superTok = mintAdminToken(superId);

    editorId = await insertId('admin_users', {
      username: 'editor', email: 'editor@example.com', password_hash: 'x',
      must_change_password: false, created_at: new Date().toISOString(),
    });
    await assignAdminRole(db, editorId, 'editor');
    editorTok = mintAdminToken(editorId);
    clearPermissionCache();

    await db('feature_flags').insert({ key: 'projects', value: 1 }).onConflict('key').merge({ value: 1 });

    // The editor's own project, already linked to the customer by someone
    // allowed to.
    linkedProjectId = await insertId('projects', {
      name: 'linked', status: 'active', created_by: editorId, customer_account_id: customerId,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    app = buildRouteApp('/api/admin/projects', require('../../src/routes/adminProjects'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('refuses a project editor linking a customer on create, for valid and unknown ids alike', async () => {
    for (const id of [customerId, 999999]) {
      const res = await auth(request(app).post('/api/admin/projects'), editorTok)
        .send({ name: 'probe', customerAccountId: id });
      expect(res.status).toBe(403);
    }
    expect(await db('projects').where({ name: 'probe' }).first()).toBeUndefined();
  });

  it('refuses a project editor linking a customer on update', async () => {
    const own = await insertId('projects', {
      name: 'mine', status: 'active', created_by: editorId,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    const res = await auth(request(app).put(`/api/admin/projects/${own}`), editorTok)
      .send({ customerAccountId: customerId });
    expect(res.status).toBe(403);
    expect((await db('projects').where({ id: own }).first()).customer_account_id).toBeNull();

    // Renaming and clearing the customer stay available.
    const ok = await auth(request(app).put(`/api/admin/projects/${own}`), editorTok)
      .send({ name: 'renamed', customerAccountId: null });
    expect(ok.status).toBe(200);
    expect(ok.body.project.name).toBe('renamed');
  });

  it('omits the customer fields from list, detail and overview without customers.view', async () => {
    const list = await auth(request(app).get('/api/admin/projects'), editorTok);
    expect(list.status).toBe(200);
    const row = list.body.projects.find((p) => p.id === linkedProjectId);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('customerAccountId');
    expect(row).not.toHaveProperty('customerEmail');

    const detail = await auth(request(app).get(`/api/admin/projects/${linkedProjectId}`), editorTok);
    expect(detail.status).toBe(200);
    expect(detail.body.project).not.toHaveProperty('customerEmail');
    expect(JSON.stringify(detail.body)).not.toContain('customer@example.com');

    const overview = await auth(request(app).get(`/api/admin/projects/${linkedProjectId}/overview`), editorTok);
    expect(overview.status).toBe(200);
    expect(overview.body.project).not.toHaveProperty('customerAccountId');
    expect(overview.body.project).not.toHaveProperty('customerEmail');
  });

  it('keeps the customer fields for a caller with customers.view', async () => {
    const detail = await auth(request(app).get(`/api/admin/projects/${linkedProjectId}`), superTok);
    expect(detail.status).toBe(200);
    expect(detail.body.project.customerAccountId).toBe(customerId);
    expect(detail.body.project.customerEmail).toBe('customer@example.com');

    const created = await auth(request(app).post('/api/admin/projects'), superTok)
      .send({ name: 'with-customer', customerAccountId: customerId });
    expect(created.status).toBe(201);
    expect(created.body.project.customerEmail).toBe('customer@example.com');
  });
});
