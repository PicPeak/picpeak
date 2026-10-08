'use strict';

/**
 * CRM document ownership must not break the work that is not one admin's:
 * operator CLIs, backups, the mail queue, and workflow runs. Each case here
 * failed or silently did less while the ownership policy treated a system job
 * as the admin who happened to start it (or as nobody at all).
 */

const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AsyncResource } = require('async_hooks');
const { spawnSync } = require('child_process');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp } = require('./helpers/crmDb');
const formatBoolean = value => require('../../src/utils/dbCompat').formatBoolean(value);

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const idOf = inserted => inserted[0]?.id ?? inserted[0];

let db, cleanup, tmpDir, ownerId, otherId, superId, customerId, tokens, invoices, contracts;
const auth = who => ({ Authorization: `Bearer ${tokens[who]}` });

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  ({ adminId: ownerId, customerId } = await seedMinimal(db));
  const roleId = idOf(await db('roles').insert({ name: 'crm_jobs_test', display_name: 'CRM jobs test photographer' }).returning('id'));
  const names = ['bills.view', 'bills.manage', 'contracts.view', 'contracts.manage', 'workflows.manage', 'backup.create',
    'backup.view', 'email.send', 'accounting.view'];
  // Held on purpose where the catalog has them (they arrive with migration
  // 259): they widen gallery reach only and must not become CRM-wide reach.
  const galleryWide = ['events.view_all', 'events.manage_all'];
  const permissions = await db('permissions').whereIn('name', [...names, ...galleryWide]);
  expect(permissions.map(p => p.name)).toEqual(expect.arrayContaining(names));
  await db('role_permissions').insert(permissions.map(p => ({ role_id: roleId, permission_id: p.id })));
  await db('admin_users').where('id', ownerId).update({ role_id: roleId, is_active: formatBoolean(true) });
  otherId = idOf(await db('admin_users').insert({ username: 'jobs-other', email: 'jobs-other@example.test', password_hash: 'unused',
    role_id: roleId, is_active: formatBoolean(true), must_change_password: formatBoolean(false) }).returning('id'));
  superId = idOf(await db('admin_users').insert({ username: 'jobs-super', email: 'jobs-super@example.test', password_hash: 'unused',
    is_active: formatBoolean(true), must_change_password: formatBoolean(false) }).returning('id'));
  await assignAdminRole(db, superId);
  require('../../src/middleware/permissions').clearPermissionCache();
  for (const key of ['bills', 'contracts', 'accounting', 'taxReport', 'workflows', 'documents']) {
    if (await db('feature_flags').where({ key }).first()) await db('feature_flags').where({ key }).update({ value: formatBoolean(true) });
    else await db('feature_flags').insert({ key, value: formatBoolean(true) });
  }
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  invoices = {};
  contracts = {};
  for (const [label, creator] of [['own', ownerId], ['foreign', otherId]]) {
    invoices[label] = idOf(await db('invoices').insert({ invoice_number: `JOBS-INV-${label}`, customer_account_id: customerId,
      issue_date: '2026-06-01', due_date: '2026-06-30', status: 'sent', currency: 'CHF', net_amount_minor: 10000,
      vat_amount_minor: 0, total_amount_minor: 10000, created_by_admin_id: creator, deal_uuid: `jobs-inv-${label}` }).returning('id'));
    contracts[label] = idOf(await db('contracts').insert({ contract_number: `JOBS-CON-${label}`, customer_account_id: customerId,
      issue_date: '2026-06-01', created_by_admin_id: creator, deal_uuid: `jobs-con-${label}` }).returning('id'));
  }
  tokens = { owner: mintAdminToken(ownerId), other: mintAdminToken(otherId), super: mintAdminToken(superId) };
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

