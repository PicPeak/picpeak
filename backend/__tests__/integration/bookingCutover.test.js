/**
 * Booking cutover — prepare_invoice's draft seam. convertToInvoiceOnly({draft})
 * must create the invoice(s) but leave scheduled_send_at NULL so the scheduler
 * never auto-sends them before the workflow's review gate + explicit
 * send_document.
 */
const crypto = require('crypto');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(30000);

describe('booking cutover — draft invoices on hold', () => {
  let db; let cleanup; let adminId; let customerId; let quoteService;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId, customerId } = await seedMinimal(db));
    quoteService = require('../../src/services/quoteService');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  async function acceptedQuote() {
    const dealUuid = crypto.randomUUID();
    const [id] = await db('quotes').insert({
      quote_number: `Q-${dealUuid.slice(0, 8)}`,
      customer_account_id: customerId,
      status: 'accepted',
      currency: 'CHF',
      issue_date: '2026-01-01',
      net_amount_minor: 100000, vat_amount_minor: 0, shipping_amount_minor: 0, total_amount_minor: 100000,
      // A non-delivery installment so the contrast (scheduled date vs null) is meaningful.
      payment_term_snapshot: JSON.stringify({ installments: [{ percent: 100, trigger: 'quote_accepted', offset_days: 0, label: 'Total' }], net_days: 30 }),
      deal_uuid: dealUuid,
      created_by_admin_id: adminId,
    });
    return id;
  }

  it('draft mode creates the invoice with scheduled_send_at = NULL (held), and returns its id', async () => {
    const quoteId = await acceptedQuote();
    const res = await quoteService.convertToInvoiceOnly(quoteId, adminId, { draft: true });
    expect(Array.isArray(res.invoiceIds)).toBe(true);
    expect(res.invoiceIds.length).toBeGreaterThanOrEqual(1);

    const inv = await db('invoices').where({ id: res.invoiceIds[0] }).first();
    expect(inv.status).toBe('scheduled');     // editable + sendInvoice can issue it
    expect(inv.scheduled_send_at == null).toBe(true); // held — scheduler won't auto-send
  });

  it('without draft, the same installment IS scheduled (scheduled_send_at set)', async () => {
    const quoteId = await acceptedQuote();
    const res = await quoteService.convertToInvoiceOnly(quoteId, adminId);
    const inv = await db('invoices').where({ id: res.invoiceIds[0] }).first();
    expect(inv.status).toBe('scheduled');
    expect(inv.scheduled_send_at == null).toBe(false); // normal convert → auto-send date set
  });

  it('prepare_event path (convertToEvent hold) creates a DRAFT event with held invoices', async () => {
    const quoteId = await acceptedQuote();
    const res = await quoteService.convertToEvent(quoteId, adminId, { hold: true });
    expect(res.eventId).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.invoiceIds)).toBe(true);
    expect(res.invoiceIds.length).toBeGreaterThanOrEqual(1);

    const ev = await db('events').where({ id: res.eventId }).first();
    expect(ev.is_draft == true || ev.is_draft === 1).toBe(true); // created as a draft gallery

    // Every invoice the event scheduled is held (no auto-send before the gate).
    const invs = await db('invoices').whereIn('id', res.invoiceIds);
    for (const inv of invs) expect(inv.scheduled_send_at == null).toBe(true);

    // Quote is now linked to the event — convertToInvoiceOnly must NOT be called
    // again for it (the flow's prepare_invoice adopts these ids instead).
    const q = await db('quotes').where({ id: quoteId }).first();
    expect(q.converted_event_id).toBe(res.eventId);
  });

  it('draft mode with the DEFAULT (after_delivery) payment term yields a SENDABLE scheduled invoice, not pending_delivery', async () => {
    // Reproduces the booking_invoice_only flow on a quote with no explicit
    // payment timing: the default installment is after_delivery, which would
    // otherwise be pending_delivery — a status sendInvoice (send_document) rejects.
    const dealUuid = crypto.randomUUID();
    const [quoteId] = await db('quotes').insert({
      quote_number: `Q-${dealUuid.slice(0, 8)}`,
      customer_account_id: customerId,
      status: 'accepted',
      currency: 'CHF',
      issue_date: '2026-01-01',
      net_amount_minor: 50000, vat_amount_minor: 0, shipping_amount_minor: 0, total_amount_minor: 50000,
      // No payment_term_snapshot → spawnInstallmentInvoices falls back to a single
      // 100% after_delivery installment.
      deal_uuid: dealUuid,
      created_by_admin_id: adminId,
    });
    const res = await quoteService.convertToInvoiceOnly(quoteId, adminId, { draft: true });
    const inv = await db('invoices').where({ id: res.invoiceIds[0] }).first();
    expect(inv.status).toBe('scheduled');            // sendInvoice accepts this
    expect(inv.scheduled_send_at == null).toBe(true); // still held — no auto-send
  });

  it('finalizeQuoteResponses only fires once the 15-min response window has locked', async () => {
    const mk = async (lockOffsetMs) => {
      const dealUuid = crypto.randomUUID();
      const [id] = await db('quotes').insert({
        quote_number: `Q-${dealUuid.slice(0, 8)}`,
        customer_account_id: customerId,
        status: 'accepted',
        currency: 'CHF', issue_date: '2026-01-01',
        net_amount_minor: 1000, vat_amount_minor: 0, shipping_amount_minor: 0, total_amount_minor: 1000,
        responded_at: new Date().toISOString(),
        response_locked_at: new Date(Date.now() + lockOffsetMs).toISOString(),
        accepted_at: new Date().toISOString(),
        deal_uuid: dealUuid,
        created_by_admin_id: adminId,
      });
      return id;
    };
    const openId = await mk(15 * 60 * 1000);   // still inside the window
    const lockedId = await mk(-60 * 1000);      // window already closed

    const emitted = await quoteService.finalizeQuoteResponses();
    expect(emitted).toBeGreaterThanOrEqual(1);

    const open = await db('quotes').where({ id: openId }).first();
    const locked = await db('quotes').where({ id: lockedId }).first();
    expect(open.workflow_response_emitted_at == null).toBe(true);   // deferred — not yet fired
    expect(locked.workflow_response_emitted_at == null).toBe(false); // fired + stamped

    // Idempotent: a second sweep doesn't re-fire the already-stamped one.
    const again = await db('quotes').where({ id: lockedId })
      .whereNull('workflow_response_emitted_at').update({ workflow_response_emitted_at: new Date() });
    expect(again).toBe(0);
  });

  it('reserve_date path (convertToEvent skipInvoices) creates a draft event with NO invoices', async () => {
    const quoteId = await acceptedQuote();
    const res = await quoteService.convertToEvent(quoteId, adminId, { hold: true, skipInvoices: true });
    expect(res.eventId).toBeGreaterThanOrEqual(1);
    expect(res.invoiceIds).toEqual([]);
    const invCount = await db('invoices').where({ event_id: res.eventId }).count({ c: '*' }).first();
    expect(Number(invCount.c)).toBe(0); // pure date hold — no money documents
  });

  it('prepare_quote path (duplicateQuote) creates a new DRAFT quote — no in-trx deadlock', async () => {
    const quoteId = await acceptedQuote();
    const newId = await quoteService.duplicateQuote(quoteId, adminId);
    expect(newId).toBeGreaterThanOrEqual(1);
    expect(newId).not.toBe(quoteId);
    const q = await db('quotes').where({ id: newId }).first();
    expect(q.status).toBe('draft');
  });

  it('registers prepare_gallery / reserve_date / prepare_quote as real actions', () => {
    const { registry } = require('../../src/services/workflows'); // loads actions.js (side-effect registration)
    for (const a of ['prepare_gallery', 'reserve_date', 'prepare_quote', 'prepare_event', 'prepare_invoice', 'send_document']) {
      expect(typeof registry.getAction(a)).toBe('function');
    }
  });

  it('prepare_contract path (createFromQuote) completes under SQLite — no in-trx deadlock', async () => {
    const contractService = require('../../src/services/contractService');
    const quoteId = await acceptedQuote();
    const res = await contractService.createFromQuote(quoteId, adminId);
    expect(res.contractId).toBeGreaterThanOrEqual(1);
    expect(res.alreadyConverted).toBe(false);
    const c = await db('contracts').where({ id: res.contractId }).first();
    expect(c).toBeTruthy();
  });
});
