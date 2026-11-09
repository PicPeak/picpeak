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

describe('paths that rebuild an invoice', () => {
  beforeAll(() => setCountry('GB'));
  afterAll(() => setCustomer({ billing_cadence: 'per_event' }));

  test('a monthly customer\'s running draft rounds its VAT down too', async () => {
    await setCustomer({ billing_cadence: 'monthly' });
    const invoice = await createInvoice();
    expect(Number(invoice.vat_amount_minor)).toBe(246);
    await setCustomer({ billing_cadence: 'per_event' });
  });

  test('cancel and reissue keeps the GBP rate on the replacement', async () => {
    const invoice = await createInvoice({ currency: 'EUR', vatGbpRate: 0.87 });
    await db('invoices').where({ id: invoice.id }).update({ status: 'sent', sent_at: new Date().toISOString() });
    await invoiceService().reissueInvoice(invoice.id, adminId);
    const replacement = await db('invoices').where({ replaces_invoice_id: invoice.id }).first();
    expect(Number(replacement.vat_gbp_rate)).toBeCloseTo(0.87, 6);
    const storno = await db('invoices').where({ cancels_invoice_id: invoice.id }).first();
    expect(Number(storno.vat_gbp_rate)).toBeCloseTo(0.87, 6);
  });

  test('an invoice without VAT gets no sterling row', async () => {
    const invoice = await createInvoice({ currency: 'EUR', vatRate: 0, vatGbpRate: 0.87 });
    expect((await renderContext(invoice)).vatGbp).toBeNull();
  });
});

describe('the profile VAT-number check', () => {
  const profiles = () => require('../../src/services/businessProfileService');
  beforeAll(() => setCountry('GB'));
  afterAll(() => db('business_profile').where({ id: 1 }).update({ vat_id: null }));

  test('refuses a mistyped number', async () => {
    await expect(profiles().updateProfile({ vat_id: 'GB999999974' }, adminId))
      .rejects.toMatchObject({ code: 'INVALID_UK_VAT_NUMBER' });
  });

  test('accepts a Northern Ireland XI number', async () => {
    await expect(profiles().updateProfile({ vat_id: 'XI999999973' }, adminId)).resolves.toBeTruthy();
  });

  test('a stored number that fails the check never blocks an unrelated save', async () => {
    await db('business_profile').where({ id: 1 }).update({ vat_id: 'GB123' });
    const { profile } = await profiles().updateProfile(
      { vat_id: 'GB123', country_code: 'GB', footer_line: 'Thanks' }, adminId,
    );
    expect(profile.footer_line).toBe('Thanks');
  });
});

describe('instalments', () => {
  // A quote of 10.05 net with 2.01 VAT, split 50/50: the first slice's net is
  // 5.03, whose VAT rounded down is 1.00. A proportional share would say 1.01.
  async function spawn() {
    const customer = await db('customer_accounts').where({ id: customerId }).first();
    const { invoiceIds } = await db.transaction((trx) => invoiceService().spawnInstallmentInvoices({
      trx, customer, adminId, currency: 'GBP', language: 'en',
      lineItems: [{ position: 1, quantity: 1, description: 'Shoot', unit_price_minor: 1005, discount_percent: 0, parent_position: null }],
      totals: { net: 1005, vat: 201, shipping: 0, total: 1206, vatRate: 20 },
      installments: [{ percent: 50, trigger: 'quote_accepted', offset_days: 0 }, { percent: 50, trigger: 'quote_accepted', offset_days: 0 }],
    }));
    return db('invoices').whereIn('id', invoiceIds).orderBy('installment_index');
  }

  test('a UK business rounds each instalment\'s VAT down on its own net', async () => {
    await setCountry('GB');
    const rows = await spawn();
    expect(rows.map((r) => [Number(r.net_amount_minor), Number(r.vat_amount_minor), Number(r.total_amount_minor)]))
      .toEqual([[503, 100, 603], [502, 100, 602]]);
  });

  test('a business elsewhere keeps the proportional split', async () => {
    await setCountry('CH');
    const rows = await spawn();
    expect(rows.map((r) => Number(r.vat_amount_minor))).toEqual([101, 100]);
    await setCountry('GB');
  });
});

describe('sending a UK invoice in another currency', () => {
  beforeAll(() => setCountry('GB'));

  test('waits for the GBP rate and leaves the invoice editable', async () => {
    const invoice = await createInvoice({ currency: 'EUR' });
    await expect(invoiceService().sendInvoice(invoice.id, adminId))
      .rejects.toMatchObject({ code: 'VAT_GBP_RATE_REQUIRED' });
    expect((await db('invoices').where({ id: invoice.id }).first()).status).toBe('scheduled');
  });

  test('an invoice in GBP needs no rate', async () => {
    const invoice = await createInvoice({ currency: 'GBP' });
    const result = await invoiceService().sendInvoice(invoice.id, adminId).catch((err) => err);
    expect(result && result.code).not.toBe('VAT_GBP_RATE_REQUIRED');
  });

  test('an invoice with no VAT needs no rate (zero-rated, reverse charge, not registered)', async () => {
    const invoice = await createInvoice({ currency: 'EUR', vatRate: 0 });
    expect(Number(invoice.vat_amount_minor)).toBe(0);
    const result = await invoiceService().sendInvoice(invoice.id, adminId).catch((err) => err);
    expect(result && result.code).not.toBe('VAT_GBP_RATE_REQUIRED');
  });
});
