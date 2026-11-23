/**
 * The quote editor's customer and currency changes on a saved quote.
 *
 * quoteService -> SQLite with the full core-migration run (helpers/crmDb).
 * Pins: a draft saves a new customer and currency, with createQuote's
 * customer checks and the new currency's bank account; a new customer
 * re-runs the project's customer check, leaves the old customer's deal,
 * closes the links the old customer was sent, and is refused on a booking
 * request's quote and on a quote an invoice or contract was made from; a
 * sent quote refuses both, and a quote whose status changed mid-save is
 * refused.
 */

const crypto = require('crypto');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let quoteService;

const prevCwd = process.cwd();

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  ({ adminId, customerId } = await seedMinimal(db));
  // Required after bootCrmDb: at module load it would initialise the db
  // module before the helper points it at the temp database.
  quoteService = require('../../src/services/quoteService');
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

describe('updateQuote customer and currency', () => {
  async function insertId(table, row) {
    const [inserted] = await db(table).insert(row).returning('id');
    return inserted?.id ?? inserted;
  }
  let otherCustomerId;
  let chfBankId;
  let eurBankId;

  beforeAll(async () => {
    otherCustomerId = await insertId('customer_accounts', {
      email: 'other@example.com', display_name: 'Other Customer', preferred_language: 'en', is_active: 1,
      created_at: new Date(),
    });
    await db('business_bank_accounts').update({ is_default: false });
    chfBankId = await insertId('business_bank_accounts', { label: 'CHF', iban: 'CH9300762011623852957', currency: 'CHF', is_default: true });
    eurBankId = await insertId('business_bank_accounts', { label: 'EUR', iban: 'DE89370400440532013000', currency: 'EUR', is_default: true });
  });

  const draft = () => quoteService.createQuote({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0,
    lineItems: [{ position: 1, quantity: 1, description: 'Wedding day', unit_price_minor: 100000 }],
  }, adminId);

  it('saves a new customer and currency on a draft, with the new currency\'s bank account', async () => {
    const quoteId = await draft();
    expect((await db('quotes').where({ id: quoteId }).first()).business_bank_account_id).toBe(chfBankId);

    // The editor echoes the stored bank account back.
    await quoteService.updateQuote(quoteId, {
      customerAccountId: otherCustomerId, currency: 'eur', businessBankAccountId: chfBankId,
    }, adminId);

    const row = await db('quotes').where({ id: quoteId }).first();
    expect(Number(row.customer_account_id)).toBe(otherCustomerId);
    expect(row.currency).toBe('EUR');
    expect(row.business_bank_account_id).toBe(eurBankId);
  });

  it('resolves a line\'s rate against the new customer', async () => {
    await db('customer_accounts').where({ id: otherCustomerId }).update({ hourly_rate_minor: 20000 });
    const quoteId = await draft();
    await quoteService.updateQuote(quoteId, {
      customerAccountId: otherCustomerId,
      lineItems: [{ position: 1, quantity: 1, description: 'Shooting', unit_price_minor: 0, price_mode: 'hour', rate_source: 'auto' }],
    }, adminId);
    const { lineItems } = await quoteService.getQuoteById(quoteId);
    expect(lineItems[0].rate_source).toBe('customer');
    expect(Number(lineItems[0].unit_price_minor)).toBe(20000);
  });

  it('runs the create-time customer checks on the new customer', async () => {
    const quoteId = await draft();
    const disabledId = await insertId('customer_accounts', {
      email: 'noquotes@example.com', display_name: 'No Quotes', is_active: 1, feature_quotes: false,
      created_at: new Date(),
    });
    await expect(quoteService.updateQuote(quoteId, { customerAccountId: disabledId }, adminId))
      .rejects.toMatchObject({ code: 'CUSTOMER_FEATURE_DISABLED' });
    await expect(quoteService.updateQuote(quoteId, { customerAccountId: 999999 }, adminId))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(Number((await db('quotes').where({ id: quoteId }).first()).customer_account_id)).toBe(customerId);
  });

  it('refuses a new customer while the quote stays in the old customer\'s project', async () => {
    const projectId = await insertId('projects', {
      name: 'Hochzeit Muster', customer_account_id: customerId, created_by: adminId,
      created_at: new Date(), updated_at: new Date(),
    });
    const quoteId = await draft();
    await quoteService.updateQuote(quoteId, { projectId }, adminId);

    // Editor shape (project echoed back) and script shape (project left out).
    await expect(quoteService.updateQuote(quoteId, { customerAccountId: otherCustomerId, projectId }, adminId))
      .rejects.toMatchObject({ code: 'PROJECT_CUSTOMER_MISMATCH' });
    await expect(quoteService.updateQuote(quoteId, { customerAccountId: otherCustomerId }, adminId))
      .rejects.toMatchObject({ code: 'PROJECT_CUSTOMER_MISMATCH' });
    expect(Number((await db('quotes').where({ id: quoteId }).first()).customer_account_id)).toBe(customerId);

    // Leaving the project with the customer change saves.
    await quoteService.updateQuote(quoteId, { customerAccountId: otherCustomerId, projectId: null }, adminId);
    const row = await db('quotes').where({ id: quoteId }).first();
    expect(Number(row.customer_account_id)).toBe(otherCustomerId);
    expect(row.project_id).toBeNull();
  });

  it('refuses a customer or currency change once the quote was sent, and still saves the rest', async () => {
    const quoteId = await draft();
    await db('quotes').where({ id: quoteId }).update({ status: 'sent' });
    await expect(quoteService.updateQuote(quoteId, { customerAccountId: otherCustomerId }, adminId))
      .rejects.toMatchObject({ code: 'QUOTE_NOT_DRAFT' });
    await expect(quoteService.updateQuote(quoteId, { currency: 'EUR' }, adminId))
      .rejects.toMatchObject({ code: 'QUOTE_NOT_DRAFT' });

    // The editor always sends both; unchanged they don't block the save.
    await quoteService.updateQuote(quoteId, { customerAccountId: customerId, currency: 'CHF', eventName: 'Hochzeit' }, adminId);
    const row = await db('quotes').where({ id: quoteId }).first();
    expect(row.event_name).toBe('Hochzeit');
    expect(row.status).toBe('draft');
  });

  it('treats a stored currency in another case, or none, as unchanged on a sent quote', async () => {
    const lower = await draft();
    await db('quotes').where({ id: lower }).update({ status: 'sent', currency: 'chf' });
    await quoteService.updateQuote(lower, { customerAccountId: customerId, currency: 'CHF', eventName: 'Echo' }, adminId);
    expect((await db('quotes').where({ id: lower }).first()).event_name).toBe('Echo');

    const legacy = await draft();
    // quotes.currency is NOT NULL; a legacy row can still hold an empty one.
    await db('quotes').where({ id: legacy }).update({ status: 'sent', currency: '' });
    await quoteService.updateQuote(legacy, { customerAccountId: customerId, currency: 'CHF', eventName: 'Legacy' }, adminId);
    const row = await db('quotes').where({ id: legacy }).first();
    expect(row.event_name).toBe('Legacy');
    expect(row.currency).toBe('');
  });

  it('moves a reissued draft to a deal of its own when the customer changes', async () => {
    const original = await draft();
    const originalRow = await db('quotes').where({ id: original }).first();
    await db('quotes').where({ id: original }).update({ status: 'declined' });
    const reissue = await quoteService.createQuote({
      customerAccountId: customerId, currency: 'CHF', vatRate: 0,
      dealUuid: originalRow.deal_uuid, replacesQuoteId: original,
      lineItems: [{ position: 1, quantity: 1, description: 'Wedding day', unit_price_minor: 100000 }],
    }, adminId);

    await quoteService.updateQuote(reissue, { customerAccountId: otherCustomerId }, adminId);

    const row = await db('quotes').where({ id: reissue }).first();
    expect(Number(row.customer_account_id)).toBe(otherCustomerId);
    expect(row.deal_uuid).toEqual(expect.any(String));
    expect(row.deal_uuid).not.toBe(originalRow.deal_uuid);
    expect(row.replaces_quote_id).toBeNull();
    const old = await db('quotes').where({ id: original }).first();
    expect(old.deal_uuid).toBe(originalRow.deal_uuid);
    expect(Number(old.customer_account_id)).toBe(customerId);
    expect((await quoteService.getQuoteById(original)).quote.replaced_by_quote_id).toBeNull();

    // A save that keeps the customer keeps the deal.
    await quoteService.updateQuote(reissue, { customerAccountId: otherCustomerId, eventName: 'Kept' }, adminId);
    expect((await db('quotes').where({ id: reissue }).first()).deal_uuid).toBe(row.deal_uuid);
  });

  it('refuses a new customer on a quote a booking request is linked to', async () => {
    const quoteId = await draft();
    const before = await db('quotes').where({ id: quoteId }).first();
    const start = new Date(Date.now() + 7 * 86400000);
    await db('booking_requests').insert({
      reference: 'QDRAFT0001', status: 'accepted', service_name: 'Wedding day',
      starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600000).toISOString(),
      hold_expires_at: start.toISOString(), name: 'Booker', email: 'booker@example.test', currency: 'CHF',
      customer_account_id: customerId, quote_id: quoteId,
    });

    await expect(quoteService.updateQuote(quoteId, { customerAccountId: otherCustomerId }, adminId))
      .rejects.toMatchObject({ statusCode: 409, code: 'QUOTE_BOOKING_LINKED' });
    const row = await db('quotes').where({ id: quoteId }).first();
    expect(Number(row.customer_account_id)).toBe(customerId);
    expect(row.deal_uuid).toBe(before.deal_uuid);

    // Other edits still save.
    await quoteService.updateQuote(quoteId, { customerAccountId: customerId, eventName: 'Booked' }, adminId);
    expect((await db('quotes').where({ id: quoteId }).first()).event_name).toBe('Booked');
  });

  it('closes the links the old customer was sent when the customer changes', async () => {
    const quoteId = await draft();
    const later = new Date(Date.now() + 30 * 86400000).toISOString();
    const answeredAt = new Date(Date.now() - 86400000).toISOString();
    // A quote sent to the old customer, answered once, then edited back to a draft.
    await db('quote_action_tokens').insert([
      { quote_id: quoteId, token: 'a'.repeat(64), expires_at: later },
      { quote_id: quoteId, token: 'b'.repeat(64), expires_at: later, used_at: answeredAt, used_action: 'declined' },
    ]);

    // A save that keeps the customer leaves them alone.
    await quoteService.updateQuote(quoteId, { customerAccountId: customerId, eventName: 'Same' }, adminId);
    let rows = await db('quote_action_tokens').where({ quote_id: quoteId }).orderBy('token');
    expect(rows.every((r) => new Date(r.expires_at).getTime() > Date.now())).toBe(true);

    await quoteService.updateQuote(quoteId, { customerAccountId: otherCustomerId }, adminId);
    rows = await db('quote_action_tokens').where({ quote_id: quoteId }).orderBy('token');
    expect(rows.every((r) => new Date(r.expires_at).getTime() <= Date.now())).toBe(true);
    expect(rows[0].used_action).toBe('revoked');
    expect(rows[0].used_at).toBeTruthy();
    // The earlier answer stays on record.
    expect(rows[1].used_action).toBe('declined');
    expect(new Date(rows[1].used_at).toISOString()).toBe(answeredAt);
  });

  it.each([
    ['an invoice', 'invoices', (quoteId) => ({
      invoice_number: `QDRAFT-INV-${quoteId}`, customer_account_id: customerId, issue_date: '2026-06-01',
      due_date: '2026-06-30', status: 'draft', currency: 'CHF', net_amount_minor: 10000, vat_amount_minor: 0,
      total_amount_minor: 10000, created_by_admin_id: adminId, deal_uuid: crypto.randomUUID(), source_quote_id: quoteId,
    })],
    ['a contract', 'contracts', (quoteId) => ({
      contract_number: `QDRAFT-CON-${quoteId}`, customer_account_id: customerId, issue_date: '2026-06-01',
      created_by_admin_id: adminId, deal_uuid: crypto.randomUUID(), source_quote_id: quoteId,
    })],
  ])('refuses a new customer on a quote %s was made from', async (_label, table, row) => {
    const quoteId = await draft();
    const before = await db('quotes').where({ id: quoteId }).first();
    await db(table).insert(row(quoteId));

    await expect(quoteService.updateQuote(quoteId, { customerAccountId: otherCustomerId }, adminId))
      .rejects.toMatchObject({ statusCode: 409, code: 'QUOTE_HAS_DOCUMENTS' });
    const after = await db('quotes').where({ id: quoteId }).first();
    expect(Number(after.customer_account_id)).toBe(customerId);
    expect(after.deal_uuid).toBe(before.deal_uuid);

    // Other edits still save.
    await quoteService.updateQuote(quoteId, { customerAccountId: customerId, eventName: 'Kept' }, adminId);
    expect((await db('quotes').where({ id: quoteId }).first()).event_name).toBe('Kept');
  });

  it('refuses the save when the quote left its status after it was read', async () => {
    const quoteId = await draft();
    // The quote is sent between updateQuote's draft check and its
    // transaction: the new currency's bank account is resolved in between.
    const businessProfileService = require('../../src/services/businessProfileService');
    const realResolve = businessProfileService.resolveBankAccountForCurrency;
    const spy = jest.spyOn(businessProfileService, 'resolveBankAccountForCurrency').mockImplementationOnce(async (...args) => {
      await db('quotes').where({ id: quoteId }).update({ status: 'sent' });
      return realResolve(...args);
    });
    try {
      await expect(quoteService.updateQuote(quoteId, { customerAccountId: otherCustomerId, currency: 'EUR' }, adminId))
        .rejects.toMatchObject({ statusCode: 409, code: 'QUOTE_NOT_DRAFT' });
    } finally {
      spy.mockRestore();
    }
    const row = await db('quotes').where({ id: quoteId }).first();
    expect(Number(row.customer_account_id)).toBe(customerId);
    expect(row.currency).toBe('CHF');
    expect(row.status).toBe('sent');
  });
});
