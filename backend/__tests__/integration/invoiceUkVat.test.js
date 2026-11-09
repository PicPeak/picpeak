/**
 * Invoices and quotes of a business in the United Kingdom (issue 2439).
 *
 * The VAT total is rounded DOWN to the penny (VAT Notice 700 s.17.5), on
 * the stored invoice and quote alike; everyone else keeps rounding to the
 * nearest cent. A UK invoice in another currency keeps the GBP rate its VAT is
 * stated at, and the B2B late-payment notice goes only to business customers.
 */

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
const prevCwd = process.cwd();

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  ({ adminId, customerId } = await seedMinimal(db));
});

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

const invoiceService = () => require('../../src/services/invoiceService');
const setCountry = (countryCode) => db('business_profile').where({ id: 1 }).update({ country_code: countryCode });
const setCustomer = (fields) => db('customer_accounts').where({ id: customerId }).update(fields);

async function setSetting(key, value) {
  const row = await db('app_settings').where({ setting_key: key }).first();
  if (row) await db('app_settings').where({ setting_key: key }).update({ setting_value: JSON.stringify(value) });
  else await db('app_settings').insert({ setting_key: key, setting_value: JSON.stringify(value), setting_type: 'crm' });
}

// 1234 × 20 % = 246.8 pence: nearest rounds up, a UK business rounds down.
async function createInvoice(extra = {}) {
  const { invoiceIds } = await invoiceService().createInvoice({
    customerAccountId: customerId, currency: 'GBP', vatRate: 20,
    lineItems: [{ position: 1, quantity: 1, description: 'Edit', unit_price_minor: 1234, discount_percent: 0 }],
    ...extra,
  }, adminId);
  return db('invoices').where({ id: invoiceIds[0] }).first();
}

async function renderContext(invoice) {
  const lineItems = await db('invoice_line_items').where({ invoice_id: invoice.id });
  return require('../../src/services/invoice/render').buildInvoiceRenderContext(invoice, lineItems);
}

describe('VAT rounding', () => {
  test('a business elsewhere rounds the VAT total to the nearest cent', async () => {
    await setCountry('CH');
    const invoice = await createInvoice({ currency: 'CHF' });
    expect(Number(invoice.vat_amount_minor)).toBe(247);
  });

  test('a UK business rounds it down to the penny', async () => {
    await setCountry('GB');
    const invoice = await createInvoice();
    expect(Number(invoice.vat_amount_minor)).toBe(246);
    expect(Number(invoice.total_amount_minor)).toBe(1234 + 246);
  });

  test('a UK quote rounds it down too', async () => {
    await setCountry('GB');
    const quotes = require('../../src/services/quoteService');
    const created = await quotes.createQuote({
      customerAccountId: customerId, language: 'en', currency: 'GBP', vatRate: 20,
      lineItems: [{ position: 1, description: 'Edit', quantity: 1, unit_price_minor: 1234, discount_percent: 0 }],
    }, adminId);
    const quote = await db('quotes').where({ id: created.id || created }).first();
    expect(Number(quote.vat_amount_minor)).toBe(246);
  });
});

describe('VAT in sterling', () => {
  beforeAll(() => setCountry('GB'));

  test('a UK invoice in euros keeps its GBP rate and states its VAT in pence', async () => {
    const invoice = await createInvoice({ currency: 'EUR', vatGbpRate: '0.87' });
    expect(Number(invoice.vat_gbp_rate)).toBeCloseTo(0.87, 6);
    const ctx = await renderContext(invoice);
    // 246 cents of VAT at 0.87 = 214.02 pence, rounded down.
    expect(ctx.vatGbp).toEqual({ amountMinor: 214, rate: 0.87 });
  });

  test('an invoice in sterling keeps no rate', async () => {
    const invoice = await createInvoice({ currency: 'GBP', vatGbpRate: 0.87 });
    expect(invoice.vat_gbp_rate).toBeNull();
    expect((await renderContext(invoice)).vatGbp).toBeNull();
  });

  test('a business elsewhere keeps no rate', async () => {
    await setCountry('CH');
    const invoice = await createInvoice({ currency: 'EUR', vatGbpRate: 0.87 });
    expect(invoice.vat_gbp_rate).toBeNull();
    await setCountry('GB');
  });
});

describe('the late-payment notice', () => {
  beforeAll(async () => {
    await setCountry('GB');
    await setSetting('crm_invoices_late_payment_notice', true);
  });
  afterAll(() => setCustomer({ company_name: null, vat_id: null, customer_kind: null }));

  test('goes to a business customer, with the fixed sum for the debt', async () => {
    await setCustomer({ company_name: 'Band Ltd', customer_kind: null });
    const ctx = await renderContext(await createInvoice());
    expect(ctx.latePayment).toEqual({ compensationPounds: 40 });
  });

  test('stays off a consumer\'s invoice', async () => {
    await setCustomer({ company_name: null, vat_id: null, customer_kind: null });
    expect((await renderContext(await createInvoice())).latePayment).toBeNull();
  });

  test('follows the explicit kind', async () => {
    await setCustomer({ company_name: null, vat_id: null, customer_kind: 'business' });
    expect((await renderContext(await createInvoice())).latePayment).not.toBeNull();
  });

  test('stays off while the setting is off', async () => {
    await setSetting('crm_invoices_late_payment_notice', false);
    await setCustomer({ company_name: 'Band Ltd', customer_kind: null });
    expect((await renderContext(await createInvoice())).latePayment).toBeNull();
    await setSetting('crm_invoices_late_payment_notice', true);
  });
});