describe('operator CLIs run without a request context', () => {
  // A real child process in production mode: no jest fixture authority, the
  // same state `docker compose exec backend node scripts/...` runs in.
  function runScript(script, args) {
    return spawnSync(process.execPath, [path.join(BACKEND_ROOT, 'scripts', script), ...args], {
      cwd: BACKEND_ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production', DATABASE_CLIENT: 'sqlite3',
        DATABASE_PATH: db.client.config.connection.filename, PICPEAK_EVIDENCE_KEY: 'a'.repeat(64) },
    });
  }

  test.each(['fingerprint', 'user-data', 'export'])('migrate-sqlite-to-postgres --phase=%s reads the CRM tables', phase => {
    const resultFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-cli-')), 'result');
    try {
      const child = runScript('migrate-sqlite-to-postgres.js', [`--phase=${phase}`, `--result-file=${resultFile}`]);
      expect(`${child.stdout}${child.stderr}`).not.toMatch(/CRM execution context required/);
      expect(child.status).toBe(0);
      const payload = fs.readFileSync(resultFile, 'utf8');
      if (phase === 'export') {
        // The archive holds every row in plaintext; do not leave it in /tmp.
        expect(fs.existsSync(payload)).toBe(true);
        fs.rmSync(path.dirname(payload), { recursive: true, force: true });
      } else {
        const invoiceRows = JSON.parse(payload).invoices; // fingerprint: { count }, user-data: a number
        expect(Number(invoiceRows.count ?? invoiceRows)).toBe(2);
      }
    } finally {
      fs.rmSync(path.dirname(resultFile), { recursive: true, force: true });
    }
  });

  const rotate = path.join(BACKEND_ROOT, 'scripts', 'rotate-evidence-key.js');
  (fs.existsSync(rotate) ? test : test.skip)('rotate-evidence-key --dry-run reads every signer row', () => {
    const child = runScript('rotate-evidence-key.js', ['--dry-run']);
    expect(`${child.stdout}${child.stderr}`).not.toMatch(/CRM execution context required/);
    expect(child.status).toBe(0);
    expect(child.stdout).toMatch(/Dry run:/);
  });
});

describe('backups are not scoped to the admin who started or rescheduled them', () => {
  let scheduled, cronSpy, dumpSpy, databaseBackup, backupService, backupApp, databaseBackupApp;

  beforeAll(async () => {
    const destination = path.join(tmpDir, 'backup-destination');
    fs.mkdirSync(destination, { recursive: true });
    await db('app_settings').insert([
      { setting_key: 'database_backup_destination_path', setting_value: JSON.stringify(path.join(destination, 'database')), setting_type: 'database_backup' },
      { setting_key: 'database_backup_compress', setting_value: 'false', setting_type: 'database_backup' },
      { setting_key: 'database_backup_validate_integrity', setting_value: 'false', setting_type: 'database_backup' },
      { setting_key: 'database_backup_email_on_failure', setting_value: 'false', setting_type: 'database_backup' },
      { setting_key: 'backup_destination_type', setting_value: JSON.stringify('local'), setting_type: 'backup' },
      { setting_key: 'backup_destination_path', setting_value: JSON.stringify(destination), setting_type: 'backup' },
      { setting_key: 'backup_email_on_failure', setting_value: 'false', setting_type: 'backup' },
    ]).onConflict('setting_key').merge();

    // node-cron fires its callback in the async context that created the
    // schedule. Binding here reproduces that without waiting for 3 AM.
    scheduled = [];
    cronSpy = jest.spyOn(require('node-cron'), 'schedule').mockImplementation((expression, callback) => {
      scheduled.push(AsyncResource.bind(callback));
      return { stop() {} };
    });
    databaseBackup = require('../../src/services/databaseBackup');
    backupService = require('../../src/services/backupService');
    // The dump itself shells out to the sqlite3 binary; everything around it
    // (run records, the checksums that read every table) stays real.
    dumpSpy = jest.spyOn(databaseBackup.databaseBackupService, 'createSQLiteBackup')
      .mockImplementation(async outputPath => { fs.writeFileSync(outputPath, 'dump'); return { success: true }; });
    // Stands in for the file walk, and reads the CRM tables the way the dump
    // does: refused unless the run has whole-install access.
    backupService.getFilesToBackup = jest.fn(async () => { await db.raw('select count(*) from invoices'); return []; });
    databaseBackupApp = buildRouteApp('/api/admin/database-backup', require('../../src/routes/adminDatabaseBackup'));
    backupApp = buildRouteApp('/api/admin/backup', require('../../src/routes/adminBackup'));
  });

  afterAll(() => {
    cronSpy.mockRestore();
    dumpSpy.mockRestore();
    databaseBackup.stopScheduledBackups();
    backupService.stopBackupService();
  });

  const lastRun = table => db(table).orderBy('id', 'desc').first();

  test('a database backup schedule restarted by a scoped admin still dumps every table', async () => {
    const saved = await request(databaseBackupApp).put('/api/admin/database-backup/config').set(auth('owner'))
      .send({ database_backup_enabled: true });
    expect(saved.status).toBe(200);
    expect(scheduled).toHaveLength(1);
    await scheduled.pop()();
    const run = await lastRun('database_backup_runs');
    expect({ status: run.status, error: run.error_message }).toEqual({ status: 'completed', error: null });
    expect(JSON.parse(run.table_checksums).invoices.rowCount).toBe(2);
  });

  test('a manual database backup by a scoped admin holding backup.create succeeds', async () => {
    const backup = jest.spyOn(databaseBackup.databaseBackupService, 'backup');
    try {
      const started = await request(databaseBackupApp).post('/api/admin/database-backup/backup').set(auth('owner')).send({});
      expect(started.status).toBe(200);
      await expect(backup.mock.results[0].value).resolves.toMatchObject({ success: true });
    } finally { backup.mockRestore(); }
    const checksums = await request(databaseBackupApp).get('/api/admin/database-backup/checksums').set(auth('owner'));
    expect(checksums.status).toBe(200);
    expect(checksums.body.checksums.invoices.rowCount).toBe(2);
  });

  test('a file backup schedule restarted by a scoped admin, and a manual run, cover the whole install', async () => {
    const saved = await request(backupApp).put('/api/admin/backup/config').set(auth('owner')).send({ backup_enabled: true });
    expect(saved.status).toBe(200);
    expect(scheduled).toHaveLength(1);
    await scheduled.pop()();
    let run = await lastRun('backup_runs');
    expect({ type: run.backup_type, status: run.status, error: run.error_message }).toEqual({ type: 'scheduled', status: 'completed', error: null });

    const manual = jest.spyOn(backupService, 'runBackup');
    try {
      expect((await request(backupApp).post('/api/admin/backup/run').set(auth('owner'))).status).toBe(200);
      await manual.mock.results[0].value;
    } finally { manual.mockRestore(); }
    run = await lastRun('backup_runs');
    expect({ type: run.backup_type, status: run.status, error: run.error_message }).toEqual({ type: 'manual', status: 'completed', error: null });
  });
});

