/**
 * Customer addresses inside webhook deliveries and workflow run data are
 * customers.view data.
 *
 * A delivery's payload (event.customer_email), the receiver's response and
 * the error text, a run's context variables (customerEmail), a step's result
 * (sent_to) and an approval's variables reached any admin with
 * settings.view or workflows.view. For an admin without customers.view the
 * address-shaped text in them comes back as `…`; a Super Admin and a role
 * holding customers.view keep everything.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-integration-redact-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'integration-redact-test-secret';

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');
const { clearPermissionCache } = require('../../src/middleware/permissions');

const ADDRESS = 'anna@kunde.example';

describe('webhook deliveries and workflow runs — addresses need customers.view', () => {
  let db; let cleanup; let webhooksApp; let workflowsApp;
  let superTok; let readerTok; let customerReaderTok;
  let webhookId; let deliveryId; let workflowId; let runId;

  const auth = (req, tok) => req.set('Authorization', `Bearer ${tok}`);
  const insertId = async (table, row) => {
    const ins = await db(table).insert(row).returning('id');
    return ins[0]?.id ?? ins[0];
  };
  const adminWithPermissions = async (name, permissions) => {
    const roleId = await insertId('roles', { name, display_name: name });
    for (const perm of await db('permissions').whereIn('name', permissions)) {
      await db('role_permissions').insert({ role_id: roleId, permission_id: perm.id });
    }
    const adminId = await insertId('admin_users', {
      username: name, email: `${name}@studio.example`, password_hash: 'x',
      must_change_password: false, role_id: roleId, created_at: new Date().toISOString(),
    });
    return mintAdminToken(adminId);
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId: superId } = await seedMinimal(db);
    await assignAdminRole(db, superId, 'super_admin');
    superTok = mintAdminToken(superId);

    const perms = ['settings.view', 'workflows.view'];
    readerTok = await adminWithPermissions('integration-reader', perms);
    customerReaderTok = await adminWithPermissions('integration-customer-reader', [...perms, 'customers.view']);
    clearPermissionCache();
    await db('feature_flags').insert({ key: 'workflows', value: 1 }).onConflict('key').merge({ value: 1 });

    webhookId = await insertId('webhooks', {
      name: 'crm', url: 'https://hooks.example/in', secret: 's'.repeat(32), secret_preview: 'ssssssss',
      events: JSON.stringify(['event.created']), active: true, created_by: superId,
      created_at: new Date().toISOString(),
    });
    deliveryId = await insertId('webhook_deliveries', {
      webhook_id: webhookId, event_type: 'event.created', status: 'failed', attempt_count: 3,
      payload: JSON.stringify({ id: 'd1', data: { event: { name: 'Anna & Tom', customer_email: ADDRESS } } }),
      response_status: 422, response_body: `{"error":"unknown contact ${ADDRESS}"}`,
      last_error: `HTTP 422 for ${ADDRESS}`, created_at: new Date().toISOString(),
    });

    // An ownerless gallery: every role reaches the run.
    const eventId = await insertId('events', {
      slug: 'run-gallery', share_link: '/gallery/run-gallery/share', event_type: 'wedding', event_name: 'Run',
      event_date: '2027-01-10', host_email: 'host@studio.example', admin_email: 'admin@studio.example',
      password_hash: 'x', created_by: null,
    });
    workflowId = await insertId('workflows', {
      name: 'Send gallery', trigger_type: 'gallery.published', enabled: false, created_by: superId,
    });
    runId = await insertId('workflow_runs', {
      workflow_id: workflowId, version: 1, trigger_event: 'gallery.published',
      entity_type: 'event', entity_id: eventId, status: 'waiting', current_node: 'n2',
      context: JSON.stringify({ vars: { customerEmail: ADDRESS, eventName: 'Run' } }),
      dedup_key: 'redact:run',
    });
    await db('workflow_run_steps').insert({
      run_id: runId, node_key: 'n1', node_type: 'action', status: 'done',
      result: JSON.stringify({ sent_to: ADDRESS, template: 'gallery_created' }),
    });
    await db('workflow_approvals').insert({
      run_id: runId, node_key: 'n2', type: 'payment_confirm', status: 'pending',
      token_hash: 'r'.padEnd(64, '0'),
      payload: JSON.stringify({ prompt: 'Confirm?', vars: { customerEmail: ADDRESS } }),
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });

    webhooksApp = buildRouteApp('/api/admin/webhooks', require('../../src/routes/adminWebhooks'));
    workflowsApp = buildRouteApp('/api/admin/workflows', require('../../src/routes/adminWorkflows'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  const deliveries = (tok) => auth(request(webhooksApp).get(`/api/admin/webhooks/${webhookId}/deliveries`), tok);
  const delivery = (tok) => auth(request(webhooksApp).get(`/api/admin/webhooks/${webhookId}/deliveries/${deliveryId}`), tok);
  const runs = (tok) => auth(request(workflowsApp).get(`/api/admin/workflows/${workflowId}/runs`), tok);
  const steps = (tok) => auth(request(workflowsApp).get(`/api/admin/workflows/runs/${runId}/steps`), tok);
  const approvals = (tok) => auth(request(workflowsApp).get('/api/admin/workflows/approvals'), tok);

  it('removes addresses from the webhook delivery list and detail', async () => {
    const list = await deliveries(readerTok);
    expect(list.status).toBe(200);
    expect(list.body.deliveries[0].last_error).toBe('HTTP 422 for …');

    const res = await delivery(readerTok);
    expect(res.status).toBe(200);
    expect(res.body.payload.data.event).toEqual({ name: 'Anna & Tom', customer_email: '…' });
    expect(res.body.response_body).toBe('{"error":"unknown contact …"}');
    expect(res.body.last_error).toBe('HTTP 422 for …');
    expect(JSON.stringify(res.body)).not.toContain(ADDRESS);

    for (const tok of [superTok, customerReaderTok]) {
      expect((await deliveries(tok)).body.deliveries[0].last_error).toContain(ADDRESS);
      const full = (await delivery(tok)).body;
      expect(full.payload.data.event.customer_email).toBe(ADDRESS);
      expect(full.response_body).toContain(ADDRESS);
      expect(full.last_error).toContain(ADDRESS);
    }
  });

  it('removes addresses from workflow runs, steps and approvals', async () => {
    const run = (await runs(readerTok)).body.find((r) => r.id === runId);
    expect(run.context.vars).toEqual({ customerEmail: '…', eventName: 'Run' });
    const [step] = (await steps(readerTok)).body;
    expect(step.result).toEqual({ sent_to: '…', template: 'gallery_created' });
    const approval = (await approvals(readerTok)).body.find((a) => a.run_id === runId);
    expect(approval.payload.vars.customerEmail).toBe('…');
    for (const res of [await runs(readerTok), await steps(readerTok), await approvals(readerTok)]) {
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(ADDRESS);
    }

    for (const tok of [superTok, customerReaderTok]) {
      expect((await runs(tok)).body.find((r) => r.id === runId).context.vars.customerEmail).toBe(ADDRESS);
      expect((await steps(tok)).body[0].result.sent_to).toBe(ADDRESS);
      expect((await approvals(tok)).body.find((a) => a.run_id === runId).payload.vars.customerEmail).toBe(ADDRESS);
    }
  });
});
