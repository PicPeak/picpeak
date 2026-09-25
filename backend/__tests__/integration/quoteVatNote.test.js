/**
 * The VAT note belongs to invoices.
 *
 * A business that isn't VAT-registered sets a free-text note
 * (`crm_invoices_vat_note_text`, e.g. "Von der MWST-Pflicht befreit gemäss
 * Art. 10 Abs. 2 MWSTG.") and the invoice renderer prints it under the MwSt.
 * line — or in place of that line when the document carries no VAT.
 *
 * Quotes used to print it too. That reads as though the offer were the tax
 * document: MWSTG Art. 10 Abs. 2 is something a bill declares about itself,
 * and the setting is scoped to invoices by name. A quote from an exempt
 * business simply shows no MwSt. row.
 */

const crypto = require('crypto');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

const NOTE = 'Von der MWST-Pflicht befreit gemäss Art. 10 Abs. 2 MWSTG.';

describe('the VAT note is an invoice statement', () => {
  let db; let cleanup; let adminId; let customerId; let quoteService; let invoiceRender;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId, customerId } = await seedMinimal(db));

    // An exempt business with the note configured — the shape that produced
    // the note on quotes.
    const put = async (key, value) => {
      await db('app_settings').where({ setting_key: key }).del();
      await db('app_settings').insert({ setting_key: key, setting_value: JSON.stringify(value) });
    };
    await put('accounting_vat_registered', false);
    await put('crm_invoices_vat_note_text', NOTE);

    quoteService = require('../../src/services/quoteService');
    invoiceRender = require('../../src/services/invoice/render');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  async function quoteWithoutVat(status = 'draft') {
    const dealUuid = crypto.randomUUID();
    const [id] = await db('quotes').insert({
      quote_number: `Q-${dealUuid.slice(0, 8)}`,
      customer_account_id: customerId,
      status,
      currency: 'CHF',
      issue_date: '2026-01-01',
      net_amount_minor: 100000,
      vat_amount_minor: 0,
      shipping_amount_minor: 0,
      total_amount_minor: 100000,
      deal_uuid: dealUuid,
      created_by_admin_id: adminId,
    });
    await db('quote_line_items').insert({
      quote_id: id,
      position: 1,
      description: 'Fotografie',
      quantity: 1,
      unit_price_minor: 100000,
      discount_percent: 0,
      line_total_minor: 100000,
    });
    return db('quotes').where({ id }).first();
  }

  it('a quote carries no VAT note, even when the business is exempt', async () => {
    const quote = await quoteWithoutVat();
    const lineItems = await db('quote_line_items').where({ quote_id: quote.id }).orderBy('position');
    const ctx = await quoteService._internal.buildRenderContext(quote, lineItems);

    // The exemption still hides the MwSt. row — vatRegistered drives that —
    // but nothing is printed in its place.
    expect(ctx.vatRegistered).toBe(false);
    expect(ctx.vatNote == null).toBe(true);
  });

  it('an invoice from the same business still carries it', async () => {
    const quote = await quoteWithoutVat('accepted');
    const { invoiceIds } = await quoteService.convertToInvoiceOnly(quote.id, adminId, { draft: true });
    const invoice = await db('invoices').where({ id: invoiceIds[0] }).first();
    const lineItems = await db('invoice_line_items').where({ invoice_id: invoice.id }).orderBy('position');
    const ctx = await invoiceRender.buildInvoiceRenderContext(invoice, lineItems);

    expect(ctx.vatRegistered).toBe(false);
    expect(ctx.vatNote).toBe(NOTE);
  });
});
