/**
 * Change history (migration 219) for the configuration that feeds accounting
 * documents: the business profile and its bank accounts, ledger accounts, VAT
 * codes, expense categories, customer billing fields and hour entries.
 *
 * Pins which history rows each service write leaves, that customer writes
 * outside the billing fields (logins, passwords, notes, portal switches)
 * leave none, that erasing a customer blanks the personal values in that
 * customer's history while keeping billing settings, and that a history row
 * that cannot be written rolls the change back.
 */
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup; let adminId; let history;
let profileService; let ledgerService; let categoriesService; let customerService; let hoursService;
let seq = 0;

const now = () => new Date().toISOString();
const adminActor = () => expect.objectContaining({ type: 'admin', id: adminId });
const updatesOf = (entries, entity) => entries.filter((e) => e.entity_type === entity && e.action === 'updated');

async function withHistoryTableOffline(work) {
  await db.schema.renameTable('accounting_change_history', 'accounting_change_history_offline');
  try {
    return await work();
  } finally {
    await db.schema.renameTable('accounting_change_history_offline', 'accounting_change_history');
  }
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  history = require('../../src/services/accountingHistory');
  profileService = require('../../src/services/businessProfileService');
  ledgerService = require('../../src/services/ledgerService');
  categoriesService = require('../../src/services/expenseCategoriesService');
  customerService = require('../../src/services/customerAccountsService');
  hoursService = require('../../src/services/customerHoursService');
  await profileService.getProfile();
});

afterAll(async () => { if (cleanup) await cleanup(); });

describe('business profile and bank accounts', () => {
  it('records profile changes and bank accounts, including the default moving between accounts', async () => {
    await profileService.updateProfile({ company_name: 'Studio Nord', vat_id: 'CHE-123.456.789' }, adminId);
    const first = await profileService.createBankAccount({
      label: 'Main', iban: 'CH9300762011623852957', currency: 'CHF', is_default: true,
    }, adminId);
    const second = await profileService.createBankAccount({
      label: 'Second', iban: 'CH5604835012345678009', currency: 'CHF', is_default: true,
    }, adminId);
    await profileService.deleteBankAccount(second.id, adminId);

    const entries = await history.listHistory('business_profile', 1);
    const [profileUpdate] = updatesOf(entries, 'business_profile');
    expect(profileUpdate).toMatchObject({ source: 'business_profile.update', actor: adminActor() });
    expect(profileUpdate.changes.company_name.to).toBe('Studio Nord');
    expect(profileUpdate.changes.vat_id.to).toBe('CHE-123.456.789');

    const created = entries.filter((e) => e.entity_type === 'bank_account' && e.action === 'created');
    expect(created.map((e) => e.entity_id)).toEqual([first.id, second.id]);
    expect(created[0].changes.iban.to).toBe('CH9300762011623852957');
    const lostDefault = updatesOf(entries, 'bank_account').find((e) => e.entity_id === first.id);
    expect(lostDefault.changes.is_default.to).toBeFalsy();
    expect(entries.find((e) => e.action === 'deleted')).toMatchObject({
      entity_type: 'bank_account', entity_id: second.id, source: 'bank_account.delete', actor: adminActor(),
    });
  });

  it('rolls a profile change back when its history row cannot be written', async () => {
    const before = (await db('business_profile').where({ id: 1 }).first()).footer_line;
    await withHistoryTableOffline(() => expect(
      profileService.updateProfile({ footer_line: 'Never written' }, adminId),
    ).rejects.toThrow());
    expect((await db('business_profile').where({ id: 1 }).first()).footer_line).toBe(before);
  });
});

