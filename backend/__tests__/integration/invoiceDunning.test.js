/**
 * Dunning / Mahngebühr logic — the tax-sensitive bits added in the dunning
 * rework. Covers the fee math (flat / percent), the VAT toggle gating
 * (incl. the "no-op when the org has no VAT rate" requirement), per-reminder
 * accumulation (2nd = 1×, 3rd = 2×), invoice immutability (the fee never
 * changes the issued invoice total), and the 3-reminder cap.
 *
 * The Mahnung PDF render is stubbed — PDF rendering (fonts) is flaky in CI and
 * is verified manually; here we assert the data/immutability behaviour.
 */
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

// bootCrmDb runs the full core-migration set in beforeAll; under full-suite
// parallel load on a small CI runner that can exceed the 5s default. Match the
// other migration-heavy CRM suites (discountLineItems, incomingInvoiceRebill).
jest.setTimeout(30000);

let db;
let cleanup;
let invoiceService;
let ids;

async function setSetting(key, value) {
  const { upsertAppSetting } = require('../../src/utils/appSettings');
  await upsertAppSetting(key, JSON.stringify(value), 'crm');
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ids = await seedMinimal(db);
  try { await db('customer_accounts').where({ id: ids.customerId }).update({ feature_bills: true }); } catch (_) {}
  invoiceService = require('../../src/services/invoiceService');
  // Stub the (flaky) PDF render so applyReminder exercises its data path.
  // eslint-disable-next-line global-require
  const pdfService = require('../../src/services/pdfService');
  pdfService.renderInvoiceToBuffer = async () => Buffer.from('%PDF-stub');
});

afterAll(async () => { await cleanup(); });

describe('dunning fee resolvers', () => {
  test('flat fee, no VAT', async () => {
    await setSetting('crm_invoices_late_fee_enabled', true);
    await setSetting('crm_invoices_late_fee_type', 'flat');
    await setSetting('crm_invoices_late_fee_minor', 2000);
    await setSetting('crm_invoices_late_fee_vat_enabled', false);
    const inv = { total_amount_minor: 100000 };
    expect(await invoiceService.resolveLateFeeNetMinor(inv)).toBe(2000);
    expect(await invoiceService.resolveLateFeeVatRate()).toBe(0);
    expect(await invoiceService.resolvePerReminderFeeMinor(inv)).toBe(2000);
  });

  test('percent fee = % of the invoice gross', async () => {
    await setSetting('crm_invoices_late_fee_type', 'percent');
    await setSetting('crm_invoices_late_fee_percent', 5);
    expect(await invoiceService.resolveLateFeeNetMinor({ total_amount_minor: 100000 })).toBe(5000);
  });

  test('VAT toggle applies the org rate, but is a NO-OP when the org has no VAT rate', async () => {
    await setSetting('crm_invoices_late_fee_type', 'flat');
    await setSetting('crm_invoices_late_fee_minor', 2000);
    await setSetting('crm_invoices_late_fee_vat_enabled', true);

    await db('business_profile').where({ id: 1 }).update({ vat_rate_default: 8.1 });
    expect(await invoiceService.resolveLateFeeVatRate()).toBeCloseTo(8.1);
    expect(await invoiceService.resolvePerReminderFeeMinor({ total_amount_minor: 0 }))
      .toBe(2000 + Math.round(2000 * 8.1 / 100)); // net + VAT

    // Org doesn't charge VAT → toggle adds nothing (Mara's requirement).
    await db('business_profile').where({ id: 1 }).update({ vat_rate_default: 0 });
    expect(await invoiceService.resolveLateFeeVatRate()).toBe(0);
    expect(await invoiceService.resolvePerReminderFeeMinor({ total_amount_minor: 0 })).toBe(2000);
  });
});

describe('applyReminder — dunning-document model', () => {
  let invoiceId;
  let originalTotal;

  beforeAll(async () => {
    await setSetting('crm_invoices_late_fee_enabled', true);
    await setSetting('crm_invoices_late_fee_type', 'flat');
    await setSetting('crm_invoices_late_fee_minor', 2000);
    await setSetting('crm_invoices_late_fee_vat_enabled', false);
    const res = await invoiceService.createInvoice({
      customerAccountId: ids.customerId,
      currency: 'CHF',
      vatRate: 0,
      lineItems: [{ description: 'Service', quantity: 1, unit_price_minor: 100000 }],
    }, ids.adminId);
    invoiceId = res.invoiceIds[0];
    originalTotal = Number((await db('invoices').where({ id: invoiceId }).first()).total_amount_minor);
  });

  test('level 2 tracks one fee and leaves the invoice total immutable', async () => {
    const data = await invoiceService.getInvoiceById(invoiceId);
    await invoiceService.applyReminder(data.invoice, data.lineItems, 2, ids.adminId);
    const inv = await db('invoices').where({ id: invoiceId }).first();
    expect(inv.reminder_level).toBe(2);
    expect(Number(inv.late_fee_amount_minor)).toBe(2000);
    expect(Number(inv.total_amount_minor)).toBe(originalTotal); // never mutated
  });

  test('level 3 accumulates the fee to 2×, total still immutable', async () => {
    const data = await invoiceService.getInvoiceById(invoiceId);
    await invoiceService.applyReminder(data.invoice, data.lineItems, 3, ids.adminId);
    const inv = await db('invoices').where({ id: invoiceId }).first();
    expect(Number(inv.late_fee_amount_minor)).toBe(4000);
    expect(Number(inv.total_amount_minor)).toBe(originalTotal);
  });

  test('sendReminder refuses to exceed level 3', async () => {
    await expect(invoiceService.sendReminder(invoiceId, 4, ids.adminId)).rejects.toThrow();
  });
});
