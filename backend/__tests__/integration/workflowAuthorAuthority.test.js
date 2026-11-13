'use strict';

// A workflow graph runs with no more CRM authority than its author holds:
// the admin whose request emitted the trigger keeps the run entity visible,
// but only the CRM permissions the author also holds survive, and a
// super-admin trigger does not lift the entity cap for another author's graph.
const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp } = require('./helpers/crmDb');
const json = value => (typeof value === 'string' ? JSON.parse(value) : value);
const formatBoolean = value => require('../../src/utils/dbCompat').formatBoolean(value);

let db, cleanup, superId, workflowOnlyId, billsAuthorId, customerId, invoiceIds, app;

async function roleWith(name, permissionNames) {
  const [role] = await db('roles').insert({ name, display_name: name }).returning('id');
  const roleId = role.id ?? role;
  const permissions = await db('permissions').whereIn('name', permissionNames);
  expect(permissions).toHaveLength(permissionNames.length);
  await db('role_permissions').insert(permissions.map(p => ({ role_id: roleId, permission_id: p.id })));
  return roleId;
}

async function adminWith(username, roleId) {
  const [row] = await db('admin_users').insert({ username, email: `${username}@example.test`, password_hash: 'unused',
    role_id: roleId, is_active: formatBoolean(true), must_change_password: formatBoolean(false) }).returning('id');
  return row.id ?? row;
}

let serial = 0;
async function probeGraph(createdBy, targetId) {
  const [inserted] = await db('workflows').insert({ name: `authority probe ${++serial}`, version: 1,
    trigger_type: 'crm.author.fixture', enabled: formatBoolean(true), created_by: createdBy }).returning('id');
  const workflowId = inserted.id ?? inserted;
  await db('workflow_nodes').insert([
    { workflow_id: workflowId, version: 1, node_key: 'start', type: 'trigger', config: '{}' },
    { workflow_id: workflowId, version: 1, node_key: 'probe', type: 'action', config: JSON.stringify({ action: 'crm_author_probe', targetId }) },
  ]);
  await db('workflow_edges').insert({ workflow_id: workflowId, version: 1, from_node: 'start', to_node: 'probe' });
  return workflowId;
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId: superId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, superId);
  await db('admin_users').where('id', superId).update({ is_active: formatBoolean(true) });
  workflowOnlyId = await adminWith('workflow-only', await roleWith('wf_only_fixture', ['workflows.view', 'workflows.manage']));
  billsAuthorId = await adminWith('bills-author', await roleWith('wf_bills_fixture',
    ['workflows.view', 'workflows.manage', 'bills.view', 'bills.manage']));
  require('../../src/middleware/permissions').clearPermissionCache();
  for (const key of ['bills', 'workflows']) {
    const flag = await db('feature_flags').where({ key }).first();
    if (flag) await db('feature_flags').where({ key }).update({ value: formatBoolean(true) });
    else await db('feature_flags').insert({ key, value: formatBoolean(true) });
  }
  invoiceIds = [];
  // 0, 1: the super admin's; 2, 3: the bills author's own.
  for (const [label, creator] of [['entity', superId], ['foreign', superId], ['author-entity', billsAuthorId], ['author-other', billsAuthorId]]) {
    const [row] = await db('invoices').insert({ invoice_number: `WFA-${label}`, customer_account_id: customerId,
      issue_date: '2026-06-01', due_date: '2026-06-30', created_by_admin_id: creator, deal_uuid: require('crypto').randomUUID(),
      status: 'scheduled' }).returning('id');
    invoiceIds.push(row.id ?? row);
  }
  require('../../src/services/workflows/registry').registerAction('crm_author_probe', async ctx => ({
    entity: await ctx.db('invoices').where('id', ctx.run.entity_id).update({ reminder_level: 7 }),
    foreign: await ctx.db('invoices').where('id', ctx.node.config.targetId).update({ status: 'sent' }),
  }));
  app = buildRouteApp('/api/admin/workflows', require('../../src/routes/adminWorkflows'));
});
afterAll(async () => { if (cleanup) await cleanup(); });

beforeEach(async () => {
  await db('invoices').whereIn('id', invoiceIds).update({ status: 'scheduled', reminder_level: 0 });
});

async function emitAsSuperAdmin(workflowId, entityId = invoiceIds[0]) {
  const { loadCrmActor, withCrmActor } = require('../../src/database/crmAccess');
  const engine = require('../../src/services/workflows/engine');
  const origin = { ...(await loadCrmActor({ id: superId })), originAdminId: superId };
  const [runId] = await withCrmActor(origin, () => engine.emitWorkflowEvent('crm.author.fixture', {
    entityType: 'invoice', entityId, targetWorkflowId: workflowId,
  }));
  return runId;
}