describe('ledger accounts, VAT codes and expense categories', () => {
  it('records create, update and delete with the admin', async () => {
    const account = await ledgerService.createAccount({ number: '9871', name: 'Services', type: 'revenue' }, adminId);
    await ledgerService.updateAccount(account.id, { name: 'Photo services' }, adminId);
    const vat = await ledgerService.createVatCode({ code: 'HIST', name: 'History', rate: 8.1, direction: 'output' }, adminId);
    await ledgerService.updateVatCode(vat.id, { rate: 7.7 }, adminId);
    await ledgerService.deleteVatCode(vat.id, adminId);
    const category = await categoriesService.create({ name: 'Travel' }, adminId);
    await ledgerService.setCategoryAccount(category.id, account.id, adminId);
    await categoriesService.update(category.id, { name: 'Travel & lodging' }, adminId);
    await categoriesService.remove(category.id, adminId);
    await ledgerService.deleteAccount(account.id, adminId);

    const accountEntries = await history.listHistory('ledger_account', account.id);
    expect(accountEntries.map((e) => e.action)).toEqual(['created', 'updated', 'deleted']);
    expect(accountEntries[1].changes).toEqual({ name: { from: 'Services', to: 'Photo services' } });
    expect(accountEntries.every((e) => e.actor.type === 'admin' && e.actor.id === adminId)).toBe(true);

    const vatEntries = await history.listHistory('vat_code', vat.id);
    expect(vatEntries.map((e) => e.action)).toEqual(['created', 'updated', 'deleted']);
    expect(Number(vatEntries[1].changes.rate.to)).toBe(7.7);

    const categoryEntries = await history.listHistory('expense_category', category.id);
    expect(categoryEntries.map((e) => [e.action, e.source])).toEqual([
      ['created', 'expense_category.create'],
      ['updated', 'expense_category.ledger_account'],
      ['updated', 'expense_category.update'],
      ['deleted', 'expense_category.delete'],
    ]);
    expect(categoryEntries[1].changes.ledger_account_id).toEqual({ from: null, to: account.id });
  });
});

