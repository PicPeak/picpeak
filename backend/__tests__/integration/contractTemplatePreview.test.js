/**
 * Contract template placeholders and previews (#1445, plan slice 4).
 *
 *   - GET /placeholders serves the registry the editor's picker reads (the
 *     frontend keeps no copy), and every key it lists is one the render
 *     context fills in;
 *   - a preview renders with sample data — a customer, an event, a quote —
 *     instead of blank placeholders, and names the template and version on
 *     every page;
 *   - `previewCustomerId` renders with a real customer, only for an admin
 *     who may view customers.
 */

const request = require('supertest');
const bcrypt = require('bcrypt');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let token;
let templatesApp;
let templateId;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };
const url = (p = '') => `/api/admin/contract-templates${p}`;

async function ok(req, status = [200, 201]) {
  const res = await req;
  if (!status.includes(res.status)) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** The render context of the next contract render. */
async function capturePreview(body = {}, as = auth) {
  const pdfService = require('../../src/services/pdfService');
  const spy = jest.spyOn(pdfService, 'renderContractWithSlots');
  try {
    const res = await request(templatesApp).post(url(`/${templateId}/preview`)).set(as).send(body)
      .buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    return { res, ctx: spy.mock.calls.length ? spy.mock.calls[0][0] : null };
  } finally {
    spy.mockRestore();
  }
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  const updated = await db('feature_flags').where({ key: 'contracts' }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key: 'contracts', value: true });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  await db('customer_accounts').where({ id: customerId }).update({ first_name: 'Real', last_name: 'Kunde', company_name: null });
  templatesApp = buildRouteApp('/api/admin/contract-templates', require('../../src/routes/adminContractTemplates'));

  const created = await ok(request(templatesApp).post(url()).set(auth).send({ name: 'Hochzeit Premium' }));
  templateId = created.template.id;
  await ok(request(templatesApp).put(url(`/${templateId}/draft`)).set(auth).send({
    lockVersion: created.template.lockVersion,
    items: [
      { kind: 'text', section: 'scope', heading: 'Parteien',
        body: { de: 'Zwischen {{customer_name}} und {{issuer_company_name}} für {{event_name}} am {{event_date}}. Offerte {{source_quote_number}}.' } },
    ],
  }));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('GET /placeholders serves the registry, and the render context fills in every key it lists', async () => {
  const { placeholders } = await ok(request(templatesApp).get(url('/placeholders')).set(auth));
  const { CONTRACT_PLACEHOLDERS } = require('../../src/utils/placeholders');
  expect(placeholders.map((p) => p.key)).toEqual([...CONTRACT_PLACEHOLDERS]);
  expect(placeholders[0]).toEqual(expect.objectContaining({
    key: 'customer_name', category: 'customer', label: expect.objectContaining({ en: expect.any(String), de: expect.any(String) }),
  }));

  const { buildPlaceholderContext } = require('../../src/services/contract/renderContext');
  const values = await buildPlaceholderContext({ contract_number: 'C-1' }, null);
  expect(Object.keys(values).sort()).toEqual([...CONTRACT_PLACEHOLDERS].sort());
});

test('a preview renders with sample data and names the template and version', async () => {
  const { res, ctx } = await capturePreview();
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/application\/pdf/);
  const body = ctx.sections[0].blocks[0].body;
  expect(body).toContain('Anna Muster');
  expect(body).toContain('Hochzeit Anna & Ben');
  expect(body).toContain('12.06.2027');
  expect(body).toContain('Q-2026-0107');
  expect(ctx.recipient).toEqual(expect.objectContaining({ lastName: expect.anything() }));
  expect(ctx.quoteLineItems).toHaveLength(3);
  expect(ctx.quoteTotals).toEqual(expect.objectContaining({ grossMinor: 167555 }));
  expect(ctx.previewLabel).toBe('Vorschau — Hochzeit Premium Entwurf — Beispieldaten, kein Vertrag');
});

test('previewCustomerId renders with that customer — for an admin who may view customers', async () => {
  const { res, ctx } = await capturePreview({ previewCustomerId: customerId });
  expect(res.status).toBe(200);
  expect(ctx.sections[0].blocks[0].body).toContain('Real Kunde');

  // A role with contracts.view but not customers.view.
  const role = await db('roles').where({ name: 'viewer' }).first();
  const perms = await db('role_permissions as rp').join('permissions as p', 'p.id', 'rp.permission_id')
    .where('rp.role_id', role.id).pluck('p.name');
  if (!perms.includes('contracts.view')) {
    const p = await db('permissions').where({ name: 'contracts.view' }).first();
    await db('role_permissions').insert({ role_id: role.id, permission_id: p.id });
  }
  const cp = await db('permissions').where({ name: 'customers.view' }).first();
  await db('role_permissions').where({ role_id: role.id, permission_id: cp.id }).del();
  require('../../src/middleware/permissions').clearPermissionCache();
  const inserted = await db('admin_users').insert({
    username: 'limited', email: 'limited@example.com', password_hash: await bcrypt.hash('x', 4),
    must_change_password: false, role_id: role.id, created_at: new Date().toISOString(),
  }).returning('id');
  const limited = { Authorization: `Bearer ${mintAdminToken(inserted[0]?.id ?? inserted[0])}` };

  const refused = await capturePreview({ previewCustomerId: customerId }, limited);
  expect(refused.res.status).toBe(403);
  expect(refused.ctx).toBeNull();
  // Sample data needs no customer permission.
  expect((await capturePreview({}, limited)).res.status).toBe(200);
});
