/**
 * Admin workflow API — route tests (CRUD, versioning, RBAC gate, approvals).
 */
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

// bootCrmDb runs the full core-migration set in beforeAll; under full-suite
// parallel load on a small CI runner that can exceed the 5s default. Match the
// other migration-heavy CRM suites (discountLineItems, incomingInvoiceRebill).
jest.setTimeout(30000);

let db;
let cleanup;
let app;
let token;
let noPermToken;

const sampleGraph = {
  name: 'Test flow',
  trigger_type: 'invoice.sent',
  enabled: false,
  nodes: [
    { node_key: 'n1', type: 'trigger' },
    { node_key: 'n2', type: 'action', config: { action: 'noop' } },
  ],
  edges: [{ from_node: 'n1', to_node: 'n2' }],
};

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const { adminId } = await seedMinimal(db);
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);

  const ins = await db('admin_users').insert({
    username: 'norole', email: 'nr@example.com', password_hash: 'x',
    must_change_password: false, created_at: new Date(),
  }).returning('id');
  noPermToken = mintAdminToken(ins[0]?.id ?? ins[0]);

  await db('feature_flags').insert({ key: 'workflows', value: true });
  app = buildRouteApp('/api/admin/workflows', require('../../src/routes/adminWorkflows'));
});

afterAll(async () => { await cleanup(); });

const auth = (t) => ({ Authorization: `Bearer ${t}` });

describe('admin workflows API', () => {
  let createdId;

  test('create → 201 with id', async () => {
    const res = await request(app).post('/api/admin/workflows').set(auth(token)).send(sampleGraph);
    expect(res.status).toBe(201);
    expect(res.body.id).toBeGreaterThan(0);
    createdId = res.body.id;
  });

  test('rejects a graph without exactly one trigger', async () => {
    const res = await request(app).post('/api/admin/workflows').set(auth(token))
      .send({ ...sampleGraph, nodes: [{ node_key: 'x', type: 'action' }], edges: [] });
    expect(res.status).toBe(400);
  });

  test('rejects an unknown node type', async () => {
    const res = await request(app).post('/api/admin/workflows').set(auth(token))
      .send({ ...sampleGraph, nodes: [{ node_key: 't', type: 'trigger' }, { node_key: 'x', type: 'actoin' }], edges: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown node type/i);
  });

  test('refuses to enable a flow that uses an unregistered action', async () => {
    const create = await request(app).post('/api/admin/workflows').set(auth(token)).send({
      name: 'Stub flow', trigger_type: 'quote.accepted', enabled: false,
      nodes: [{ node_key: 't', type: 'trigger' }, { node_key: 'a', type: 'action', config: { action: 'totally_not_a_real_action' } }],
      edges: [{ from_node: 't', to_node: 'a' }],
    });
    expect(create.status).toBe(201);
    const res = await request(app).patch(`/api/admin/workflows/${create.body.id}/enabled`).set(auth(token)).send({ enabled: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not.*implemented|totally_not_a_real_action/i);
  });

  test('allows enabling a flow using the now-implemented booking invoice actions', async () => {
    const create = await request(app).post('/api/admin/workflows').set(auth(token)).send({
      name: 'Invoice-only booking', trigger_type: 'quote.accepted', enabled: false,
      nodes: [
        { node_key: 't', type: 'trigger' },
        { node_key: 'p', type: 'action', config: { action: 'prepare_invoice' } },
        { node_key: 'g', type: 'gate', config: {} },
        { node_key: 's', type: 'action', config: { action: 'send_document', document: 'invoice' } },
      ],
      edges: [
        { from_node: 't', to_node: 'p' },
        { from_node: 'p', to_node: 'g' },
        { from_node: 'g', from_handle: 'confirm', to_node: 's' },
      ],
    });
    expect(create.status).toBe(201);
    const res = await request(app).patch(`/api/admin/workflows/${create.body.id}/enabled`).set(auth(token)).send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });

  test('get one returns the graph', async () => {
    const res = await request(app).get(`/api/admin/workflows/${createdId}`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.nodes).toHaveLength(2);
    expect(res.body.edges).toHaveLength(1);
    expect(res.body.version).toBe(1);
  });

  test('list includes it', async () => {
    const res = await request(app).get('/api/admin/workflows').set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.some((w) => w.id === createdId)).toBe(true);
  });

  test('update bumps the version', async () => {
    const res = await request(app).put(`/api/admin/workflows/${createdId}`).set(auth(token))
      .send({ ...sampleGraph, name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
    const get = await request(app).get(`/api/admin/workflows/${createdId}`).set(auth(token));
    expect(get.body.name).toBe('Renamed');
    expect(get.body.version).toBe(2);
  });

  test('enable toggle', async () => {
    const res = await request(app).patch(`/api/admin/workflows/${createdId}/enabled`).set(auth(token)).send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });

  test('approvals inbox returns an array', async () => {
    const res = await request(app).get('/api/admin/workflows/approvals').set(auth(token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('a role without workflows.manage is forbidden from writing', async () => {
    const res = await request(app).post('/api/admin/workflows').set(auth(noPermToken)).send(sampleGraph);
    expect(res.status).toBe(403);
  });
});
