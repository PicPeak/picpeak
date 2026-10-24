/**
 * Project-first flow ("Neue Anfrage", migration 315).
 *
 * A project is created as an inquiry with the data it started from, edited in
 * place, moves to `active` once something is attached, derives its stage from
 * what it holds, and rolls up invoices through its own project_id or its deal
 * as well as through its galleries. Deleting it keeps every document and only
 * clears the link.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-projflow-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'projflow-test-secret';

const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('project inquiry flow', () => {
  let db; let cleanup; let app;
  let superToken; let superId; let editorToken; let editorId; let customerId; let otherCustomerId;
  let seq = 0;

  const idOf = (r) => r[0]?.id ?? r[0];

  const mkAdmin = async (username, roleName) => {
    const role = await db('roles').where({ name: roleName }).first();
    const id = idOf(await db('admin_users').insert({
      username,
      email: `${username}@example.com`,
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id,
      is_active: 1,
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id'));
    return {
      id,
      token: jwt.sign(
        { id, username, type: 'admin', role: roleName, loginTime: Date.now() },
        process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' },
      ),
    };
  };

  const mkEvent = async ({ projectId = null, published = true } = {}) => {
    seq += 1;
    return idOf(await db('events').insert({
      slug: `flow-ev-${seq}`, event_type: 'wedding', event_name: `Flow ${seq}`, event_date: '2027-06-12',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_token: `flow-tok-${seq}`, share_link: `/gallery/flow-ev-${seq}/flow-tok-${seq}`,
      created_by: superId, project_id: projectId,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: published ? 0 : 1,
      created_at: new Date().toISOString(),
    }).returning('id'));
  };

  const mkQuote = async ({ projectId = null, status = 'accepted', dealUuid }) => {
    seq += 1;
    return idOf(await db('quotes').insert({
      quote_number: `Q-FLOW-${seq}`, customer_account_id: customerId, deal_uuid: dealUuid,
      project_id: projectId, status, currency: 'CHF', issue_date: '2027-02-09',
      total_amount_minor: 450000,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id'));
  };

  const mkInvoice = async ({ projectId = null, dealUuid = null, status = 'sent', eventId = null, total = 135000 }) => {
    seq += 1;
    return idOf(await db('invoices').insert({
      invoice_number: `R-FLOW-${seq}`, customer_account_id: customerId, deal_uuid: dealUuid,
      project_id: projectId, event_id: eventId, status, currency: 'CHF',
      issue_date: '2027-02-20', due_date: '2027-03-20',
      total_amount_minor: total,
      paid_amount_minor: status === 'paid' ? total : 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id'));
  };

  const post = (url, body, token = superToken) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body);
  const put = (url, body, token = superToken) => request(app).put(url).set('Authorization', `Bearer ${token}`).send(body);
  const get = (url, token = superToken) => request(app).get(url).set('Authorization', `Bearer ${token}`);

  const createInquiry = async (extra = {}) => {
    const res = await post('/api/admin/projects', {
      name: 'Hochzeit Keller & Brunner',
      customerAccountId: customerId,
      status: 'inquiry',
      eventType: 'wedding',
      eventDate: '2027-06-12',
      location: 'Schloss Vaduz',
      guestCount: 120,
      budgetMinor: 450000,
      currency: 'chf',
      source: 'referral',
      notes: 'Trauung 14 Uhr',
      ...extra,
    });
    expect(res.status).toBe(201);
    return res.body.data?.project || res.body.project;
  };

  const overview = async (id) => {
    const res = await get(`/api/admin/projects/${id}/overview`);
    expect(res.status).toBe(200);
    return res.body.data || res.body;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ customerId } = await seedMinimal(db));
    otherCustomerId = idOf(await db('customer_accounts').insert({
      email: 'other@example.com', display_name: 'Other', is_active: 1, created_at: new Date(),
    }).returning('id'));
    for (const key of ['projects', 'bills', 'quotes', 'contracts']) {
      await db('feature_flags').insert({ key, value: 1 }).onConflict('key').merge({ value: 1 });
    }

    const sup = await mkAdmin('flow-super', 'super_admin');
    superToken = sup.token; superId = sup.id;
    const editor = await mkAdmin('flow-editor', 'editor');
    editorToken = editor.token; editorId = editor.id;

    app = express();
    app.use(express.json());
    app.use('/api/admin/projects', require('../../src/routes/adminProjects'));
    app.use('/api/admin/invoices', require('../../src/routes/adminInvoices'));
    app.use('/api/admin/quotes', require('../../src/routes/adminQuotes'));
    app.use('/api/admin/contracts', require('../../src/routes/adminContracts'));
    // As in the app, so a refusal carries its code.
    app.use(require('../../src/middleware/errorHandler').errorHandler);
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('creates an inquiry with its data, dates as YYYY-MM-DD and the currency upper-cased', async () => {
    const project = await createInquiry();
    expect(project).toMatchObject({
      status: 'inquiry', eventType: 'wedding', eventDate: '2027-06-12', eventEndDate: null,
      location: 'Schloss Vaduz', guestCount: 120, budgetMinor: 450000, currency: 'CHF',
      source: 'referral', notes: 'Trauung 14 Uhr',
    });
  });

  it.each([
    ['an end date before the start date', { eventDate: '2027-06-12', eventEndDate: '2027-06-11' }],
    ['an unknown source', { source: 'billboard' }],
    ['an unknown status', { status: 'lost' }],
    ['a negative guest count', { guestCount: -1 }],
    ['a date that is not a date', { eventDate: '12.06.2027' }],
  ])('refuses %s', async (_label, extra) => {
    const res = await post('/api/admin/projects', { name: 'Bad', ...extra });
    expect(res.status).toBe(400);
  });

  it('refuses an end date before the stored start date when only the end date changes', async () => {
    const project = await createInquiry();
    const res = await put(`/api/admin/projects/${project.id}`, { eventEndDate: '2027-06-01' });
    expect(res.status).toBe(400);
  });

  it('edits fields in place and clears them with null, leaving the rest alone', async () => {
    const project = await createInquiry();
    const res = await put(`/api/admin/projects/${project.id}`, { guestCount: 140, location: null });
    expect(res.status).toBe(200);
    const updated = res.body.data?.project || res.body.project;
    expect(updated).toMatchObject({ guestCount: 140, location: null, eventDate: '2027-06-12', notes: 'Trauung 14 Uhr' });
  });

  it('becomes active once a gallery is attached', async () => {
    const project = await createInquiry();
    const eventId = await mkEvent();
    const res = await post(`/api/admin/projects/${project.id}/events`, { eventId });
    expect(res.status).toBe(200);
    const row = await db('projects').where({ id: project.id }).first('status');
    expect(row.status).toBe('active');
  });

  it('leaves a cancelled project cancelled when something is attached', async () => {
    const project = await createInquiry({ status: 'cancelled' });
    const eventId = await mkEvent();
    await post(`/api/admin/projects/${project.id}/events`, { eventId });
    const row = await db('projects').where({ id: project.id }).first('status');
    expect(row.status).toBe('cancelled');
  });

  it('starts at the quote stage', async () => {
    const project = await createInquiry();
    const { stage } = await overview(project.id);
    expect(stage.current).toBe('quote');
    expect(stage.stages.map((s) => s.state)).toEqual(['done', 'current', 'todo', 'todo', 'todo', 'todo']);
  });

  it('derives stages from documents and marks the ones jumped over as skipped', async () => {
    const project = await createInquiry();
    await mkQuote({ projectId: project.id, dealUuid: crypto.randomUUID() });
    await mkEvent({ projectId: project.id });
    const { stage } = await overview(project.id);
    // Quote accepted, no contract, gallery published, no invoice yet.
    expect(stage.stages.map((s) => [s.key, s.state])).toEqual([
      ['inquiry', 'done'], ['quote', 'done'], ['contract', 'skipped'],
      ['gallery', 'done'], ['invoice', 'current'], ['done', 'todo'],
    ]);
  });

  it('marks where a cancelled project stopped, with nothing current', async () => {
    const project = await createInquiry({ status: 'cancelled' });
    await mkQuote({ projectId: project.id, dealUuid: crypto.randomUUID() });
    const { stage } = await overview(project.id);
    expect(stage.current).toBeNull();
    // Inquiry and quote done; it stopped at the contract; the rest never came.
    expect(stage.stages.map((s) => s.state)).toEqual(['done', 'done', 'cancelled', 'todo', 'todo', 'todo']);
  });

  it('rolls up invoices by their own project_id and by the deal of a linked quote', async () => {
    const project = await createInquiry();
    const deal = crypto.randomUUID();
    await mkQuote({ projectId: project.id, dealUuid: deal });
    const own = await mkInvoice({ projectId: project.id, status: 'paid' });
    const viaDeal = await mkInvoice({ dealUuid: deal });
    const unrelated = await mkInvoice({ dealUuid: crypto.randomUUID() });

    const { invoices, valuation } = await overview(project.id);
    const ids = invoices.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([own, viaDeal]));
    expect(ids).not.toContain(unrelated);
    // Newest stage wins per deal: the deal's invoice replaces its quote.
    expect(valuation.byCurrency).toEqual([{ currency: 'CHF', totalMinor: 270000, paidMinor: 135000 }]);
  });

  it('lists projects by several statuses with their stage for the dashboard', async () => {
    const res = await get('/api/admin/projects?status=inquiry,cancelled&withStages=1');
    expect(res.status).toBe(200);
    const projects = res.body.data?.projects || res.body.projects;
    expect(projects.length).toBeGreaterThan(0);
    expect(new Set(projects.map((p) => p.status))).toEqual(new Set(['inquiry', 'cancelled']));
    for (const p of projects) expect(p.stage.stages).toHaveLength(6);
  });

  it('creates an invoice in the project and refuses one for another customer or a foreign project', async () => {
    const project = await createInquiry();
    const body = {
      customerAccountId: customerId,
      projectId: project.id,
      currency: 'CHF',
      lineItems: [{ description: 'Anzahlung', quantity: 1, unitPriceMinor: 135000 }],
    };
    const ok = await post('/api/admin/invoices', body);
    expect(ok.status).toBe(201);
    const invoiceId = (ok.body.data || ok.body).invoiceIds[0];
    expect((await db('invoices').where({ id: invoiceId }).first('project_id')).project_id).toBe(project.id);
    expect((await db('projects').where({ id: project.id }).first('status')).status).toBe('active');

    const mismatch = await post('/api/admin/invoices', { ...body, customerAccountId: otherCustomerId });
    expect(mismatch.status).toBe(422);

    // An editor does not own the super admin's project: 404, not 403.
    const foreign = await post('/api/admin/invoices', body, editorToken);
    expect([403, 404]).toContain(foreign.status);
    if (foreign.status === 404) expect(foreign.body.error).toMatch(/^Project not found/);
  });

  it('deletes a project and keeps its gallery, quote and invoice, only unlinked', async () => {
    const project = await createInquiry();
    const deal = crypto.randomUUID();
    const quoteId = await mkQuote({ projectId: project.id, dealUuid: deal });
    const eventId = await mkEvent({ projectId: project.id });
    const invoiceId = await mkInvoice({ projectId: project.id });

    const res = await request(app).delete(`/api/admin/projects/${project.id}`).set('Authorization', `Bearer ${superToken}`);
    expect(res.status).toBe(200);
    expect(await db('projects').where({ id: project.id }).first()).toBeUndefined();
    expect((await db('quotes').where({ id: quoteId }).first('project_id')).project_id).toBeNull();
    expect((await db('events').where({ id: eventId }).first('project_id')).project_id).toBeNull();
    expect((await db('invoices').where({ id: invoiceId }).first('project_id')).project_id).toBeNull();
  });

  it('keeps a gallery done once published, even after it expired', async () => {
    const project = await createInquiry();
    const eventId = await mkEvent({ projectId: project.id });
    await db('events').where({ id: eventId }).update({ is_active: 0 });
    const { stage } = await overview(project.id);
    expect(stage.stages.find((x) => x.key === 'gallery').state).toBe('done');
  });

  it('rolls up the Storno and the reissue of a project invoice', async () => {
    const project = await createInquiry();
    const original = await mkInvoice({ projectId: project.id, status: 'cancelled' });
    const storno = await mkInvoice({ status: 'sent', total: -135000 });
    await db('invoices').where({ id: storno }).update({ kind: 'storno', cancels_invoice_id: original });
    const reissue = await mkInvoice({ status: 'sent' });
    await db('invoices').where({ id: reissue }).update({ replaces_invoice_id: original });
    const { invoices } = await overview(project.id);
    expect(invoices.map((i) => i.id)).toEqual(expect.arrayContaining([original, storno, reissue]));
  });

  it('refuses an invoice in the project for a customer billed monthly, rather than dropping the link', async () => {
    const monthly = idOf(await db('customer_accounts').insert({
      email: 'monthly@example.com', display_name: 'Monthly', is_active: 1, billing_cadence: 'monthly', created_at: new Date(),
    }).returning('id'));
    const project = await createInquiry({ customerAccountId: monthly });
    const res = await post('/api/admin/invoices', {
      customerAccountId: monthly, projectId: project.id, currency: 'CHF',
      lineItems: [{ description: 'Anzahlung', quantity: 1, unitPriceMinor: 1000 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PROJECT_INVOICE_COLLECTED_BILLING');
    expect((await db('projects').where({ id: project.id }).first('status')).status).toBe('inquiry');
  });

  it('lets a project without a customer adopt the customer of its first invoice', async () => {
    const project = await createInquiry({ customerAccountId: null });
    const res = await post('/api/admin/invoices', {
      customerAccountId: customerId, projectId: project.id, currency: 'CHF',
      lineItems: [{ description: 'Anzahlung', quantity: 1, unitPriceMinor: 1000 }],
    });
    expect(res.status).toBe(201);
    expect((await db('projects').where({ id: project.id }).first('customer_account_id')).customer_account_id).toBe(customerId);
  });

  it('refuses to delete a project that holds another admin\'s gallery', async () => {
    const own = idOf(await db('projects').insert({
      name: 'Editor project', status: 'active', created_by: editorId, created_at: new Date(), updated_at: new Date(),
    }).returning('id'));
    const foreignEvent = await mkEvent({ projectId: own });
    const res = await request(app).delete(`/api/admin/projects/${own}`).set('Authorization', `Bearer ${editorToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PROJECT_DELETE_FOREIGN_GALLERIES');
    expect((await db('events').where({ id: foreignEvent }).first('project_id')).project_id).toBe(own);
  });

  it('refuses to delete a project that holds a document the caller cannot see, and keeps the link', async () => {
    const own = idOf(await db('projects').insert({
      name: 'Editor project with a foreign quote', status: 'active', created_by: editorId,
      created_at: new Date(), updated_at: new Date(),
    }).returning('id'));
    const quoteId = await mkQuote({ projectId: own, dealUuid: crypto.randomUUID() });
    await db('quotes').where({ id: quoteId }).update({ created_by_admin_id: superId });
    const res = await request(app).delete(`/api/admin/projects/${own}`).set('Authorization', `Bearer ${editorToken}`);
    expect(res.status).toBe(403);
    // The route's own answer, not a refusal further down: it saw the quote.
    expect(['PROJECT_DELETE_NEEDS_PERMISSION', 'PROJECT_DELETE_FOREIGN_DOCUMENTS']).toContain(res.body.code);
    expect((await db('quotes').where({ id: quoteId }).first('project_id')).project_id).toBe(own);
  });

  it('refuses a value that is not null where a field expects one (false is not a date)', async () => {
    const res = await post('/api/admin/projects', { name: 'Bad date', eventDate: false });
    expect(res.status).toBe(400);
  });

  it('refuses an invoice for one customer in a project that holds another customer\'s quote', async () => {
    const project = await createInquiry({ customerAccountId: null });
    const quoteId = await mkQuote({ projectId: project.id, dealUuid: crypto.randomUUID() });
    await db('quotes').where({ id: quoteId }).update({ customer_account_id: otherCustomerId });
    const res = await post('/api/admin/invoices', {
      customerAccountId: customerId, projectId: project.id, currency: 'CHF',
      lineItems: [{ description: 'Anzahlung', quantity: 1, unitPriceMinor: 1000 }],
    });
    expect(res.status).toBe(422);
    expect((await db('projects').where({ id: project.id }).first('customer_account_id')).customer_account_id).toBeNull();
  });

  it('does not move a project to another customer while it holds the first one\'s invoice', async () => {
    const project = await createInquiry();
    await mkInvoice({ projectId: project.id });
    const res = await put(`/api/admin/projects/${project.id}`, { customerAccountId: otherCustomerId });
    expect(res.status).toBe(422);
  });

  it('carries no project on a conversion while the feature is off', async () => {
    const projectService = require('../../src/services/projectService');
    const project = await createInquiry();
    expect(await projectService.carriedProjectId(project.id, superId, { target: 'events' })).toBe(project.id);
    await db('feature_flags').where({ key: 'projects' }).update({ value: 0 });
    require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
    try {
      expect(await projectService.carriedProjectId(project.id, superId, { target: 'events' })).toBeNull();
    } finally {
      await db('feature_flags').where({ key: 'projects' }).update({ value: 1 });
      require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
    }
  });

  it('keeps a hidden stage hidden where a cancelled job stopped, and puts no cross on a later stage', async () => {
    const { deriveStages } = require('../../src/services/projectService');
    const { stages } = deriveStages({ status: 'cancelled' }, { quotes: false });
    expect(stages.map((s) => s.state)).toEqual(['done', 'hidden', 'todo', 'todo', 'todo', 'todo']);
  });

  it('answers an unknown status filter with no projects, not all of them', async () => {
    const res = await get('/api/admin/projects?status=nonsense');
    expect(res.status).toBe(200);
    expect((res.body.data || res.body).projects).toEqual([]);
  });

  it('refuses an invoice for a gallery that belongs to another project', async () => {
    const project = await createInquiry();
    const other = await createInquiry();
    const eventId = await mkEvent({ projectId: other.id });
    const res = await post('/api/admin/invoices', {
      customerAccountId: customerId, projectId: project.id, eventId, currency: 'CHF',
      lineItems: [{ description: 'Anzahlung', quantity: 1, unitPriceMinor: 1000 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PROJECT_EVENT_MISMATCH');
  });

  it('gives back the customer an empty project adopted when the invoice is then refused', async () => {
    const inactive = idOf(await db('customer_accounts').insert({
      email: 'inactive@example.com', display_name: 'Inactive', is_active: 0, created_at: new Date(),
    }).returning('id'));
    const project = await createInquiry({ customerAccountId: null });
    const res = await post('/api/admin/invoices', {
      customerAccountId: inactive, projectId: project.id, currency: 'CHF',
      lineItems: [{ description: 'Anzahlung', quantity: 1, unitPriceMinor: 1000 }],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await db('projects').where({ id: project.id }).first('customer_account_id')).customer_account_id).toBeNull();
  });

  it('keeps an inquiry an inquiry when attaching a document is refused late (deal lineage)', async () => {
    const projectService = require('../../src/services/projectService');
    // The editor's own empty inquiry; the quote's deal produced another admin's
    // gallery, so linkDealToProject refuses after vetting the destination.
    const project = idOf(await db('projects').insert({
      name: 'Editor inquiry', status: 'inquiry', created_by: editorId, created_at: new Date(), updated_at: new Date(),
    }).returning('id'));
    const foreignEvent = await mkEvent();
    const quoteId = await mkQuote({ projectId: null, dealUuid: crypto.randomUUID() });
    await db('quotes').where({ id: quoteId }).update({ converted_event_id: foreignEvent });
    await expect(projectService.assignQuote(project, quoteId, { id: editorId, roleName: 'editor' }))
      .rejects.toMatchObject({ code: 'DEAL_EVENT_FORBIDDEN' });
    expect((await db('projects').where({ id: project }).first('status')).status).toBe('inquiry');
  });

  it('does not set a project that holds a gallery back to an inquiry', async () => {
    const project = await createInquiry();
    await mkEvent({ projectId: project.id });
    await db('projects').where({ id: project.id }).update({ status: 'active' });
    const res = await put(`/api/admin/projects/${project.id}`, { status: 'inquiry' });
    expect(res.status).toBe(422);
  });

  it('leaves the contract out of a no-contract project and offers the gallery after the quote', async () => {
    const project = await createInquiry({ flow: 'no_contract' });
    expect(project.flow).toBe('no_contract');
    await mkQuote({ projectId: project.id, dealUuid: crypto.randomUUID() });
    const { stage } = await overview(project.id);
    expect(stage.stages.map((s) => [s.key, s.state])).toEqual([
      ['inquiry', 'done'], ['quote', 'done'], ['contract', 'skipped'],
      ['gallery', 'current'], ['invoice', 'todo'], ['done', 'todo'],
    ]);
  });

  it('starts a no-quote project at the gallery', async () => {
    const project = await createInquiry({ flow: 'no_quote' });
    const { stage } = await overview(project.id);
    expect(stage.current).toBe('gallery');
    expect(stage.stages.filter((s) => s.state === 'skipped').map((s) => s.key)).toEqual(['quote', 'contract']);
  });

  it('skips one stage by hand and takes it back', async () => {
    const project = await createInquiry();
    let res = await put(`/api/admin/projects/${project.id}`, { skippedStages: ['quote'] });
    expect(res.status).toBe(200);
    expect((res.body.data || res.body).project.skippedStages).toEqual(['quote']);
    expect((await overview(project.id)).stage.current).toBe('contract');
    res = await put(`/api/admin/projects/${project.id}`, { skippedStages: [] });
    expect((res.body.data || res.body).project.skippedStages).toEqual([]);
    expect((await overview(project.id)).stage.current).toBe('quote');
  });

  it('keeps a stage done that was skipped but happened anyway', async () => {
    const project = await createInquiry({ flow: 'no_contract' });
    await mkQuote({ projectId: project.id, dealUuid: crypto.randomUUID() });
    await db('contracts').insert({
      contract_number: `C-SKIP-${project.id}`, customer_account_id: customerId, status: 'fully_signed',
      issue_date: '2027-02-01', project_id: project.id, created_at: new Date().toISOString(),
    });
    const { stage } = await overview(project.id);
    expect(stage.stages.find((s) => s.key === 'contract').state).toBe('done');
  });

  it('clears the skipped stages with null as with an empty list', async () => {
    const project = await createInquiry({ skippedStages: ['quote'] });
    const res = await put(`/api/admin/projects/${project.id}`, { skippedStages: null });
    expect(res.status).toBe(200);
    expect((res.body.data || res.body).project.skippedStages).toEqual([]);
  });

  it('reopens to an inquiry or to active by what the project holds, decided on the server', async () => {
    const empty = await createInquiry();
    await put(`/api/admin/projects/${empty.id}`, { status: 'cancelled' });
    let res = await put(`/api/admin/projects/${empty.id}`, { status: 'reopen' });
    expect(res.status).toBe(200);
    expect((res.body.data || res.body).project.status).toBe('inquiry');

    // A quote of another admin's, which the caller's overview may not list.
    const holding = await createInquiry();
    const quoteId = await mkQuote({ projectId: holding.id, dealUuid: crypto.randomUUID() });
    await db('quotes').where({ id: quoteId }).update({ created_by_admin_id: editorId });
    await db('projects').where({ id: holding.id }).update({ status: 'cancelled' });
    res = await put(`/api/admin/projects/${holding.id}`, { status: 'reopen' });
    expect(res.status).toBe(200);
    expect((res.body.data || res.body).project.status).toBe('active');

    // Only an update reopens; a new project needs a real status.
    expect((await post('/api/admin/projects', { name: 'Reopen on create', status: 'reopen' })).status).toBe(400);
  });

  it('shows an invoice in the project of its gallery only, even when its own project_id points elsewhere', async () => {
    const a = await createInquiry();
    const b = await createInquiry();
    const eventInB = await mkEvent({ projectId: b.id });
    const invoiceId = await mkInvoice({ projectId: a.id, eventId: eventInB });
    expect((await overview(a.id)).invoices.map((i) => i.id)).not.toContain(invoiceId);
    expect((await overview(b.id)).invoices.map((i) => i.id)).toContain(invoiceId);
  });

  it('tells the cockpit whether new documents may join the project', async () => {
    const ownerless = idOf(await db('projects').insert({
      name: 'Legacy ownerless', status: 'active', created_by: null, created_at: new Date(), updated_at: new Date(),
    }).returning('id'));
    const ev = await mkEvent({ projectId: ownerless });
    await db('events').where({ id: ev }).update({ created_by: editorId });
    const asEditor = await get(`/api/admin/projects/${ownerless}/overview`, editorToken);
    expect(asEditor.status).toBe(200);
    expect((asEditor.body.data || asEditor.body).project.documentsLinkable).toBe(false);
    expect((await overview(ownerless)).project.documentsLinkable).toBe(true);

    const own = idOf(await db('projects').insert({
      name: 'Editor own', status: 'active', created_by: editorId, created_at: new Date(), updated_at: new Date(),
    }).returning('id'));
    const ownRes = await get(`/api/admin/projects/${own}/overview`, editorToken);
    expect((ownRes.body.data || ownRes.body).project.documentsLinkable).toBe(true);
  });

  it('attaches an existing invoice and brings its deal and unassigned gallery along', async () => {
    const project = idOf(await db('projects').insert({
      name: 'Finished job', status: 'inquiry', created_by: superId, created_at: new Date(), updated_at: new Date(),
    }).returning('id'));
    const dealUuid = crypto.randomUUID();
    const quoteId = await mkQuote({ dealUuid });
    const ev = await mkEvent();
    const invoiceId = await mkInvoice({ dealUuid, eventId: ev, status: 'paid' });
    const res = await post(`/api/admin/projects/${project}/invoices`, { invoiceId });
    expect(res.status).toBe(200);
    expect((await db('invoices').where({ id: invoiceId }).first('project_id')).project_id).toBe(project);
    expect((await db('quotes').where({ id: quoteId }).first('project_id')).project_id).toBe(project);
    expect((await db('events').where({ id: ev }).first('project_id')).project_id).toBe(project);
    const row = await db('projects').where({ id: project }).first('status', 'customer_account_id');
    expect(row.status).toBe('active');
    expect(Number(row.customer_account_id)).toBe(Number(customerId));
    expect((await overview(project)).invoices.map((i) => i.id)).toContain(invoiceId);
  });

  it('refuses an existing invoice whose gallery is in another project, and keeps the customer free', async () => {
    const other = await createInquiry();
    const ev = await mkEvent({ projectId: other.id });
    const invoiceId = await mkInvoice({ eventId: ev });
    const project = idOf(await db('projects').insert({
      name: 'Empty', status: 'inquiry', created_by: superId, created_at: new Date(), updated_at: new Date(),
    }).returning('id'));
    const res = await post(`/api/admin/projects/${project}/invoices`, { invoiceId });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PROJECT_EVENT_MISMATCH');
    expect((await db('invoices').where({ id: invoiceId }).first('project_id')).project_id).toBeNull();
    expect((await db('projects').where({ id: project }).first('customer_account_id')).customer_account_id).toBeNull();
  });

  it('refuses an existing invoice of another customer', async () => {
    const project = await createInquiry();
    const invoiceId = await mkInvoice({});
    await db('invoices').where({ id: invoiceId }).update({ customer_account_id: otherCustomerId });
    const res = await post(`/api/admin/projects/${project.id}/invoices`, { invoiceId });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PROJECT_CUSTOMER_MISMATCH');
    expect((await db('invoices').where({ id: invoiceId }).first('project_id')).project_id).toBeNull();
  });

  it('gives back the customer when a late check refuses the invoice (deal holds another admin\'s gallery)', async () => {
    const project = idOf(await db('projects').insert({
      name: 'Editor empty', status: 'inquiry', created_by: editorId, created_at: new Date(), updated_at: new Date(),
    }).returning('id'));
    const dealUuid = crypto.randomUUID();
    const foreignEvent = await mkEvent();
    await db('quotes').where({ id: await mkQuote({ dealUuid }) }).update({ converted_event_id: foreignEvent });
    const invoiceId = await mkInvoice({ dealUuid });
    // The service with the editor as actor: linkDealToProject refuses after
    // the project adopted the invoice's customer.
    const projectService = require('../../src/services/projectService');
    await expect(projectService.assignInvoice(project, invoiceId, { id: editorId, roleName: 'editor' }))
      .rejects.toMatchObject({ code: 'DEAL_EVENT_FORBIDDEN' });
    expect((await db('invoices').where({ id: invoiceId }).first('project_id')).project_id).toBeNull();
    expect((await db('events').where({ id: foreignEvent }).first('project_id')).project_id).toBeNull();
    expect((await db('projects').where({ id: project }).first('customer_account_id')).customer_account_id).toBeNull();
  });

  it('refuses an existing invoice on a project the caller may not tie documents to, before moving anything', async () => {
    // Legacy ownerless project the editor reaches through their own gallery.
    const project = idOf(await db('projects').insert({
      name: 'Legacy', status: 'active', created_by: null, created_at: new Date(), updated_at: new Date(),
    }).returning('id'));
    const own = await mkEvent({ projectId: project });
    await db('events').where({ id: own }).update({ created_by: editorId });
    const loose = await mkEvent();
    await db('events').where({ id: loose }).update({ created_by: editorId });
    const invoiceId = await mkInvoice({ eventId: loose });
    const projectService = require('../../src/services/projectService');
    await expect(projectService.assignInvoice(project, invoiceId, { id: editorId, roleName: 'editor' }))
      .rejects.toMatchObject({ code: 'PROJECT_NOT_LINKABLE' });
    expect((await db('events').where({ id: loose }).first('project_id')).project_id).toBeNull();
    expect((await db('invoices').where({ id: invoiceId }).first('project_id')).project_id).toBeNull();
  });

  it('refuses an existing invoice that already belongs to another project', async () => {
    const a = await createInquiry();
    const b = await createInquiry();
    const invoiceId = await mkInvoice({ projectId: a.id });
    const res = await post(`/api/admin/projects/${b.id}/invoices`, { invoiceId });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PROJECT_INVOICE_ELSEWHERE');
    expect((await db('invoices').where({ id: invoiceId }).first('project_id')).project_id).toBe(a.id);
  });

  it('refuses an existing invoice whose gallery is another customer\'s', async () => {
    const project = await createInquiry();
    const ev = await mkEvent();
    await db('event_customer_assignments').insert({ event_id: ev, customer_account_id: otherCustomerId });
    // The invoice is this project's customer's; its gallery is assigned to another.
    const invoiceId = await mkInvoice({ eventId: ev });
    const res = await post(`/api/admin/projects/${project.id}/invoices`, { invoiceId });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PROJECT_CUSTOMER_MISMATCH');
    expect((await db('events').where({ id: ev }).first('project_id')).project_id).toBeNull();
  });

  it('counts an invoice for its gallery\'s project on the list, even when that project is filtered out', async () => {
    const a = await createInquiry();
    const b = idOf(await db('projects').insert({
      name: 'Done elsewhere', status: 'completed', created_by: superId, created_at: new Date(), updated_at: new Date(),
    }).returning('id'));
    const ev = await mkEvent({ projectId: b });
    await mkInvoice({ projectId: a.id, eventId: ev, total: 777700 });
    const res = await get('/api/admin/projects?status=inquiry,active&withStages=1');
    expect(res.status).toBe(200);
    const list = res.body.data?.projects || res.body.projects || res.body.data || res.body;
    const row = list.find((p) => p.id === a.id);
    const totals = (row.valuation?.byCurrency || []).map((x) => x.totalMinor);
    expect(totals).not.toContain(777700);
  });

  it('refuses an invoice made from a quote that is in another project', async () => {
    const a = await createInquiry();
    const b = await createInquiry();
    const quoteId = await mkQuote({ projectId: b.id, dealUuid: crypto.randomUUID() });
    const res = await post('/api/admin/invoices', {
      customerAccountId: customerId, projectId: a.id, sourceQuoteId: quoteId, currency: 'CHF',
      lineItems: [{ description: 'Rest', quantity: 1, unitPriceMinor: 1000 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PROJECT_SOURCE_MISMATCH');
  });

  it('turns an inquiry that holds something active when it is set to inquiry', async () => {
    const project = await createInquiry();
    await mkEvent({ projectId: project.id });
    // The state a document attached during a reopen leaves behind.
    const res = await put(`/api/admin/projects/${project.id}`, { status: 'inquiry' });
    expect(res.status).toBe(200);
    expect((res.body.data || res.body).project.status).toBe('active');
  });

  // Review round 1 (the-luap), blocker 1: the exact setup of the report.
  it('refuses an invoice whose deal sits in another project, and moves nothing', async () => {
    const a = await createInquiry();
    const b = await createInquiry();
    const dealUuid = crypto.randomUUID();
    const galleryE = await mkEvent({ projectId: b.id });
    const quoteQ = await mkQuote({ projectId: b.id, dealUuid });
    await db('quotes').where({ id: quoteQ }).update({ converted_event_id: galleryE });
    const invoiceI = await mkInvoice({ dealUuid });
    const res = await post(`/api/admin/projects/${a.id}/invoices`, { invoiceId: invoiceI });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PROJECT_DEAL_ELSEWHERE');
    expect((await db('quotes').where({ id: quoteQ }).first('project_id')).project_id).toBe(b.id);
    expect((await db('events').where({ id: galleryE }).first('project_id')).project_id).toBe(b.id);
    expect((await db('invoices').where({ id: invoiceI }).first('project_id')).project_id).toBeNull();
  });

  it('answers in the invoice list whether each invoice may join a project, with the attach\'s own rule', async () => {
    const a = await createInquiry();
    const b = await createInquiry();
    const dealUuid = crypto.randomUUID();
    await mkQuote({ projectId: b.id, dealUuid });
    const invoiceI = await mkInvoice({ dealUuid });
    const rowFor = async (url) => { const { body } = await get(url); return (body.data || body).invoices.find((i) => i.id === invoiceI); };
    expect((await rowFor(`/api/admin/invoices?attachTo=${a.id}&pageSize=100`)).attachRefusal).toBe('PROJECT_DEAL_ELSEWHERE');
    expect((await rowFor(`/api/admin/invoices?attachTo=${b.id}&pageSize=100`)).attachRefusal).toBeNull();
    expect((await rowFor('/api/admin/invoices?pageSize=100')).attachRefusal).toBeUndefined();
    // Nothing about projects with the feature off. The flag is cached, so
    // clear it after each write, as PUT /admin/feature-flags does.
    const { invalidateFeatureFlagCache } = require('../../src/middleware/requireFeatureFlag');
    await db('feature_flags').where({ key: 'projects' }).update({ value: 0 });
    invalidateFeatureFlagCache();
    try {
      expect((await rowFor(`/api/admin/invoices?attachTo=${a.id}&pageSize=100`)).attachRefusal).toBeUndefined();
    } finally {
      await db('feature_flags').where({ key: 'projects' }).update({ value: 1 });
      invalidateFeatureFlagCache();
    }
  });

  // Issue 2224, item 1: attaching a quote or contract moves its whole deal,
  // so the add window has to know when that takes something from another project.
  it('says in the quote and contract lists when attaching one moves something out of another project', async () => {
    const a = await createInquiry();
    const b = await createInquiry();
    const dealUuid = crypto.randomUUID();
    await mkInvoice({ projectId: b.id, dealUuid });
    const quoteQ = await mkQuote({ dealUuid });
    const freeQ = await mkQuote({ dealUuid: crypto.randomUUID() });
    const contractC = idOf(await db('contracts').insert({
      contract_number: `C-MOVES-${a.id}`, customer_account_id: customerId, status: 'sent', deal_uuid: dealUuid,
      issue_date: '2027-02-01', created_at: new Date().toISOString(),
    }).returning('id'));
    const quoteRow = async (url, id) => { const { body } = await get(url); return (body.data || body).quotes.find((q) => q.id === id); };
    const contractRow = async (url) => { const { body } = await get(url); return (body.data || body).contracts.find((c) => c.id === contractC); };

    // The quote itself is free, but its deal's invoice is in B.
    expect((await quoteRow(`/api/admin/quotes?attachTo=${a.id}&pageSize=100`, quoteQ)).attachMoves).toBe(true);
    expect((await quoteRow(`/api/admin/quotes?attachTo=${b.id}&pageSize=100`, quoteQ)).attachMoves).toBe(false);
    expect((await quoteRow(`/api/admin/quotes?attachTo=${a.id}&pageSize=100`, freeQ)).attachMoves).toBe(false);
    expect((await quoteRow('/api/admin/quotes?pageSize=100', quoteQ)).attachMoves).toBeUndefined();
    expect((await contractRow(`/api/admin/contracts?attachTo=${a.id}&pageSize=100`)).attachMoves).toBe(true);
    expect((await contractRow(`/api/admin/contracts?attachTo=${b.id}&pageSize=100`)).attachMoves).toBe(false);
  });

  // Issue 2224, item 2: the attach rules read other projects unscoped, so
  // they answer only for a project the caller may work on.
  it('answers attachTo only for a project the caller may work on', async () => {
    const other = await mkAdmin(`flow-admin-${crypto.randomUUID().slice(0, 8)}`, 'admin');
    const foreign = await createInquiry();
    const own = idOf(await db('projects').insert({
      name: 'Admin own', status: 'inquiry', created_by: other.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id'));
    const dealUuid = crypto.randomUUID();
    await mkQuote({ projectId: foreign.id, dealUuid });
    const invoiceI = await mkInvoice({ dealUuid });
    await db('invoices').where({ id: invoiceI }).update({ created_by_admin_id: other.id });
    const rowFor = async (projectId) => {
      const { body } = await get(`/api/admin/invoices?attachTo=${projectId}&pageSize=100`, other.token);
      return (body.data || body).invoices?.find((i) => i.id === invoiceI);
    };
    // Its own project: the attach rule answers (the deal sits in another project).
    expect((await rowFor(own)).attachRefusal).toBe('PROJECT_DEAL_ELSEWHERE');
    // Another admin's project: nothing about it.
    expect((await rowFor(foreign.id)).attachRefusal).toBeUndefined();
  });

  // Review round 1, concern 1: one deal, one project.
  it('moves a deal\'s invoice with it when its quote is attached to another project', async () => {
    const a = await createInquiry();
    const b = await createInquiry();
    const dealUuid = crypto.randomUUID();
    const invoiceId = await mkInvoice({ projectId: b.id, dealUuid });
    const quoteId = await mkQuote({ dealUuid });
    expect((await post(`/api/admin/projects/${a.id}/quotes`, { quoteId })).status).toBe(200);
    expect((await db('invoices').where({ id: invoiceId }).first('project_id')).project_id).toBe(a.id);
    expect((await overview(a.id)).invoices.map((i) => i.id)).toContain(invoiceId);
    expect((await overview(b.id)).invoices.map((i) => i.id)).not.toContain(invoiceId);
    const list = (await get('/api/admin/projects?withStages=1')).body;
    const rows = list.data?.projects || list.projects || list.data || list;
    const valueOf = (id) => (rows.find((r) => r.id === id).valuation?.byCurrency || []).reduce((n, x) => n + x.totalMinor, 0);
    expect(valueOf(b.id)).toBe(0);
  });

  it('refuses a collected monthly invoice, as creating one in a project does', async () => {
    const project = await createInquiry();
    const invoiceId = await mkInvoice({});
    await db('invoices').where({ id: invoiceId }).update({ is_monthly_draft: true });
    const res = await post(`/api/admin/projects/${project.id}/invoices`, { invoiceId });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PROJECT_INVOICE_COLLECTED_BILLING');
  });

  it('refuses an invoice whose sibling invoice\'s gallery is in another project', async () => {
    const a = await createInquiry();
    const b = await createInquiry();
    const dealUuid = crypto.randomUUID();
    const galleryInB = await mkEvent({ projectId: b.id });
    await mkInvoice({ dealUuid, eventId: galleryInB });
    const invoiceId = await mkInvoice({ dealUuid });
    const res = await post(`/api/admin/projects/${a.id}/invoices`, { invoiceId });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PROJECT_DEAL_ELSEWHERE');
    expect((await db('events').where({ id: galleryInB }).first('project_id')).project_id).toBe(b.id);
  });

  it('takes an invoice back out of the project, only one tied by its own project_id', async () => {
    const project = await createInquiry();
    const invoiceId = await mkInvoice({});
    expect((await post(`/api/admin/projects/${project.id}/invoices`, { invoiceId })).status).toBe(200);
    const del = (id) => request(app).delete(`/api/admin/projects/${project.id}/invoices/${id}`).set('Authorization', `Bearer ${superToken}`);
    expect((await del(invoiceId)).status).toBe(200);
    expect((await db('invoices').where({ id: invoiceId }).first('project_id')).project_id).toBeNull();
    // One that rolls up through its gallery is not tied by project_id.
    const ev = await mkEvent({ projectId: project.id });
    const viaGallery = await mkInvoice({ eventId: ev });
    const res = await del(viaGallery);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PROJECT_INVOICE_NOT_DIRECT');
  });

  it('refuses an invoice made from a quote whose deal is in another project', async () => {
    const a = await createInquiry();
    const b = await createInquiry();
    const dealUuid = crypto.randomUUID();
    const quoteId = await mkQuote({ dealUuid });
    await db('contracts').insert({
      contract_number: `C-DEAL-${a.id}`, customer_account_id: customerId, status: 'fully_signed',
      issue_date: '2027-02-01', project_id: b.id, deal_uuid: dealUuid, created_at: new Date().toISOString(),
    });
    const res = await post('/api/admin/invoices', {
      customerAccountId: customerId, projectId: a.id, sourceQuoteId: quoteId, currency: 'CHF',
      lineItems: [{ description: 'Rest', quantity: 1, unitPriceMinor: 1000 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PROJECT_SOURCE_MISMATCH');
  });

  // Review round 1, concern 2. isString already refuses an array (location);
  // isIn, isInt and isISO8601 check each item, so only the array refusal
  // stops these.
  it.each([
    ['source', ['referral', 'website', 'social', 'returning', 'fair']],
    ['guestCount', ['5', '6']],
    ['eventDate', ['2027-06-12', '2027-06-13']],
    ['status', ['active']],
  ])('refuses an array for %s as a validation error', async (field, value) => {
    const res = await post('/api/admin/projects', { name: 'Array value', [field]: value });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // Review round 1, concern 3.
  it('refuses the delete when something was linked after the census, and unlinks nothing', async () => {
    const projectService = require('../../src/services/projectService');
    const project = await createInquiry();
    const ev = await mkEvent({ projectId: project.id });
    // The census saw one gallery and no invoice; an invoice joined since.
    const invoiceId = await mkInvoice({ projectId: project.id });
    const checked = { ids: { quotes: [], contracts: [], invoices: [], customer_hour_entries: [], customer_documents: [] }, eventIds: [ev] };
    await expect(projectService.deleteProject(project.id, { id: superId }, { checked }))
      .rejects.toMatchObject({ code: 'PROJECT_CHANGED' });
    // Same count, another record: still refused.
    const swapped = { ...checked, ids: { ...checked.ids, invoices: [invoiceId + 100000] } };
    await expect(projectService.deleteProject(project.id, { id: superId }, { checked: swapped }))
      .rejects.toMatchObject({ code: 'PROJECT_CHANGED' });
    expect(await db('projects').where({ id: project.id }).first('id')).toBeTruthy();
    expect((await db('events').where({ id: ev }).first('project_id')).project_id).toBe(project.id);
    expect((await db('invoices').where({ id: invoiceId }).first('project_id')).project_id).toBe(project.id);
  });

  it('answers an unknown status from the service with its own code', async () => {
    const projectService = require('../../src/services/projectService');
    await expect(projectService.createProject({ name: 'Odd', status: 'paused' }, superId))
      .rejects.toMatchObject({ statusCode: 400, code: 'PROJECT_STATUS_UNKNOWN' });
  });

  // Covered by the review's probe, not by a test until now.
  it('answers 404 to an admin attaching another admin\'s invoice, and writes nothing', async () => {
    const other = await mkAdmin(`flow-admin-${crypto.randomUUID().slice(0, 8)}`, 'admin');
    const own = idOf(await db('projects').insert({
      name: 'Admin own', status: 'inquiry', created_by: other.id, created_at: new Date(), updated_at: new Date(),
    }).returning('id'));
    const invoiceId = await mkInvoice({});
    await db('invoices').where({ id: invoiceId }).update({ created_by_admin_id: superId });
    const res = await post(`/api/admin/projects/${own}/invoices`, { invoiceId }, other.token);
    expect(res.status).toBe(404);
    expect((await db('invoices').where({ id: invoiceId }).first('project_id')).project_id).toBeNull();
    expect((await db('projects').where({ id: own }).first('customer_account_id')).customer_account_id).toBeNull();
  });

  it.each([
    ['an unknown flow', { flow: 'express' }],
    ['a stage that cannot be skipped', { skippedStages: ['inquiry'] }],
  ])('refuses %s', async (_label, extra) => {
    const res = await post('/api/admin/projects', { name: 'Bad flow', ...extra });
    expect(res.status).toBe(400);
  });

  it('answers 403 on every project route with the feature off', async () => {
    await db('feature_flags').where({ key: 'projects' }).update({ value: 0 });
    try {
      const res = await post('/api/admin/projects', { name: 'Off', status: 'inquiry' });
      expect(res.status).toBe(403);
      const del = await request(app).delete('/api/admin/projects/1').set('Authorization', `Bearer ${superToken}`);
      expect(del.status).toBe(403);
    } finally {
      await db('feature_flags').where({ key: 'projects' }).update({ value: 1 });
    }
  });
});
