/**
 * The project list search matches the linked customer's address. The list
 * drops the customer fields for a caller without customers.view, but the
 * match itself told such a caller whether an address belongs to one of its
 * projects' customers. The address is searched only for a caller who may see
 * customers; the project name stays searchable for everyone.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-proj-search-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'proj-search-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-proj-search-storage-'));

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');
const { clearPermissionCache } = require('../../src/middleware/permissions');

describe('project search — customer address needs customers.view', () => {
  let db; let cleanup; let app;
  let superTok; let editorTok; let projectId;

  const auth = (req, tok) => req.set('Authorization', `Bearer ${tok}`);
  const insertId = async (table, row) => {
    const ins = await db(table).insert(row).returning('id');
    return ins[0]?.id ?? ins[0];
  };
  const search = async (tok, q) => {
    const res = await auth(request(app).get('/api/admin/projects').query({ q }), tok);
    expect(res.status).toBe(200);
    return res.body.projects.map((p) => p.id);
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId: superId, customerId } = await seedMinimal(db);
    await assignAdminRole(db, superId, 'super_admin');
    superTok = mintAdminToken(superId);

    const editorId = await insertId('admin_users', {
      username: 'editor', email: 'editor@example.com', password_hash: 'x',
      must_change_password: false, created_at: new Date().toISOString(),
    });
    await assignAdminRole(db, editorId, 'editor');
    editorTok = mintAdminToken(editorId);
    clearPermissionCache();

    await db('feature_flags').insert({ key: 'projects', value: 1 }).onConflict('key').merge({ value: 1 });

    // The editor's own project, linked to the customer by someone allowed to.
    projectId = await insertId('projects', {
      name: 'Summer wedding', status: 'active', created_by: editorId, customer_account_id: customerId,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });

    app = buildRouteApp('/api/admin/projects', require('../../src/routes/adminProjects'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('does not match the customer address without customers.view', async () => {
    expect(await search(editorTok, 'customer@example')).not.toContain(projectId);
    expect(await search(editorTok, 'Summer')).toContain(projectId);
  });

  it('matches the customer address with customers.view', async () => {
    expect(await search(superTok, 'customer@example')).toContain(projectId);
    expect(await search(superTok, 'Summer')).toContain(projectId);
  });
});