describe('customers', () => {
  async function createCustomer() {
    seq += 1;
    return customerService.createDirect({
      email: `hist-config-${seq}@example.com`,
      prefill: { first_name: 'Tina', last_name: 'Muster', display_name: 'Tina Muster', company_name: 'Muster GmbH', vat_id: 'DE123' },
      createdByAdminId: adminId,
    });
  }
  const idOf = (created) => created.id ?? created.customer?.id ?? created;

  it('records only billing fields, and nothing for logins, passwords, notes or portal switches', async () => {
    const customerId = idOf(await createCustomer());
    await customerService.updateCustomer(customerId, { billing_cadence: 'monthly', hourly_rate_minor: 15000 }, adminId);
    await customerService.updateCustomer(customerId, { notes: 'Prefers email', feature_quotes: false }, adminId);
    await customerService.deactivateCustomer(customerId, adminId);
    await history.auditedUpdate(db, 'customer_accounts', { id: customerId },
      { last_login: now(), last_login_ip: '203.0.113.9' }, { actor: { type: 'customer', id: customerId } });

    const entries = await history.listHistory('customer', customerId);
    const created = entries.find((e) => e.action === 'created');
    expect(created).toMatchObject({ entity_type: 'customer', source: 'customer.create', actor: adminActor() });
    expect(created.changes.company_name.to).toBe('Muster GmbH');
    for (const column of ['password_hash', 'is_active', 'feature_quotes', 'notes', 'created_by_admin_id']) {
      expect(created.changes).not.toHaveProperty(column);
    }
    const updates = updatesOf(entries, 'customer');
    expect(updates).toHaveLength(1);
    expect(updates[0].changes).toEqual({
      billing_cadence: { from: expect.anything(), to: 'monthly' },
      hourly_rate_minor: { from: null, to: 15000 },
    });
  });

  it('records hour entries under the customer', async () => {
    const customerId = idOf(await createCustomer());
    const [{ id: entryId }] = await history.auditedInsert(db, 'customer_hour_entries', {
      customer_account_id: customerId, entry_date: '2026-06-02', start_time: '09:00', end_time: '10:00',
      duration_minutes: 60, description: 'Shoot', status: 'unbilled', recorded_by_admin_id: adminId,
      created_at: now(), updated_at: now(),
    }, { actor: adminId, source: 'test.fixture' });
    await hoursService.updateEntry(entryId, { endTime: '11:30' }, adminId);
    await hoursService.deleteEntry(entryId, adminId);

    const entries = (await history.listHistory('customer', customerId)).filter((e) => e.entity_type === 'hour_entry');
    expect(entries.map((e) => [e.action, e.source])).toEqual([
      ['created', 'test.fixture'], ['updated', 'hours.updateEntry'], ['deleted', 'hours.deleteEntry'],
    ]);
    expect(entries[1].changes.duration_minutes).toEqual({ from: 60, to: 150 });
  });

  it('updates billed hours and their invoice with a cold schema cache', async () => {
    const customerId = idOf(await createCustomer());
    await customerService.updateCustomer(customerId, { hourly_rate_minor: 5000 }, adminId);
    const [invoice] = await history.auditedInsert(db, 'invoices', {
      invoice_number: `CONFIG-HOURS-${customerId}`, customer_account_id: customerId,
      issue_date: '2026-09-01', due_date: '2026-09-30', status: 'draft', is_monthly_draft: true,
    });
    const [line] = await history.auditedInsert(db, 'invoice_line_items', {
      invoice_id: invoice.id, description: 'Shoot', quantity: 1,
      unit_price_minor: 5000, line_total_minor: 5000,
    });
    const [entry] = await history.auditedInsert(db, 'customer_hour_entries', {
      customer_account_id: customerId, entry_date: '2026-09-01', start_time: '09:00', end_time: '10:00',
      duration_minutes: 60, description: 'Shoot', status: 'billed',
      invoice_id: invoice.id, invoice_line_item_id: line.id,
    });
    require('../../src/utils/schemaCache').invalidateSchemaCache();
    await hoursService.updateEntry(entry.id, { endTime: '11:00' }, adminId);
    expect(Number((await db('invoice_line_items').where({ id: line.id }).first()).line_total_minor)).toBe(10000);
    const invoiceHistory = await history.listHistory('invoice', invoice.id);
    expect(invoiceHistory.find((e) => e.entity_type === 'invoice_line_item' && e.action === 'updated').changes.line_total_minor)
      .toEqual({ from: 5000, to: 10000 });
    const hoursHistory = await history.listHistory('customer', customerId);
    expect(hoursHistory.find((e) => e.entity_type === 'hour_entry' && e.action === 'updated').changes.duration_minutes)
      .toEqual({ from: 60, to: 120 });
  });

  it('blanks personal values in the customer\'s history on erasure and keeps billing settings', async () => {
    const customerId = idOf(await createCustomer());
    const app = buildRouteApp('/api/customer', require('../../src/routes/customer'));
    const token = require('jsonwebtoken').sign({ type: 'customer', customerId }, process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' });
    const edited = await request(app).put('/api/customer/profile')
      .set('Cookie', `${require('../../src/utils/tokenUtils').CUSTOMER_COOKIE_NAME}=${token}`).send({ city: 'Bern' });
    expect(edited.status).toBe(200);
    const portalEntry = (await history.listHistory('customer', customerId)).find((e) => e.source === 'customer.portal.profile');
    expect(portalEntry.actor).toEqual({ type: 'customer', id: customerId, name: 'Tina Muster' });
    await customerService.updateCustomer(customerId, { city: 'Zürich', billing_cadence: 'monthly' }, adminId);
    const [quote] = await history.auditedInsert(db, 'quotes', {
      quote_number: `CONFIG-ERASE-${customerId}`, customer_account_id: customerId, status: 'sent',
      issue_date: '2026-09-01', valid_until: '2026-09-30',
    }, { actor: adminId, source: 'test.fixture' });
    await history.auditedUpdate(db, 'quotes', { id: quote.id }, { status: 'accepted' },
      { actor: { type: 'customer', id: customerId, name: 'Tina Muster' }, source: 'quote.respond' });
    await customerService.eraseCustomer(customerId, adminId);

    const entries = await history.listHistory('customer', customerId);
    const text = JSON.stringify(entries);
    for (const personal of ['Tina', 'Muster', 'Zürich', 'DE123', `hist-config-${seq}@example.com`]) {
      expect(text).not.toContain(personal);
    }
    const cityChange = updatesOf(entries, 'customer').find((e) => e.changes.city && e.source === 'customer.update');
    expect(cityChange.changes.city).toEqual({ from: '[erased]', to: '[erased]' });
    expect(cityChange.changes.billing_cadence.to).toBe('monthly');
    expect(entries.find((e) => e.source === 'customer.portal.profile').actor)
      .toEqual({ type: 'customer', id: customerId, name: '[erased]' });
    expect(entries.find((e) => e.source === 'customer.erase')).toMatchObject({ actor: adminActor() });
    // Their portal actions on documents lose the name too; the document changes stay.
    const quoteEntries = await history.listHistory('quote', quote.id);
    expect(JSON.stringify(quoteEntries)).not.toContain('Tina');
    expect(quoteEntries.find((e) => e.source === 'quote.respond')).toMatchObject({
      actor: { type: 'customer', id: customerId, name: '[erased]' },
      changes: { status: { from: 'sent', to: 'accepted' } },
    });
  });

  it('rolls a customer change back when its history row cannot be written', async () => {
    const customerId = idOf(await createCustomer());
    await withHistoryTableOffline(() => expect(
      customerService.updateCustomer(customerId, { vat_id: 'CHANGED' }, adminId),
    ).rejects.toThrow());
    expect((await db('customer_accounts').where({ id: customerId }).first()).vat_id).toBe('DE123');
  });
});

describe('history routes', () => {
  it('serve customer history behind customers.view', async () => {
    const created = await customerService.createDirect({
      email: 'hist-route@example.com', prefill: { company_name: 'Route GmbH' }, createdByAdminId: adminId,
    });
    const customerId = created.id ?? created.customer?.id ?? created;
    const app = buildRouteApp('/api/admin/customers', require('../../src/routes/adminCustomers'));
    const [viewer] = await db('admin_users').insert({
      username: 'history-nobody', email: 'history-nobody@example.com', password_hash: 'x',
      must_change_password: false, created_at: now(),
    }).returning('id');
    const denied = await request(app).get(`/api/admin/customers/${customerId}/history`)
      .set('Authorization', `Bearer ${mintAdminToken(viewer.id ?? viewer)}`);
    expect(denied.status).toBe(403);

    await assignAdminRole(db, adminId);
    const res = await request(app).get(`/api/admin/customers/${customerId}/history`)
      .set('Authorization', `Bearer ${mintAdminToken(adminId)}`);
    expect(res.status).toBe(200);
    expect((res.body.entries ?? res.body.data.entries).length).toBeGreaterThan(0);

    await history.auditedInsert(db, 'customer_hour_entries', {
      customer_account_id: customerId, entry_date: '2026-06-02', start_time: '09:00', end_time: '10:00',
      duration_minutes: 60, description: 'Route shoot', status: 'unbilled', recorded_by_admin_id: adminId,
      created_at: now(), updated_at: now(),
    }, { actor: adminId, source: 'test.fixture' });
    const { invalidateFeatureFlagCache } = require('../../src/middleware/requireFeatureFlag');
    const entityTypes = async (enabled) => {
      await db('feature_flags').where({ key: 'hoursLogging' }).del();
      await db('feature_flags').insert({ key: 'hoursLogging', value: enabled });
      invalidateFeatureFlagCache();
      const r = await request(app).get(`/api/admin/customers/${customerId}/history`)
        .set('Authorization', `Bearer ${mintAdminToken(adminId)}`);
      expect(r.status).toBe(200);
      return (r.body.entries ?? r.body.data.entries).map((e) => e.entity_type);
    };
    expect(await entityTypes(false)).not.toContain('hour_entry');
    expect(await entityTypes(false)).toContain('customer');
    expect(await entityTypes(true)).toContain('hour_entry');
  });
});
