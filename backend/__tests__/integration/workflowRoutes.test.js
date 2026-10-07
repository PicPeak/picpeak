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
jest.setTimeout(120000);

let db;
let cleanup;
let app;
let token;
let noPermToken;
let scopedToken;
let scopedAdminId;
let ownEventId;
let foreignEventId;
let ownerlessEventId;
let customerId;
let viewAllToken;
let manageAllToken;
let manageAllAdminId;
let foreignEventRunId;
let foreignEventApprovalId;
let ownEventRunId;

const sampleGraph = {
  name: 'Test flow',
  trigger_type: 'gallery.published',
  enabled: false,
  nodes: [
    { node_key: 'n1', type: 'trigger' },
    { node_key: 'n2', type: 'action', config: { action: 'noop' } },
  ],
  edges: [{ from_node: 'n1', to_node: 'n2' }],
};

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const seeded = await seedMinimal(db);
  const { adminId } = seeded;
  customerId = seeded.customerId;
  await db('customer_accounts').where({ id: customerId })
    .update({ created_by_admin_id: adminId });
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);

  const ins = await db('admin_users').insert({
    username: 'norole', email: 'nr@example.com', password_hash: 'x',
    must_change_password: false, created_at: new Date(),
  }).returning('id');
  noPermToken = mintAdminToken(ins[0]?.id ?? ins[0]);

  const scopedRole = await require('../../src/services/userManagementService').createRole({
    name: 'workflow_auditor', permissions: ['workflows.view', 'workflows.manage'],
  }, adminId);
  const scopedInsert = await db('admin_users').insert({
    username: 'workflow-auditor', email: 'workflow-auditor@example.com', password_hash: 'x',
    role_id: scopedRole.id, must_change_password: false, created_at: new Date(),
  }).returning('id');
  scopedAdminId = scopedInsert[0]?.id ?? scopedInsert[0];
  scopedToken = mintAdminToken(scopedAdminId);

  const insertScopedAdmin = async (name, permissions) => {
    const role = await require('../../src/services/userManagementService').createRole({ name, permissions }, adminId);
    const rows = await db('admin_users').insert({
      username: name, email: `${name}@example.com`, password_hash: 'x', role_id: role.id,
      must_change_password: false, created_at: new Date(),
    }).returning('id');
    const id = rows[0]?.id ?? rows[0];
    return { id, token: mintAdminToken(id) };
  };
  viewAllToken = (await insertScopedAdmin('workflow_view_all', [
    'workflows.view', 'workflows.manage', 'events.view_all',
  ])).token;
  const manageAll = await insertScopedAdmin('workflow_manage_all', [
    'workflows.view', 'workflows.manage', 'events.manage_all',
  ]);
  manageAllAdminId = manageAll.id;
  manageAllToken = manageAll.token;
  require('../../src/middleware/permissions').clearPermissionCache();

  const insertEvent = async (slug, createdBy) => {
    const rows = await db('events').insert({
      slug, event_type: 'wedding', event_name: slug, event_date: '2026-10-06',
      host_email: 'host@example.com', admin_email: 'admin@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/share`, created_by: createdBy,
    }).returning('id');
    return rows[0]?.id ?? rows[0];
  };
  ownEventId = await insertEvent('workflow-own', scopedAdminId);
  foreignEventId = await insertEvent('workflow-foreign', adminId);
  ownerlessEventId = await insertEvent('workflow-ownerless', null);

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

  test('scopes run history, steps, approvals and approval actions to the run entity owner', async () => {
    const insertRun = async (eventId, marker) => {
      const rows = await db('workflow_runs').insert({
        workflow_id: createdId, version: 2, trigger_event: 'gallery.published',
        entity_type: 'event', entity_id: eventId, status: 'waiting', current_node: 'n2',
        context: JSON.stringify({ vars: { marker, customerEmail: `${marker}@example.com` } }),
        dedup_key: `scope:${marker}`,
      }).returning('id');
      return rows[0]?.id ?? rows[0];
    };
    const ownRunId = await insertRun(ownEventId, 'own');
    ownEventRunId = ownRunId;
    const foreignRunId = await insertRun(foreignEventId, 'foreign');
    foreignEventRunId = foreignRunId;
    const ownerlessRunId = await insertRun(ownerlessEventId, 'ownerless');
    for (const [runId, marker] of [[ownRunId, 'own'], [foreignRunId, 'foreign'], [ownerlessRunId, 'ownerless']]) {
      await db('workflow_run_steps').insert({
        run_id: runId, node_key: 'n2', node_type: 'gate', status: 'waiting',
        result: JSON.stringify({ marker }),
      });
      await db('workflow_approvals').insert({
        run_id: runId, node_key: 'n2', type: 'payment_confirm', status: 'pending',
        token_hash: marker.padEnd(64, '0'), payload: JSON.stringify({ marker }),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      });
    }

    const runs = await request(app).get(`/api/admin/workflows/${createdId}/runs`).set(auth(scopedToken));
    expect(runs.status).toBe(200);
    expect(runs.body.map((run) => run.id)).toEqual(expect.arrayContaining([ownRunId, ownerlessRunId]));
    expect(runs.body.map((run) => run.id)).not.toContain(foreignRunId);
    expect(JSON.stringify(runs.body)).not.toContain('foreign@example.com');

    const ownSteps = await request(app).get(`/api/admin/workflows/runs/${ownRunId}/steps`).set(auth(scopedToken));
    expect(ownSteps.status).toBe(200);
    expect(ownSteps.body).toHaveLength(1);
    const foreignSteps = await request(app).get(`/api/admin/workflows/runs/${foreignRunId}/steps`).set(auth(scopedToken));
    expect(foreignSteps.status).toBe(404);

    const approvals = await request(app).get('/api/admin/workflows/approvals').set(auth(scopedToken));
    expect(approvals.status).toBe(200);
    expect(approvals.body.map((approval) => approval.run_id))
      .toEqual(expect.arrayContaining([ownRunId, ownerlessRunId]));
    expect(approvals.body.map((approval) => approval.run_id)).not.toContain(foreignRunId);

    const foreignApproval = await db('workflow_approvals').where({ run_id: foreignRunId }).first('id');
    foreignEventApprovalId = foreignApproval.id;
    const act = await request(app)
      .post(`/api/admin/workflows/approvals/${foreignApproval.id}/confirm`)
      .set(auth(scopedToken));
    expect(act.status).toBe(404);
    expect((await db('workflow_approvals').where({ id: foreignApproval.id }).first('status')).status)
      .toBe('pending');
  });

  test('applies ownership before run and approval result limits', async () => {
    const foreignRows = Array.from({ length: 205 }, (_, i) => ({
      workflow_id: createdId, version: 2, trigger_event: 'gallery.published',
      entity_type: 'event', entity_id: foreignEventId, status: 'done',
      context: JSON.stringify({ vars: { marker: `page-foreign-${i}` } }),
      dedup_key: `scope:page-foreign-${i}`,
    }));
    await db.batchInsert('workflow_runs', foreignRows, 40);
    const inserted = await db('workflow_runs').where('dedup_key', 'like', 'scope:page-foreign-%')
      .orderBy('id', 'desc').limit(105).select('id');
    await db.batchInsert('workflow_approvals', inserted.map((run, i) => ({
      run_id: run.id, node_key: 'n2', type: 'payment_confirm', status: 'pending',
      token_hash: `page-${String(i).padStart(4, '0')}`.padEnd(64, '0'),
      payload: JSON.stringify({ marker: `page-foreign-${i}` }),
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      created_at: `2030-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
    })), 40);

    const runs = await request(app).get(`/api/admin/workflows/${createdId}/runs`).set(auth(scopedToken));
    expect(runs.status).toBe(200);
    expect(runs.body.map((run) => run.id)).toContain(ownEventRunId);
    expect(JSON.stringify(runs.body)).not.toContain('page-foreign');

    const approvals = await request(app).get('/api/admin/workflows/approvals').set(auth(scopedToken));
    expect(approvals.status).toBe(200);
    expect(approvals.body.map((approval) => approval.run_id)).toContain(ownEventRunId);
    expect(JSON.stringify(approvals.body)).not.toContain('page-foreign');
  });

  test('gallery-wide permissions do not expand into CRM workflow authority', async () => {
    const viewSteps = await request(app)
      .get(`/api/admin/workflows/runs/${foreignEventRunId}/steps`).set(auth(viewAllToken));
    expect(viewSteps.status).toBe(200);

    const viewAct = await request(app)
      .post(`/api/admin/workflows/approvals/${foreignEventApprovalId}/confirm`)
      .set(auth(viewAllToken));
    expect(viewAct.status).toBe(404);

    const manageAct = await request(app)
      .post(`/api/admin/workflows/approvals/${foreignEventApprovalId}/confirm`)
      .set(auth(manageAllToken));
    expect(manageAct.status).toBe(200);

    const invoiceRows = await db('invoices').insert({
      invoice_number: 'WF-FOREIGN-1', customer_account_id: customerId,
      event_id: foreignEventId, issue_date: '2026-10-06', due_date: '2026-10-20',
      created_by_admin_id: manageAllAdminId,
    }).returning('id');
    const invoiceId = invoiceRows[0]?.id ?? invoiceRows[0];
    const runRows = await db('workflow_runs').insert({
      workflow_id: createdId, version: 2, trigger_event: 'invoice.sent',
      entity_type: 'invoice', entity_id: invoiceId, status: 'waiting', current_node: 'n2',
      context: JSON.stringify({ vars: { customerEmail: 'crm-secret@example.com' } }),
      dedup_key: 'scope:foreign-crm',
    }).returning('id');
    const invoiceRunId = runRows[0]?.id ?? runRows[0];
    const approvalRows = await db('workflow_approvals').insert({
      run_id: invoiceRunId, node_key: 'n2', type: 'payment_confirm', status: 'pending',
      token_hash: 'crm'.padEnd(64, '0'), payload: JSON.stringify({ marker: 'crm-secret' }),
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    }).returning('id');
    const invoiceApprovalId = approvalRows[0]?.id ?? approvalRows[0];

    for (const actorToken of [viewAllToken, manageAllToken]) {
      const runs = await request(app).get(`/api/admin/workflows/${createdId}/runs`).set(auth(actorToken));
      expect(runs.status).toBe(200);
      expect(runs.body.map((run) => run.id)).not.toContain(invoiceRunId);
      expect(JSON.stringify(runs.body)).not.toContain('crm-secret@example.com');
    }
    const crmAct = await request(app)
      .post(`/api/admin/workflows/approvals/${invoiceApprovalId}/confirm`)
      .set(auth(manageAllToken));
    expect(crmAct.status).toBe(404);
    expect((await db('workflow_approvals').where({ id: invoiceApprovalId }).first('status')).status)
      .toBe('pending');
  });

  test('enforces CRM creator fallbacks and direct-lineage precedence', async () => {
    const workflows = require('../../src/services/workflows');
    const actor = { id: scopedAdminId, roleName: 'workflow_auditor' };
    const idOf = (rows) => rows[0]?.id ?? rows[0];
    const insertId = async (table, row) => idOf(await db(table).insert(row).returning('id'));

    const ownCustomerId = await insertId('customer_accounts', {
      email: 'workflow-owned-customer@example.com', display_name: 'Workflow owned customer',
      password_hash: 'x', preferred_language: 'de', is_active: 1,
      created_by_admin_id: scopedAdminId, created_at: new Date(),
    });
    const ownQuoteByCreator = await insertId('quotes', {
      quote_number: 'WF-MATRIX-Q1', customer_account_id: ownCustomerId,
      issue_date: '2026-10-06', created_by_admin_id: scopedAdminId,
    });
    const ownQuoteByEvent = await insertId('quotes', {
      quote_number: 'WF-MATRIX-Q2', customer_account_id: ownCustomerId,
      issue_date: '2026-10-06', converted_event_id: ownEventId,
    });
    const foreignQuoteByEvent = await insertId('quotes', {
      quote_number: 'WF-MATRIX-Q3', customer_account_id: ownCustomerId,
      issue_date: '2026-10-06', converted_event_id: foreignEventId,
      created_by_admin_id: scopedAdminId,
    });
    const ownContractByCreator = await insertId('contracts', {
      contract_number: 'WF-MATRIX-C1', customer_account_id: ownCustomerId,
      issue_date: '2026-10-06', created_by_admin_id: scopedAdminId,
    });
    const ownContractByQuote = await insertId('contracts', {
      contract_number: 'WF-MATRIX-C2', customer_account_id: ownCustomerId,
      issue_date: '2026-10-06', source_quote_id: ownQuoteByEvent,
    });
    const conflictingContract = await insertId('contracts', {
      contract_number: 'WF-MATRIX-C3', customer_account_id: ownCustomerId,
      issue_date: '2026-10-06', source_quote_id: ownQuoteByEvent,
      converted_event_id: foreignEventId, created_by_admin_id: scopedAdminId,
    });
    const invoiceByCreator = await insertId('invoices', {
      invoice_number: 'WF-MATRIX-I1', customer_account_id: ownCustomerId,
      issue_date: '2026-10-06', due_date: '2026-10-20',
      created_by_admin_id: scopedAdminId,
    });
    const invoiceByQuote = await insertId('invoices', {
      invoice_number: 'WF-MATRIX-I2', customer_account_id: ownCustomerId,
      issue_date: '2026-10-06', due_date: '2026-10-20',
      source_quote_id: ownQuoteByEvent,
    });
    const invoiceByContract = await insertId('invoices', {
      invoice_number: 'WF-MATRIX-I3', customer_account_id: ownCustomerId,
      issue_date: '2026-10-06', due_date: '2026-10-20',
      source_contract_id: ownContractByQuote,
    });
    const conflictingInvoice = await insertId('invoices', {
      invoice_number: 'WF-MATRIX-I4', customer_account_id: ownCustomerId,
      issue_date: '2026-10-06', due_date: '2026-10-20',
      source_contract_id: conflictingContract, source_quote_id: ownQuoteByEvent,
      created_by_admin_id: scopedAdminId,
    });
    const directForeignInvoice = await insertId('invoices', {
      invoice_number: 'WF-MATRIX-I5', customer_account_id: ownCustomerId,
      issue_date: '2026-10-06', due_date: '2026-10-20', event_id: foreignEventId,
      source_contract_id: ownContractByQuote, created_by_admin_id: scopedAdminId,
    });
    const foreignQuoteInvoice = await insertId('invoices', {
      invoice_number: 'WF-MATRIX-I6', customer_account_id: ownCustomerId,
      issue_date: '2026-10-06', due_date: '2026-10-20',
      source_quote_id: foreignQuoteByEvent, created_by_admin_id: scopedAdminId,
    });

    const cases = [
      ['customer', ownCustomerId, true],
      ['customer', customerId, false],
      ['quote', ownQuoteByCreator, true],
      ['quote', ownQuoteByEvent, true],
      ['quote', foreignQuoteByEvent, false],
      ['contract', ownContractByCreator, true],
      ['contract', ownContractByQuote, true],
      ['contract', conflictingContract, false],
      ['invoice', invoiceByCreator, true],
      ['invoice', invoiceByQuote, true],
      ['invoice', invoiceByContract, true],
      ['invoice', conflictingInvoice, false],
      ['invoice', directForeignInvoice, false],
      ['invoice', foreignQuoteInvoice, false],
    ];
    for (const [entityType, entityId, expected] of cases) {
      expect(await workflows.canAccessWorkflowEntity(actor, entityType, entityId, { mode: 'view' }))
        .toBe(expected);
    }

    const runIds = [];
    const expectedRunIds = [];
    for (const [index, [entityType, entityId, expected]] of cases.entries()) {
      const runId = await insertId('workflow_runs', {
        workflow_id: createdId, version: 2, trigger_event: 'matrix.test',
        entity_type: entityType, entity_id: entityId, status: 'done',
        context: JSON.stringify({ vars: { index } }), dedup_key: `scope:matrix:${index}`,
      });
      runIds.push(runId);
      if (expected) expectedRunIds.push(runId);
    }
    const query = db('workflow_runs as matrix_run').whereIn('matrix_run.id', runIds)
      .select('matrix_run.id').orderBy('matrix_run.id');
    workflows.scopeWorkflowRunsQuery(query, actor, { alias: 'matrix_run', mode: 'view' });
    expect((await query).map((row) => row.id)).toEqual(expectedRunIds);
    for (const [index, runId] of runIds.entries()) {
      expect(await workflows.canAccessWorkflowRun(actor, runId, { mode: 'view' }))
        .toBe(cases[index][2]);
    }
  });

  test('enforces document and request lineage before project, creator, or customer fallbacks', async () => {
    const workflows = require('../../src/services/workflows');
    const actor = { id: scopedAdminId, roleName: 'workflow_auditor' };
    const idOf = (rows) => rows[0]?.id ?? rows[0];
    const insertId = async (table, row) => idOf(await db(table).insert(row).returning('id'));
    const ownCustomerId = await insertId('customer_accounts', {
      email: 'workflow-doc-customer@example.com', display_name: 'Workflow document customer',
      password_hash: 'x', preferred_language: 'de', is_active: 1,
      created_by_admin_id: scopedAdminId, created_at: new Date(),
    });
    const ownProjectId = await insertId('projects', {
      name: 'Workflow owned project', customer_account_id: ownCustomerId,
      status: 'active', created_by: scopedAdminId,
    });
    const ownQuoteId = await insertId('quotes', {
      quote_number: 'WF-DOC-Q1', customer_account_id: ownCustomerId,
      issue_date: '2026-10-06', converted_event_id: ownEventId,
    });
    const ownContractId = await insertId('contracts', {
      contract_number: 'WF-DOC-C1', customer_account_id: ownCustomerId,
      issue_date: '2026-10-06', converted_event_id: ownEventId,
    });
    const conflictingContractId = await insertId('contracts', {
      contract_number: 'WF-DOC-C2', customer_account_id: ownCustomerId,
      issue_date: '2026-10-06', source_quote_id: ownQuoteId,
      converted_event_id: foreignEventId, created_by_admin_id: scopedAdminId,
    });
    let documentSequence = 0;
    const insertDocument = (overrides) => {
      documentSequence += 1;
      return insertId('customer_documents', {
        customer_account_id: ownCustomerId, uploader_type: 'admin', uploader_id: scopedAdminId,
        original_name: `matrix-${documentSequence}.pdf`,
        storage_key: `workflow-matrix/${documentSequence}.pdf`, mime_type: 'application/pdf',
        size_bytes: 10, sha256: String(documentSequence).padStart(64, '0'), status: 'clean',
        ...overrides,
      });
    };
    const documentByProject = await insertDocument({ project_id: ownProjectId });
    const documentByCustomer = await insertDocument({});
    const documentByContract = await insertDocument({ contract_id: ownContractId });
    const conflictingDocument = await insertDocument({ contract_id: conflictingContractId });
    const directForeignDocument = await insertDocument({
      event_id: foreignEventId, contract_id: ownContractId, project_id: ownProjectId,
    });
    const requestByCreator = await insertId('customer_document_requests', {
      customer_account_id: customerId, title: 'Creator fallback', created_by_admin_id: scopedAdminId,
    });
    const requestByCustomer = await insertId('customer_document_requests', {
      customer_account_id: ownCustomerId, title: 'Customer fallback',
    });
    const foreignCreatorRequest = await insertId('customer_document_requests', {
      customer_account_id: ownCustomerId, title: 'Creator precedence', created_by_admin_id: manageAllAdminId,
    });
    const conflictingRequest = await insertId('customer_document_requests', {
      customer_account_id: ownCustomerId, title: 'Contract precedence',
      contract_id: conflictingContractId, created_by_admin_id: scopedAdminId,
    });
    const directForeignRequest = await insertId('customer_document_requests', {
      customer_account_id: ownCustomerId, title: 'Event precedence', event_id: foreignEventId,
      contract_id: ownContractId, created_by_admin_id: scopedAdminId,
    });

    const cases = [
      ['customer_document', documentByProject, true],
      ['customer_document', documentByCustomer, true],
      ['customer_document', documentByContract, true],
      ['customer_document', conflictingDocument, false],
      ['customer_document', directForeignDocument, false],
      ['customer_document_request', requestByCreator, true],
      ['customer_document_request', requestByCustomer, true],
      ['customer_document_request', foreignCreatorRequest, false],
      ['customer_document_request', conflictingRequest, false],
      ['customer_document_request', directForeignRequest, false],
    ];
    for (const [entityType, entityId, expected] of cases) {
      expect(await workflows.canAccessWorkflowEntity(actor, entityType, entityId, { mode: 'view' }))
        .toBe(expected);
    }

    const runIds = [];
    const expectedRunIds = [];
    for (const [index, [entityType, entityId, expected]] of cases.entries()) {
      const runId = await insertId('workflow_runs', {
        workflow_id: createdId, version: 2, trigger_event: 'document.matrix',
        entity_type: entityType, entity_id: entityId, status: 'done',
        context: JSON.stringify({ vars: { index } }), dedup_key: `scope:document-matrix:${index}`,
      });
      runIds.push(runId);
      if (expected) expectedRunIds.push(runId);
    }
    const query = db('workflow_runs as matrix_run').whereIn('matrix_run.id', runIds)
      .select('matrix_run.id').orderBy('matrix_run.id');
    workflows.scopeWorkflowRunsQuery(query, actor, { alias: 'matrix_run', mode: 'view' });
    expect((await query).map((row) => row.id)).toEqual(expectedRunIds);
  });

  test('rejects a foreign entity on test-run and attributes an owned test-run', async () => {
    const before = await db('workflow_runs').where({ workflow_id: createdId }).count({ count: '*' }).first();
    const denied = await request(app).post(`/api/admin/workflows/${createdId}/test-run`)
      .set(auth(scopedToken)).send({ entityId: foreignEventId, dryRun: true });
    expect(denied.status).toBe(404);
    const deniedCustomer = await request(app).post(`/api/admin/workflows/${createdId}/test-run`)
      .set(auth(scopedToken))
      .send({ entityId: ownEventId, dryRun: true, payload: { customerAccountId: customerId } });
    expect(deniedCustomer.status).toBe(404);
    const mismatched = await request(app).post(`/api/admin/workflows/${createdId}/test-run`)
      .set(auth(scopedToken))
      .send({ entityType: 'invoice', entityId: ownEventId, dryRun: true });
    expect(mismatched.status).toBe(400);
    const unboundLive = await request(app).post(`/api/admin/workflows/${createdId}/test-run`)
      .set(auth(scopedToken)).send({ dryRun: false, payload: { recipient: 'victim@example.com' } });
    expect(unboundLive.status).toBe(400);
    const after = await db('workflow_runs').where({ workflow_id: createdId }).count({ count: '*' }).first();
    expect(Number(after.count)).toBe(Number(before.count));

    const allowed = await request(app).post(`/api/admin/workflows/${createdId}/test-run`)
      .set(auth(scopedToken)).send({ entityId: ownEventId, dryRun: true });
    expect(allowed.status).toBe(200);
    const run = await db('workflow_runs').where({ id: allowed.body.runId }).first();
    expect(Number(run.initiated_by_admin_id)).toBe(Number(scopedAdminId));
    expect(run.entity_type).toBe('event');

    const ownedLive = await request(app).post(`/api/admin/workflows/${createdId}/test-run`)
      .set(auth(scopedToken)).send({ entityId: ownEventId, dryRun: false });
    expect(ownedLive.status).toBe(400);

    const privateTest = await request(app).post(`/api/admin/workflows/${createdId}/test-run`)
      .set(auth(scopedToken)).send({ payload: { marker: 'initiator-only' }, dryRun: true });
    expect(privateTest.status).toBe(200);
    const foreignRead = await request(app)
      .get(`/api/admin/workflows/runs/${privateTest.body.runId}/steps`).set(auth(viewAllToken));
    expect(foreignRead.status).toBe(404);
  });

  test('invoice_paid refuses a non-invoice entity before any invoice lookup', async () => {
    const condition = require('../../src/services/workflows').registry.getCondition('invoice_paid');
    const result = await condition({
      run: { entity_type: 'event', entity_id: ownEventId },
      db: () => { throw new Error('invoice lookup must not run'); },
    });
    expect(result).toBe(false);
  });

  test('allows only super_admin to cascade-delete workflow execution history', async () => {
    const before = {
      workflows: Number((await db('workflows').where({ id: createdId }).count({ count: '*' }).first()).count),
      runs: Number((await db('workflow_runs').where({ workflow_id: createdId }).count({ count: '*' }).first()).count),
      steps: Number((await db('workflow_run_steps').count({ count: '*' }).first()).count),
      approvals: Number((await db('workflow_approvals').count({ count: '*' }).first()).count),
    };
    const res = await request(app).delete(`/api/admin/workflows/${createdId}`).set(auth(scopedToken));
    expect(res.status).toBe(403);
    expect({
      workflows: Number((await db('workflows').where({ id: createdId }).count({ count: '*' }).first()).count),
      runs: Number((await db('workflow_runs').where({ workflow_id: createdId }).count({ count: '*' }).first()).count),
      steps: Number((await db('workflow_run_steps').count({ count: '*' }).first()).count),
      approvals: Number((await db('workflow_approvals').count({ count: '*' }).first()).count),
    }).toEqual(before);
  });

  test('a role without workflows.manage is forbidden from writing', async () => {
    const res = await request(app).post('/api/admin/workflows').set(auth(noPermToken)).send(sampleGraph);
    expect(res.status).toBe(403);
  });
});
