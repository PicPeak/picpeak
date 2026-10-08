'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, createPublicToken, buildRouteApp } = require('./helpers/crmDb');
const formatBoolean = value => require('../../src/utils/dbCompat').formatBoolean(value);

let db, cleanup, ownerId, otherId, superId, customerId, apps, ids, tokens;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId: ownerId, customerId } = await seedMinimal(db));
  const [role] = await db('roles').insert({ name: 'crm_ownership_test', display_name: 'CRM test photographer' }).returning('id');
  const roleId = role.id ?? role;
  const permissions = await db('permissions').whereIn('name', ['quotes.view', 'quotes.manage', 'bills.view', 'bills.manage', 'contracts.view', 'contracts.manage']);
  expect(permissions).toHaveLength(6);
  await db('role_permissions').insert(permissions.map(p => ({ role_id: roleId, permission_id: p.id })));
  await db('admin_users').where('id', ownerId).update({ role_id: roleId, is_active: formatBoolean(true) });
  const [other] = await db('admin_users').insert({ username: 'other-photographer', email: 'other@example.test', password_hash: 'unused', role_id: roleId,
    is_active: formatBoolean(true), must_change_password: formatBoolean(false) }).returning('id');
  otherId = other.id ?? other;
  const [superAdmin] = await db('admin_users').insert({ username: 'studio-superadmin', email: 'studio@example.test', password_hash: 'unused',
    is_active: formatBoolean(true), must_change_password: formatBoolean(false) }).returning('id');
  superId = superAdmin.id ?? superAdmin;
  await assignAdminRole(db, superId);
  require('../../src/middleware/permissions').clearPermissionCache();
  for (const key of ['quotes', 'bills', 'contracts']) await db('feature_flags').where({ key }).update({ value: formatBoolean(true) });
  ids = {};
  for (const [root, numberColumn] of [['quotes', 'quote_number'], ['invoices', 'invoice_number'], ['contracts', 'contract_number']]) {
    ids[root] = [];
    for (const [label, creator] of [['own', ownerId], ['foreign', otherId], ['legacy', null]]) {
      const [inserted] = await db(root).insert({ [numberColumn]: `ACL-${root}-${label}`, customer_account_id: customerId,
        issue_date: '2026-06-01', ...(root === 'invoices' ? { due_date: '2026-06-30' } : {}),
        created_by_admin_id: creator, deal_uuid: `acl-${root}-${label}` }).returning('id');
      ids[root].push(inserted.id ?? inserted);
    }
  }
  tokens = { owner: mintAdminToken(ownerId), other: mintAdminToken(otherId), super: mintAdminToken(superId) };
  apps = {
    quotes: buildRouteApp('/api/admin/quotes', require('../../src/routes/adminQuotes')),
    invoices: buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices')),
    contracts: buildRouteApp('/api/admin/contracts', require('../../src/routes/adminContracts')),
  };
});
afterAll(async () => { if (cleanup) await cleanup(); });

const auth = who => ({ Authorization: `Bearer ${tokens[who]}` });

test.each(['quotes', 'invoices', 'contracts'])('real typed admin auth filters %s lists and leaves owner/super-admin detail usable', async root => {
  const list = await request(apps[root]).get(`/api/admin/${root}`).set(auth('owner'));
  expect(list.status).toBe(200);
  expect(list.body[root].map(r => r.id)).toEqual([ids[root][0]]);
  expect((list.body.pagination || list.body).total).toBe(1);
  expect((await request(apps[root]).get(`/api/admin/${root}/${ids[root][0]}`).set(auth('owner'))).status).toBe(200);
  expect((await request(apps[root]).get(`/api/admin/${root}/${ids[root][1]}`).set(auth('other'))).status).toBe(200);
  expect((await request(apps[root]).get(`/api/admin/${root}/${ids[root][1]}`).set(auth('super'))).status).toBe(200);
  expect((await request(apps[root]).get(`/api/admin/${root}/${ids[root][2]}`).set(auth('super'))).status).toBe(200);
});

test.each([
  ['quotes', ['', '/history', '/pdf'], ['/send', '/duplicate', '/accept', '/decline', '/reissue', '/convert', '/convert-to-invoice', '/convert-to-contract']],
  ['invoices', ['', '/history', '/pdf', '/payment-log'], ['/send', '/mark-paid', '/send-reminder', '/test-payment-check', '/reissue', '/cancel', '/release-for-delivery']],
  ['contracts', ['', '/documents', '/pdf', '/signed-pdf', '/certificate', '/history', '/audit-trail', '/preview'],
    ['/send', '/cancel', '/convert-to-event', '/convert-to-invoice', '/resend-signed', '/restamp-signatures', '/countersign']],
])('%s foreign detail, artifacts, evidence and mutations are indistinguishable from missing records', async (root, reads, writes) => {
  const id = ids[root][1];
  for (const suffix of reads) {
    const result = await request(apps[root]).get(`/api/admin/${root}/${id}${suffix}`).set(auth('owner'));
    expect({ suffix, status: result.status }).toEqual({ suffix, status: 404 });
  }
  for (const suffix of writes) {
    const result = await request(apps[root]).post(`/api/admin/${root}/${id}${suffix}`).set(auth('owner')).send({ amountMinor: 1, action: 'accept' });
    expect({ suffix, status: result.status }).toEqual({ suffix, status: 404 });
  }
  expect((await request(apps[root]).put(`/api/admin/${root}/${id}`).set(auth('owner')).send({ title: 'tamper' })).status).toBe(404);
  expect((await db(root).where('id', id).first()).created_by_admin_id).toBe(otherId);
});

