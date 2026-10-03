/**
 * GET /api/admin/deals/:uuid/documents — each document class keeps its own
 * view permission.
 *
 * The lineage route was gated on customers.view alone and returned every
 * quote, contract and invoice of the deal, so a role that may read a quote
 * (and gets the deal UUID from it) could read contract titles and invoice
 * amounts without contracts.view / bills.view.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-deal-docs-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'deal-docs-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-deal-docs-storage-'));

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');
const svc = require('../../src/services/userManagementService');
const { clearPermissionCache } = require('../../src/middleware/permissions');

const DEAL = '11111111-2222-4333-8444-555555555555';

describe('deal lineage — per-document-class permissions', () => {
  let db; let cleanup; let app;
  let superTok; let quotesOnlyTok; let customersOnlyTok; let photographerTok;

  const auth = (req, tok) => req.set('Authorization', `Bearer ${tok}`);
  const insertId = async (table, row) => {
    const ins = await db(table).insert(row).returning('id');
    return ins[0]?.id ?? ins[0];
  };
  const adminWithRole = async (username, roleId) => mintAdminToken(await insertId('admin_users', {
    username, email: `${username}@example.com`, password_hash: 'x', role_id: roleId,
    must_change_password: false, created_at: new Date().toISOString(),
  }));
  const kinds = (body) => ({
    quotes: body.quotes.length, contracts: body.contracts.length, invoices: body.invoices.length,
  });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId: superId, customerId } = await seedMinimal(db);
    await assignAdminRole(db, superId, 'super_admin');
    superTok = mintAdminToken(superId);

    const quotesOnly = await svc.createRole({ name: 'quotes_only', permissions: ['customers.view', 'quotes.view'] }, superId);
    quotesOnlyTok = await adminWithRole('quotes-only', quotesOnly.id);
    const customersOnly = await svc.createRole({ name: 'customers_only', permissions: ['customers.view'] }, superId);
    customersOnlyTok = await adminWithRole('customers-only', customersOnly.id);
    const photographer = await db('roles').where({ name: 'team_photographer' }).first();
    photographerTok = await adminWithRole('photographer', photographer.id);
    clearPermissionCache();

    await db('quotes').insert({
      quote_number: 'Q-DEAL-1', customer_account_id: customerId, status: 'accepted', deal_uuid: DEAL,
      issue_date: '2026-07-01', event_date: '2026-08-12', event_name: 'Deal shoot', created_at: new Date().toISOString(),
    });
    await db('contracts').insert({
      contract_number: 'C-DEAL-1', customer_account_id: customerId, status: 'signed_by_customer', deal_uuid: DEAL,
      title: 'Secret contract title', issue_date: '2026-07-02', event_date: '2026-08-12', event_name: 'Deal shoot',
      created_at: new Date().toISOString(),
    });
    await db('invoices').insert({
      invoice_number: 'I-DEAL-1', customer_account_id: customerId, status: 'sent', deal_uuid: DEAL,
      issue_date: '2026-08-13', due_date: '2026-08-27', total_amount_minor: 123456, created_at: new Date().toISOString(),
    });

    app = buildRouteApp('/api/admin/deals', require('../../src/routes/adminDeals'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  const get = (tok) => auth(request(app).get(`/api/admin/deals/${DEAL}/documents`), tok);
  const body = (res) => res.body.data || res.body;

  it('returns only quotes to a role with quotes.view', async () => {
    const res = await get(quotesOnlyTok);
    expect(res.status).toBe(200);
    expect(kinds(body(res))).toEqual({ quotes: 1, contracts: 0, invoices: 0 });
    expect(JSON.stringify(res.body)).not.toContain('Secret contract title');
    expect(JSON.stringify(res.body)).not.toContain('123456');
  });

  it('returns no documents to a customers.view-only role', async () => {
    const res = await get(customersOnlyTok);
    expect(res.status).toBe(200);
    expect(kinds(body(res))).toEqual({ quotes: 0, contracts: 0, invoices: 0 });
  });

  it('keeps contracts away from the shipped team_photographer preset', async () => {
    const res = await get(photographerTok);
    expect(res.status).toBe(200);
    expect(kinds(body(res))).toEqual({ quotes: 1, contracts: 0, invoices: 1 });
  });

  it('returns the full lineage to a caller holding all three view permissions', async () => {
    const res = await get(superTok);
    expect(res.status).toBe(200);
    expect(kinds(body(res))).toEqual({ quotes: 1, contracts: 1, invoices: 1 });
  });
});
