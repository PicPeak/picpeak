/**
 * Contract template version history (#1445, plan slice 5): each version
 * says who published it and when it was made, both in the template detail
 * and for a single version, and an earlier version can start a new draft.
 */

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let token;
let templatesApp;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };
const url = (p = '') => `/api/admin/contract-templates${p}`;

async function ok(req, status = [200, 201]) {
  const res = await req;
  if (!status.includes(res.status)) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  const updated = await db('feature_flags').where({ key: 'contracts' }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key: 'contracts', value: true });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  templatesApp = buildRouteApp('/api/admin/contract-templates', require('../../src/routes/adminContractTemplates'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('versions name their publisher and creation time; the seeded system version has no publisher', async () => {
  const created = await ok(request(templatesApp).post(url()).set(auth).send({ name: 'Historie' }));
  const id = created.template.id;
  let detail = await ok(request(templatesApp).put(url(`/${id}/draft`)).set(auth).send({
    lockVersion: created.template.lockVersion,
    items: [{ kind: 'text', section: 'closing', heading: 'A', body: { de: 'eins', en: 'one' } }],
  }));
  detail = await ok(request(templatesApp).post(url(`/${id}/publish`)).set(auth).send({ lockVersion: detail.template.lockVersion }));
  detail = await ok(request(templatesApp).put(url(`/${id}/draft`)).set(auth).send({
    lockVersion: detail.template.lockVersion,
    items: [{ kind: 'text', section: 'closing', heading: 'A', body: { de: 'zwei', en: 'two' } }],
  }));
  detail = await ok(request(templatesApp).post(url(`/${id}/publish`)).set(auth).send({ lockVersion: detail.template.lockVersion }));

  expect(detail.versions.map((v) => v.version)).toEqual([2, 1]);
  for (const v of detail.versions) {
    expect(v.publishedBy).toEqual({ id: adminId, username: 'tester' });
    expect(v.createdAt).toBeTruthy();
  }
  const { version } = await ok(request(templatesApp).get(url(`/${id}/versions/1`)).set(auth));
  expect(version.publishedBy).toEqual({ id: adminId, username: 'tester' });
  expect(version.items[0].body).toEqual({ de: 'eins', en: 'one' });

  const { templates } = await ok(request(templatesApp).get(url()).set(auth));
  const system = await ok(request(templatesApp).get(url(`/${templates.find((t) => t.isSystem).id}`)).set(auth));
  expect(system.versions[0].publishedBy).toBeNull();
});