test('contract signer, integrity and signed-upload gates reject before evidence or file side effects', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/routes/adminContracts.js'), 'utf8');
  const id = ids.contracts[1];
  for (const suffix of ['/signers', '/signing-evidence', '/verify-integrity', '/paper-signature-coverage', '/send-preview']) {
    if (!source.includes(`'/:id${suffix}'`)) continue; // stable does not acquire main-only signing features
    expect((await request(apps.contracts).get(`/api/admin/contracts/${id}${suffix}`).set(auth('owner'))).status).toBe(404);
  }
  const upload = await request(apps.contracts).post(`/api/admin/contracts/${id}/upload-signed-pdf`).set(auth('owner'))
    .attach('file', Buffer.from('%PDF-1.4\n%%EOF'), { filename: 'signed.pdf', contentType: 'application/pdf' });
  expect(upload.status).toBe(404);
  for (const alternateId of [`0${id}`, `+${id}`, `%2B${id}`]) {
    const result = await request(apps.contracts).post(`/api/admin/contracts/${alternateId}/upload-signed-pdf`).set(auth('owner'))
      .attach('file', Buffer.from('%PDF-1.4\\n%%EOF'), { filename: 'signed.pdf', contentType: 'application/pdf' });
    expect(result.status).toBe(404);
  }
  expect(fs.existsSync(path.join(process.env.STORAGE_PATH, 'uploads/contracts/signed'))).toBe(false);
});

test('gallery/customer token types cannot be used as an admin CRM actor, and body claims cannot widen access', async () => {
  for (const type of ['gallery', 'customer']) {
    const token = jwt.sign({ id: ownerId, customerId, type }, process.env.JWT_SECRET, { issuer: 'picpeak-auth', expiresIn: '1h' });
    expect((await request(apps.quotes).get('/api/admin/quotes').set('Authorization', `Bearer ${token}`)).status).toBe(403);
  }
  const forgedRole = mintAdminToken(ownerId, { extraClaims: { role: 'super_admin', roleName: 'super_admin' } });
  expect((await request(apps.quotes).get(`/api/admin/quotes/${ids.quotes[1]}`).set('Authorization', `Bearer ${forgedRole}`)).status).toBe(404);
});

test('a validated public quote capability still works independently of photographer ownership', async () => {
  const id = ids.quotes[1];
  await db('quotes').where('id', id).update({ status: 'sent' });
  const publicToken = await createPublicToken(db, 'quote_action_tokens', { quote_id: id });
  const row = await db('quote_action_tokens').where('token', publicToken).first();
  const grant = await require('../../src/services/publicDocumentVerificationService').issueGrant('quote', row, publicToken);
  const app = buildRouteApp('/api/public/quotes', require('../../src/routes/publicQuotes'));
  expect((await request(app).get(`/api/public/quotes/${publicToken}`).set('X-Document-Access', grant)).status).toBe(200);
  expect((await request(app).get(`/api/public/quotes/${'0'.repeat(64)}`).set('X-Document-Access', grant)).status).toBe(404);
});

test('real API-token authentication carries its live owner into shared CRM services', async () => {
  const { apiTokenAuth, requireApiScope, generateApiToken } = require('../../src/middleware/apiTokenAuth');
  const { requirePermission } = require('../../src/middleware/permissions');
  const token = generateApiToken();
  await db('api_tokens').insert({ name: 'CRM scope fixture', hashed_token: token.hashed, preview: token.preview,
    scopes: 'read', created_by: ownerId });
  // There is no dedicated CRM v1 router today. Exercise its real shared auth
  // entry against the same service rather than mocking a principal.
  const router = require('express').Router();
  router.get('/:id', apiTokenAuth, requireApiScope('read'), requirePermission('bills.view'), async (req, res, next) => {
    try {
      const result = await require('../../src/services/invoiceService').getInvoiceById(Number(req.params.id));
      return result ? res.json({ id: result.invoice.id }) : res.sendStatus(404);
    } catch (error) { return next(error); }
  });
  const app = buildRouteApp('/api/v1/crm-fixture', router);
  const get = id => request(app).get(`/api/v1/crm-fixture/${id}`).set('Authorization', `Bearer ${token.plaintext}`);
  expect((await get(ids.invoices[0])).status).toBe(200);
  expect((await get(ids.invoices[1])).status).toBe(404);
  await db('api_tokens').where('hashed_token', token.hashed).update({ revoked_at: new Date().toISOString() });
  expect((await get(ids.invoices[0])).status).toBe(401);
});

