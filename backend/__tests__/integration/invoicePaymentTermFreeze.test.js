/**
 * Every invoice owns its payment term (services/invoice/paymentTerm.js).
 *
 * quoteService + invoiceService -> SQLite with the full core-migration run
 * (helpers/crmDb). Pins:
 *   - an invoice made from a quote stores the term it shows, complete, with
 *     the global Skonto default already applied where the quote had none;
 *   - a later resend / edit / admin acceptance of the quote, or a changed
 *     global default, changes neither its rendered term nor the Skonto the
 *     payment check offers;
 *   - an invoice's own partial term is completed once, at creation;
 *   - instalments spawned without a term (convertToEvent's shape), monthly
 *     drafts and ad-hoc invoices store theirs too, and a reissue keeps the
 *     term of the invoice it replaces;
 *   - an invoice without a frozen term still resolves as before.
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
let invoiceService;
let buildInvoiceRenderContext;

const prevCwd = process.cwd();

async function insertId(table, row) {
  const [inserted] = await db(table).insert(row).returning('id');
  return inserted?.id ?? inserted;
}

async function setSetting(key, value) {
  await db('app_settings').where({ setting_key: key }).del();
  if (value !== null) {
    await db('app_settings').insert({
      setting_key: key, setting_value: JSON.stringify(value), setting_type: 'crm', updated_at: new Date().toISOString(),
    });
  }
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  ({ adminId, customerId } = await seedMinimal(db));
  quoteService = require('../../src/services/quoteService');
  invoiceService = require('../../src/services/invoiceService');
  ({ buildInvoiceRenderContext } = require('../../src/services/invoice/render'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

beforeEach(async () => {
  await setSetting('crm_invoices_skonto_percent_default', null);
  await setSetting('crm_invoices_skonto_business_days', null);
  await setSetting('crm_payment_default_net_days', null);
});

let seq = 0;
async function terms({ netDays, skonto = null, skontoDays = null }) {
  seq += 1;
  const net = await insertId('payment_net_days_templates', {
    name: `Freeze net ${seq}`, description: `${netDays} days net`, net_days: netDays,
    skonto_percent: skonto, skonto_within_days: skontoDays,
  });
  const timing = await insertId('payment_timing_templates', {
    name: `Freeze timing ${seq}`, description: 'Everything after the event',
    installments: JSON.stringify([{ percent: 100, label: 'Full' }]),
  });
  return { paymentNetDaysTemplateId: net, paymentTimingTemplateId: timing };
}

const lines = [{ position: 1, quantity: 1, description: 'Wedding day', unit_price_minor: 100000 }];

const sentQuote = async (term) => {
  const quoteId = await quoteService.createQuote({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0, lineItems: lines, ...term,
  }, adminId);
  await quoteService.sendQuote(quoteId, adminId);
  return quoteId;
};

const invoiceFrom = async (quoteId, extra = {}) => {
  const { invoiceIds } = await invoiceService.createInvoice({
    customerAccountId: customerId, sourceQuoteId: quoteId, currency: 'CHF', vatRate: 0, lineItems: lines, ...extra,
  }, adminId);
  return invoiceIds[0];
};

const loadInvoice = (id) => db('invoices').where({ id }).first();
const renderedTerm = async (id) => (await buildInvoiceRenderContext(await loadInvoice(id), [])).paymentTerm;
const skontoOf = async (id) => invoiceService.resolveSkontoPercentForInvoice(await loadInvoice(id));
const snapshotOf = async (id) => JSON.parse((await loadInvoice(id)).payment_term_snapshot);

test('an invoice made from a quote keeps its explicit Skonto through a resend and an admin acceptance', async () => {
  const quoteId = await sentQuote(await terms({ netDays: 20, skonto: 3, skontoDays: 10 }));
  const invoiceId = await invoiceFrom(quoteId);
  expect(await snapshotOf(invoiceId)).toEqual(expect.objectContaining({
    net_days: 20, skonto_percent: 3, skonto_within_days: 10, frozen: true,
  }));

  // The quote moves to other terms and is sent and accepted with them.
  await quoteService.updateQuote(quoteId, await terms({ netDays: 10, skonto: 1, skontoDays: 5 }), adminId);
  await quoteService.sendQuote(quoteId, adminId);
  await quoteService.adminAcceptQuote(quoteId, adminId);
  expect(JSON.parse((await db('quotes').where({ id: quoteId }).first()).payment_term_snapshot))
    .toEqual(expect.objectContaining({ skonto_percent: 1 }));

  expect(await renderedTerm(invoiceId)).toEqual(expect.objectContaining({ netDays: 20, skontoPercent: 3, skontoWithinDays: 10 }));
  expect(await skontoOf(invoiceId)).toBe(3);
});

test('a quote without Skonto gives its invoice the global default, which a later default does not change', async () => {
  await setSetting('crm_invoices_skonto_percent_default', 2);
  await setSetting('crm_invoices_skonto_business_days', 7);
  const quoteId = await sentQuote(await terms({ netDays: 30 }));
  expect(JSON.parse((await db('quotes').where({ id: quoteId }).first()).payment_term_snapshot).skonto_percent).toBeNull();
  const invoiceId = await invoiceFrom(quoteId);
  expect(await snapshotOf(invoiceId)).toEqual(expect.objectContaining({
    net_days: 30, skonto_percent: 2, skonto_within_days: 7, frozen: true,
  }));

  await setSetting('crm_invoices_skonto_percent_default', 5);
  await setSetting('crm_invoices_skonto_business_days', 3);
  // And the quote is edited (its snapshot cleared) and accepted from draft.
  await quoteService.updateQuote(quoteId, await terms({ netDays: 10, skonto: 1, skontoDays: 5 }), adminId);
  await quoteService.adminAcceptQuote(quoteId, adminId);

  expect(await renderedTerm(invoiceId)).toEqual(expect.objectContaining({ netDays: 30, skontoPercent: 2, skontoWithinDays: 7 }));
  expect(await skontoOf(invoiceId)).toBe(2);
});

test('an invoice whose quote and defaults had no Skonto does not pick up a default set later', async () => {
  const quoteId = await sentQuote(await terms({ netDays: 14 }));
  const invoiceId = await invoiceFrom(quoteId);
  expect(await snapshotOf(invoiceId)).toEqual(expect.objectContaining({ net_days: 14, skonto_percent: null, frozen: true }));

  await setSetting('crm_invoices_skonto_percent_default', 4);
  await setSetting('crm_invoices_skonto_business_days', 10);

  expect(await renderedTerm(invoiceId)).toEqual(expect.objectContaining({ netDays: 14, skontoPercent: null }));
  expect(await skontoOf(invoiceId)).toBeNull();
});

test('an invoice\'s own partial term is completed from the defaults once, at creation', async () => {
  await setSetting('crm_invoices_skonto_percent_default', 2);
  await setSetting('crm_invoices_skonto_business_days', 7);
  const quoteId = await sentQuote(await terms({ netDays: 30, skonto: 3, skontoDays: 10 }));
  // The invoice picks its own term (net days only), so the quote's is not used.
  const invoiceId = await invoiceFrom(quoteId, await terms({ netDays: 45 }));
  expect(await snapshotOf(invoiceId)).toEqual(expect.objectContaining({
    net_days: 45, skonto_percent: 2, skonto_within_days: 7, frozen: true,
  }));

  await setSetting('crm_invoices_skonto_percent_default', 6);
  expect(await renderedTerm(invoiceId)).toEqual(expect.objectContaining({ netDays: 45, skontoPercent: 2 }));
  expect(await skontoOf(invoiceId)).toBe(2);
});

test('instalments spawned without a term (the convertToEvent shape) store the quote\'s', async () => {
  const quoteId = await sentQuote(await terms({ netDays: 20, skonto: 3, skontoDays: 10 }));
  const customer = await db('customer_accounts').where({ id: customerId }).first();
  const { invoiceIds } = await db.transaction((trx) => invoiceService.spawnInstallmentInvoices({
    trx, eventId: null, quoteId, customer, currency: 'CHF', language: 'de',
    lineItems: lines.map((li) => ({ ...li, discount_percent: 0, line_total_minor: li.unit_price_minor })),
    totals: { net: 100000, vatRate: 0, vat: 0, shipping: 0, total: 100000 },
    installments: [{ percent: 50, label: 'Deposit', trigger: 'on_acceptance' }, { percent: 50, label: 'Rest', trigger: 'on_acceptance' }],
    eventDate: null, adminId, netDays: 20, dealUuid: crypto.randomUUID(),
  }));
  expect(invoiceIds).toHaveLength(2);

  await quoteService.updateQuote(quoteId, await terms({ netDays: 10, skonto: 1, skontoDays: 5 }), adminId);
  await quoteService.sendQuote(quoteId, adminId);
  for (const id of invoiceIds) {
    expect(await snapshotOf(id)).toEqual(expect.objectContaining({ net_days: 20, skonto_percent: 3, frozen: true }));
    expect(await skontoOf(id)).toBe(3);
  }
});

test('an ad-hoc invoice stores the default term, with the net days its due date used', async () => {
  await setSetting('crm_payment_default_net_days', 21);
  await setSetting('crm_invoices_skonto_percent_default', 2);
  await setSetting('crm_invoices_skonto_business_days', 7);
  const invoiceId = await invoiceFrom(null);
  expect(await snapshotOf(invoiceId)).toEqual({
    description: null, net_days: 21, skonto_percent: 2, skonto_within_days: 7, installments: null, frozen: true,
  });
});

test('a monthly draft stores the term the defaults give when it opens', async () => {
  await setSetting('crm_invoices_skonto_percent_default', 2);
  await setSetting('crm_invoices_skonto_business_days', 7);
  const monthly = await insertId('customer_accounts', {
    email: 'monthly@example.com', display_name: 'Monthly', preferred_language: 'de', is_active: 1,
    billing_cadence: 'manual', created_at: new Date().toISOString(),
  });
  const { invoiceIds } = await invoiceService.createInvoice({
    customerAccountId: monthly, currency: 'CHF', vatRate: 0, lineItems: lines,
  }, adminId);
  expect(await snapshotOf(invoiceIds[0])).toEqual(expect.objectContaining({ skonto_percent: 2, skonto_within_days: 7, frozen: true }));
});

test('an invoice without a frozen term still follows its quote and the defaults, as before', async () => {
  await setSetting('crm_invoices_skonto_percent_default', 2);
  await setSetting('crm_invoices_skonto_business_days', 7);
  const quoteId = await sentQuote(await terms({ netDays: 20, skonto: 3, skontoDays: 10 }));
  const invoiceId = await insertId('invoices', {
    invoice_number: `FREEZE-LEGACY-${quoteId}`, customer_account_id: customerId, issue_date: '2026-06-01',
    due_date: '2026-06-30', status: 'scheduled', currency: 'CHF', net_amount_minor: 10000, vat_amount_minor: 0,
    total_amount_minor: 10000, created_by_admin_id: adminId, deal_uuid: crypto.randomUUID(), source_quote_id: quoteId,
  });
  expect(await renderedTerm(invoiceId)).toEqual(expect.objectContaining({ netDays: 20, skontoPercent: 3 }));
  expect(await skontoOf(invoiceId)).toBe(3);
});

test('a reissue keeps the term of the invoice it replaces, not its quote\'s later one', async () => {
  const quoteId = await sentQuote(await terms({ netDays: 20, skonto: 3, skontoDays: 10 }));
  const invoiceId = await invoiceFrom(quoteId);
  await db('invoices').where({ id: invoiceId }).update({ status: 'cancelled' });
  await quoteService.updateQuote(quoteId, await terms({ netDays: 10, skonto: 1, skontoDays: 5 }), adminId);
  await quoteService.sendQuote(quoteId, adminId);

  const { id: reissued } = await invoiceService.reissueInvoice(invoiceId, adminId);
  expect(await snapshotOf(reissued)).toEqual(expect.objectContaining({ net_days: 20, skonto_percent: 3, frozen: true }));
});