test('a super-admin trigger does not lend its authority to a graph authored without CRM permissions', async () => {
  const runId = await emitAsSuperAdmin(await probeGraph(workflowOnlyId, invoiceIds[1]));
  expect((await db('workflow_runs').where('id', runId).first()).status).toBe('failed');
  expect((await db('invoices').where('id', invoiceIds[1]).first()).status).toBe('scheduled');
  expect((await db('invoices').where('id', invoiceIds[0]).first()).reminder_level).toBe(0);
});

test('a super-admin trigger runs another author\'s graph as that author, capped to the run entity', async () => {
  const runId = await emitAsSuperAdmin(await probeGraph(billsAuthorId, invoiceIds[3]), invoiceIds[2]);
  const step = await db('workflow_run_steps').where({ run_id: runId, node_key: 'probe' }).first();
  expect(json(step.result)).toEqual({ entity: 1, foreign: 0 });
  expect((await db('invoices').where('id', invoiceIds[3]).first()).status).toBe('scheduled');
});

test('a super-admin trigger on a record the author cannot see does not reach it', async () => {
  const runId = await emitAsSuperAdmin(await probeGraph(billsAuthorId, invoiceIds[1]));
  expect((await db('workflow_runs').where('id', runId).first()).status).toBe('failed');
  expect((await db('invoices').where('id', invoiceIds[0]).first()).reminder_level).toBe(0);
  expect((await db('invoices').where('id', invoiceIds[1]).first()).status).toBe('scheduled');
});

test('a super-admin author triggering its own graph keeps its authority', async () => {
  const runId = await emitAsSuperAdmin(await probeGraph(superId, invoiceIds[1]));
  const step = await db('workflow_run_steps').where({ run_id: runId, node_key: 'probe' }).first();
  expect(json(step.result)).toEqual({ entity: 1, foreign: 1 });
});

test('set_context cannot write the variables the engine and its actions own', async () => {
  const registry = require('../../src/services/workflows/registry');
  const result = await registry.getAction('set_context')({ node: { config: { set: {
    paid: true, adminEmail: 'x@example.test', customerEmail: 'y@example.test', recipientEmail: 'z@example.test',
    customerAccountId: 9, emailData: { a: 1 }, preparedInvoiceIds: [1], preparedContractId: 2, __dryRun: false,
  } } } });
  expect(result).toEqual({ set: { paid: true } });
});

describe('saving a graph with document actions needs the matching CRM permission', () => {
  const graph = action => ({ name: 'doc flow', trigger_type: 'invoice.sent', nodes: [
    { node_key: 't', type: 'trigger', config: {} },
    { node_key: 'a', type: 'action', config: action },
  ], edges: [{ from_node: 't', to_node: 'a' }] });
  const as = id => ({ Authorization: `Bearer ${mintAdminToken(id)}` });

  test.each([
    [{ action: 'send_document', document: 'invoice' }],
    [{ action: 'escalate_to_collections' }],
    [{ action: 'send_document', document: 'contract' }],
  ])('workflows.manage alone cannot create %j', async action => {
    const res = await request(app).post('/api/admin/workflows').set(as(workflowOnlyId)).send(graph(action));
    expect(res.status).toBe(403);
  });

  test('an author holding bills.manage can save an invoice flow, but not a contract send', async () => {
    expect((await request(app).post('/api/admin/workflows').set(as(billsAuthorId))
      .send(graph({ action: 'send_document', document: 'invoice' }))).status).toBe(201);
    expect((await request(app).post('/api/admin/workflows').set(as(billsAuthorId))
      .send(graph({ action: 'send_document', document: 'contract' }))).status).toBe(403);
  });

  test('flows without document actions still save with workflows.manage', async () => {
    expect((await request(app).post('/api/admin/workflows').set(as(workflowOnlyId))
      .send(graph({ action: 'send_email', recipientClass: 'admin' }))).status).toBe(201);
  });

  test('editing another author\'s flow into a document flow is refused; a rename is not', async () => {
    const created = await request(app).post('/api/admin/workflows').set(as(billsAuthorId))
      .send(graph({ action: 'escalate_to_collections' }));
    const id = created.body.id;
    const stored = await request(app).get(`/api/admin/workflows/${id}`).set(as(workflowOnlyId));
    expect((await request(app).put(`/api/admin/workflows/${id}`).set(as(workflowOnlyId))
      .send({ ...graph({ action: 'send_document', document: 'invoice' }) })).status).toBe(403);
    expect((await request(app).put(`/api/admin/workflows/${id}`).set(as(workflowOnlyId))
      .send({ name: 'renamed', nodes: stored.body.nodes, edges: stored.body.edges })).status).toBe(200);
    expect((await db('workflows').where({ id }).first()).created_by).toBe(billsAuthorId);
  });
});