test('direct shared-service callers retain ownership and fail without an explicit execution context', async () => {
  const { loadCrmActor, withCrmActor, withoutCrmContext } = require('../../src/database/crmAccess');
  const principal = await loadCrmActor({ id: ownerId });
  for (const [root, service, method] of [
    ['quotes', 'quoteService', 'getQuoteById'], ['invoices', 'invoiceService', 'getInvoiceById'],
    ['contracts', 'contractService', 'getContractById'],
  ]) {
    const get = require(`../../src/services/${service}`)[method];
    expect(await withCrmActor(principal, () => get(ids[root][0]))).not.toBeNull();
    expect(await withCrmActor(principal, () => get(ids[root][1]))).toBeNull();
    await expect(withoutCrmContext(() => get(ids[root][0]))).rejects.toMatchObject({ statusCode: 403 });
  }
  await expect(withCrmActor(principal, () => require('../../src/services/invoiceService')
    .markPaid(ids.invoices[1], { amountMinor: 1 }, ownerId))).rejects.toMatchObject({ statusCode: 404 });
  expect((await db('invoice_payment_log').where('invoice_id', ids.invoices[1])).length).toBe(0);
});

test('workflow CRM authority is entity-bound and rehydrates the originating live actor after a wait', async () => {
  const { loadCrmActor, withCrmActor, withTrustedCrmAccess } = require('../../src/database/crmAccess');
  const registry = require('../../src/services/workflows/registry');
  const engine = require('../../src/services/workflows/engine');
  registry.registerAction('crm_scope_fixture', async ctx => ({ updated: await ctx.db('invoices')
    .where('id', ctx.node.config.targetId).update({ status: 'overdue' }) }));
  const flag = await db('feature_flags').where('key', 'workflows').first();
  if (flag) await db('feature_flags').where('id', flag.id).update({ value: formatBoolean(true) });
  else await db('feature_flags').insert({ key: 'workflows', value: formatBoolean(true) });
  let serial = 0;
  async function graph({ creator = ownerId, builtin = false, targetId = ids.invoices[0] } = {}) {
    const [inserted] = await db('workflows').insert({ name: `CRM fixture ${++serial}`, version: 1,
      trigger_type: 'crm.scope.fixture', enabled: formatBoolean(true), created_by: creator,
      is_builtin: formatBoolean(builtin), builtin_key: builtin ? 'invoice_dunning' : null }).returning('id');
    const workflowId = inserted.id ?? inserted;
    await db('workflow_nodes').insert([
      { workflow_id: workflowId, version: 1, node_key: 'start', type: 'trigger', config: '{}' },
      { workflow_id: workflowId, version: 1, node_key: 'wait', type: 'wait', config: '{"delayMinutes":1}' },
      { workflow_id: workflowId, version: 1, node_key: 'update', type: 'action', config: JSON.stringify({ action: 'crm_scope_fixture', targetId }) },
    ]);
    await db('workflow_edges').insert(['start', 'wait'].map((from, i) => ({ workflow_id: workflowId, version: 1,
      from_node: from, to_node: ['wait', 'update'][i] })));
    return workflowId;
  }
  const actor = await loadCrmActor({ id: ownerId });
  const wf = await graph({ targetId: ids.invoices[1] });
  const [runId] = await withCrmActor(actor, () => engine.emitWorkflowEvent('crm.scope.fixture', {
    entityType: 'invoice', entityId: ids.invoices[0], targetWorkflowId: wf,
    payload: { crmInitiatedByAdminId: superId, entityId: ids.invoices[1] },
  }));
  expect(JSON.parse((await db('workflow_runs').where('id', runId).first()).context).crmInitiatedByAdminId).toBe(ownerId);
  await withTrustedCrmAccess('isolated scheduler fixture', () => engine.resumeRun(runId));
  expect((await db('invoices').where('id', ids.invoices[1]).first()).status).not.toBe('overdue');
  const step = await db('workflow_run_steps').where({ run_id: runId, node_key: 'update' }).first();
  expect(JSON.parse(step.result).updated).toBe(0);

  // Shipped system workflows still act on their explicit entity, not another
  // photographer's document or another same-owner deal chosen by the graph.
  const builtIn = await graph({ creator: null, builtin: true });
  const [systemRun] = await withTrustedCrmAccess('isolated scheduler fixture', () => engine.emitWorkflowEvent('crm.scope.fixture', {
    entityType: 'invoice', entityId: ids.invoices[0], targetWorkflowId: builtIn,
  }));
  await withTrustedCrmAccess('isolated scheduler fixture', () => engine.resumeRun(systemRun));
  expect((await db('invoices').where('id', ids.invoices[0]).first()).status).toBe('overdue');

  const untrustedGraph = await graph({ creator: superId, targetId: ids.invoices[1] });
  const [untrustedRun] = await engine.emitWorkflowEvent('crm.scope.fixture', {
    entityType: 'invoice', entityId: ids.invoices[1], targetWorkflowId: untrustedGraph,
  });
  await engine.resumeRun(untrustedRun);
  expect((await db('workflow_runs').where('id', untrustedRun).first()).status).toBe('failed');
  expect((await db('invoices').where('id', ids.invoices[1]).first()).status).not.toBe('overdue');
});