test('flushing the mail queue as a scoped admin sends it as the system job it is', async () => {
  const transport = require('../../src/services/emailWebhookTransport');
  const savedFrom = process.env.EMAIL_FROM;
  process.env.EMAIL_FROM = 'noreply@example.com';
  const enabled = jest.spyOn(transport, 'isEnabled').mockReturnValue(true);
  // The transport stub reads a CRM table the way a send that attaches or
  // re-checks a document does: refused under one admin's document scope.
  const send = jest.spyOn(transport, 'send').mockImplementation(async () => {
    await db.raw('select count(*) from invoices');
    return { messageId: 'm-1' };
  });
  try {
    await require('../../src/services/crmEmailTemplates').ensureCrmEmailTemplatesSeeded(db, require('../../src/utils/logger'));
    const { queueEmail } = require('../../src/services/emailProcessor');
    if (await db.schema.hasTable('customer_documents')) {
      // The real case: the pre-send check could not see another owner's
      // document and cancelled the mail as "document was deleted".
      const now = new Date().toISOString();
      const documentId = idOf(await db('customer_documents').insert({ customer_account_id: customerId, uploader_type: 'admin',
        uploader_id: otherId, original_name: 'signed.pdf', storage_key: `business-docs/customer-documents/${customerId}/jobs.pdf`,
        mime_type: 'application/pdf', size_bytes: 10, sha256: 'a'.repeat(64), status: 'clean', contract_id: contracts.foreign,
        shared_at: now, created_at: now, updated_at: now }).returning('id'));
      await queueEmail(null, 'jobs-customer@example.test', 'customer_document_shared',
        { __documentId: documentId, customer_name: 'Jobs Customer', document_name: 'signed.pdf', portal_url: 'https://example.test/portal' });
    } else {
      await queueEmail(null, 'jobs-customer@example.test', 'invoice_sent', { customer_name: 'Jobs Customer', invoice_number: 'JOBS-INV-foreign' });
    }
    const queued = await db('email_queue').where({ recipient_email: 'jobs-customer@example.test' }).first();

    const app = buildRouteApp('/api/admin/email', require('../../src/routes/adminEmail'));
    const flushed = await request(app).post('/api/admin/email/flush-queue').set(auth('owner'));
    expect(flushed.status).toBe(200);
    const after = await db('email_queue').where({ id: queued.id }).first();
    expect({ status: after.status, error: after.error_message }).toEqual({ status: 'sent', error: null });
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    enabled.mockRestore(); send.mockRestore();
    if (savedFrom === undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = savedFrom;
  }
});

describe('workflow authority', () => {
  let engine, registry, workflowApp, shipped, def;
  let serial = 0;

  beforeAll(async () => {
    engine = require('../../src/services/workflows/engine');
    registry = require('../../src/services/workflows/registry');
    registry.registerAction('jobs_fixture_noop', async () => ({ ran: true }));
    workflowApp = buildRouteApp('/api/admin/workflows', require('../../src/routes/adminWorkflows'));
    def = require('../../src/services/_workflowSeedBoot').BUILTINS.find(entry => entry.key === 'invoice_dunning');
    shipped = await def.build();
  });

  async function insertWorkflow({ creator, builtin, nodes, edges }) {
    const workflowId = idOf(await db('workflows').insert({ name: `Jobs fixture ${++serial}`, version: 1,
      trigger_type: builtin ? def.trigger_type : 'jobs.fixture', enabled: formatBoolean(true), created_by: creator,
      is_builtin: formatBoolean(builtin), builtin_key: builtin ? 'invoice_dunning' : null }).returning('id'));
    await db('workflow_nodes').insert(nodes.map(n => ({ workflow_id: workflowId, version: 1, node_key: n.node_key, type: n.type,
      config: JSON.stringify(n.config || {}) })));
    await db('workflow_edges').insert(edges.map(e => ({ workflow_id: workflowId, version: 1, from_node: e.from_node,
      to_node: e.to_node, from_handle: e.from_handle || null, loop_back: formatBoolean(!!e.loop_back) })));
    return workflowId;
  }

  test('a run whose authority cannot be established says why, in the log and on the failed run', async () => {
    const { withTrustedCrmAccess } = require('../../src/database/crmAccess');
    const logger = require('../../src/utils/logger');
    const warn = jest.spyOn(logger, 'warn');
    registry.registerAction('jobs_fixture_crm', async ctx => ({ rows: (await ctx.db('invoices').select('id')).length }));
    const workflowId = await insertWorkflow({ creator: null, builtin: false,
      nodes: [{ node_key: 'start', type: 'trigger' }, { node_key: 'plain', type: 'action', config: { action: 'jobs_fixture_noop' } },
        { node_key: 'crm', type: 'action', config: { action: 'jobs_fixture_crm' } }],
      edges: [{ from_node: 'start', to_node: 'plain' }, { from_node: 'plain', to_node: 'crm' }] });
    try {
      const [runId] = await withTrustedCrmAccess('isolated scheduler fixture', () => engine.emitWorkflowEvent('jobs.fixture', {
        entityType: 'invoice', entityId: invoices.own, targetWorkflowId: workflowId,
      }));
      // Steps that need no CRM data still run on an ownerless definition.
      expect((await db('workflow_run_steps').where({ run_id: runId, node_key: 'plain' }).first()).status).toBe('done');
      const run = await db('workflow_runs').where('id', runId).first();
      expect(run.status).toBe('failed');
      expect(run.error).toBe('node crm failed: CRM execution context required (workflow authority unavailable: Workflow has no live CRM actor)');
      expect(warn).toHaveBeenCalledWith('[workflow] run has no CRM authority, its CRM steps will fail',
        expect.objectContaining({ runId, workflowId, error: 'Workflow has no live CRM actor' }));
    } finally { warn.mockRestore(); }
  });

  test('saving a workflow claims its authority only when the graph it executes changes', async () => {
    const workflowId = await insertWorkflow({ creator: null, builtin: true, nodes: shipped.nodes, edges: shipped.edges });
    const put = (who, body) => request(workflowApp).put(`/api/admin/workflows/${workflowId}`).set(auth(who)).send(body);
    const creator = async () => (await db('workflows').where('id', workflowId).first()).created_by;
    // What the editor sends back after a rename or a drag: the same graph.
    const moved = shipped.nodes.map((n, i) => ({ ...n, pos_x: 40 * i, pos_y: 12 }));

    expect((await put('owner', { name: 'Renamed dunning', nodes: moved, edges: shipped.edges })).status).toBe(200);
    expect(await creator()).toBeNull();
    // Still the shipped system graph, so scheduler runs keep their reach.
    const { withTrustedCrmAccess } = require('../../src/database/crmAccess');
    const [systemRun] = await withTrustedCrmAccess('isolated scheduler fixture', () => engine.emitWorkflowEvent(def.trigger_type, {
      entityType: 'invoice', entityId: invoices.foreign, targetWorkflowId: workflowId, payload: { dueDate: '2099-01-01' },
    }));
    expect((await db('workflow_runs').where('id', systemRun).first()).status).not.toBe('failed');

    const edited = shipped.nodes.map(n => (n.type === 'wait' ? { ...n, config: { ...n.config, delayDays: 99 } } : n));
    expect((await put('owner', { nodes: edited, edges: shipped.edges })).status).toBe(200);
    expect(await creator()).toBe(ownerId);
    // Another admin renaming it does not take it over...
    expect((await put('other', { name: 'Renamed again', nodes: edited, edges: shipped.edges })).status).toBe(200);
    expect(await creator()).toBe(ownerId);
    // ...but their changed graph must not run under the previous owner.
    expect((await put('other', { nodes: shipped.nodes, edges: shipped.edges })).status).toBe(200);
    expect(await creator()).toBe(otherId);
  });
});

describe('aggregate financial reports are complete or refused', () => {
  let taxApp, ledgerApp;
  const period = 'from=2026-01-01&to=2026-12-31&currency=CHF';

  beforeAll(() => {
    taxApp = buildRouteApp('/api/admin/tax-report', require('../../src/routes/adminTaxReport'));
    ledgerApp = buildRouteApp('/api/admin/ledger', require('../../src/routes/adminLedger'));
  });

  test.each(['', '/pdf', '/csv'])('tax report%s: 403 for an admin who sees only their own invoices, whatever their gallery reach', async suffix => {
    const result = await request(taxApp).get(`/api/admin/tax-report${suffix}?${period}`).set(auth('owner'));
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('CRM_COMPLETE_VIEW_REQUIRED');
  });

  test('tax report: a super admin gets every invoice', async () => {
    const result = await request(taxApp).get(`/api/admin/tax-report?${period}`).set(auth('super'));
    expect(result.status).toBe(200);
    expect(result.body.report.rows.map(r => r.invoiceNumber).sort()).toEqual(['JOBS-INV-foreign', 'JOBS-INV-own']);
  });

  test('ledger export: refused for a scoped admin, complete for a super admin', async () => {
    const scoped = await request(ledgerApp).get(`/api/admin/ledger/export?${period}`).set(auth('owner'));
    expect(scoped.status).toBe(403);
    expect(scoped.body.code).toBe('CRM_COMPLETE_VIEW_REQUIRED');
    const full = await request(ledgerApp).get(`/api/admin/ledger/export?${period}`).set(auth('super'));
    expect(full.status).toBe(200);
    expect(full.text).toContain('JOBS-INV-own');
    expect(full.text).toContain('JOBS-INV-foreign');
  });
});

describe('invoice document gate', () => {
  let invoicesApp;
  beforeAll(() => { invoicesApp = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices')); });

  test('an id no key can hold is a missing document, before any query', async () => {
    const first = jest.spyOn(require('knex/lib/query/querybuilder').prototype, 'first');
    try {
      for (const id of ['99999999999999999999', '2147483648', '0']) {
        const result = await request(invoicesApp).get(`/api/admin/invoices/${id}`).set(auth('owner'));
        expect({ id, status: result.status, code: result.body.code }).toEqual({ id, status: 404, code: 'NOT_FOUND' });
      }
      expect(first.mock.contexts.filter(builder => builder._single?.table === 'invoices')).toHaveLength(0);
    } finally { first.mockRestore(); }
  });

  test('the feature flag answers before the ownership probe', async () => {
    await db('feature_flags').where({ key: 'bills' }).update({ value: formatBoolean(false) });
    try {
      const result = await request(invoicesApp).get(`/api/admin/invoices/${invoices.foreign}`).set(auth('owner'));
      expect({ status: result.status, code: result.body.code }).toEqual({ status: 403, code: 'BILLS_DISABLED' });
    } finally {
      await db('feature_flags').where({ key: 'bills' }).update({ value: formatBoolean(true) });
    }
  });
});
