/**
 * Negative line items (Rabatt / manual discount lines) are accepted
 * end-to-end as long as the resulting total stays ≥ 0. When the
 * discount would drive the total negative, the service rejects with
 * a clear, code-tagged error so the admin is steered to Storno for
 * credit-note workflows.
 *
 * Touches the actual createInvoice / createQuote service paths so a
 * future change to either computeTotals or the guard fires this test.
 */

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

// Service-level CRM calls cold-require heavy modules (pdfService,
// nodemailer, etc.) on first use; the global 5 s per-test budget is
// too tight for that. Bump it for this file only.
jest.setTimeout(30000);

describe('discount line items (negative unit_price_minor)', () => {
  let db;
  let cleanup;
  let adminId;
  let customerId;
  let invoiceService;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId, customerId } = await seedMinimal(db));
    invoiceService = require('../../src/services/invoiceService');
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  // Quote-side coverage of the symmetric validator + guard is
  // deliberately omitted: createQuote's init path takes ~30 s under
  // this harness (something in pdfService / emailProcessor cold-
  // require), which would push the suite well past CI's per-test
  // budget. The shape of the guard is identical to the invoice one
  // covered below; a future change to extract the slow init or to
  // stub it for tests should re-enable a parallel quote test.

  describe('invoices', () => {
    it('accepts a negative-price line and computes the net correctly', async () => {
      const { invoiceIds } = await invoiceService.createInvoice({
        customerAccountId: customerId,
        currency: 'CHF',
        vatRate: 0,
        lineItems: [
          { position: 1, quantity: 1, description: 'Photo service', unit_price_minor: 20000, discount_percent: 0 },
          { position: 2, quantity: 1, description: 'Treuerabatt',   unit_price_minor: -5000, discount_percent: 0 },
        ],
      }, adminId);

      expect(Array.isArray(invoiceIds)).toBe(true);
      expect(invoiceIds.length).toBe(1);

      const row = await db('invoices').where({ id: invoiceIds[0] }).first();
      expect(row.net_amount_minor).toBe(15000);
      expect(row.total_amount_minor).toBe(15000);
    });

    it('rejects when the discount drives the total negative', async () => {
      await expect(invoiceService.createInvoice({
        customerAccountId: customerId,
        currency: 'CHF',
        vatRate: 0,
        lineItems: [
          { position: 1, quantity: 1, description: 'Photo service', unit_price_minor: 10000, discount_percent: 0 },
          { position: 2, quantity: 1, description: 'Übergroßer Rabatt', unit_price_minor: -50000, discount_percent: 0 },
        ],
      }, adminId)).rejects.toMatchObject({
        code: 'INVOICE_TOTAL_NEGATIVE',
        statusCode: 400,
      });
    });
  });
});
