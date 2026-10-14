/**
 * Converting a quote or a standalone contract into a gallery, repeated or
 * twice at once.
 *
 * A quote conversion that had already committed answered 409 on a repeat:
 * the status check ran before the idempotency check, and a committed
 * conversion has already moved the quote to 'converted'. A workflow
 * recovering from a crash, or a contract whose back-pointer write was lost,
 * could not adopt the gallery. Two concurrent conversions of one quote or one
 * standalone contract both passed the reads and each created a gallery.
 */
const crypto = require('crypto');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

describe('repeated and concurrent conversions', () => {
  let db; let cleanup; let adminId; let customerId;
  let quoteService; let contractConversions;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId, customerId } = await seedMinimal(db));
    quoteService = require('../../src/services/quoteService');
    contractConversions = require('../../src/services/contract/conversions');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  async function acceptedQuote() {
    const dealUuid = crypto.randomUUID();
    const [row] = await db('quotes').insert({
      quote_number: `Q-${dealUuid.slice(0, 8)}`,
      customer_account_id: customerId,
      status: 'accepted',
      currency: 'CHF',
      issue_date: '2026-01-01',
      net_amount_minor: 100000, vat_amount_minor: 0, shipping_amount_minor: 0, total_amount_minor: 100000,
      deal_uuid: dealUuid,
      created_by_admin_id: adminId,
    }).returning('id');
    return row?.id ?? row;
  }

  async function signedContract(extra = {}) {
    const [row] = await db('contracts').insert({
      customer_account_id: customerId,
      contract_number: `C-${crypto.randomBytes(4).toString('hex')}`,
      status: 'fully_signed',
      issue_date: '2026-01-01',
      created_at: new Date().toISOString(),
      ...extra,
    }).returning('id');
    return row?.id ?? row;
  }

  const convertQuote = (id) => quoteService.convertToEvent(id, adminId, { hold: true, skipInvoices: true });
  const galleriesOfQuote = async (id) => db('events').where({ quote_id: id }).select('id');

  it('a repeat of a committed quote conversion returns its gallery instead of 409', async () => {
    const quoteId = await acceptedQuote();
    const first = await convertQuote(quoteId);
    const again = await convertQuote(quoteId);
    expect(again).toEqual({ eventId: first.eventId, alreadyConverted: true, invoiceIds: [] });
    expect(await galleriesOfQuote(quoteId)).toHaveLength(1);
  });

  it('two concurrent conversions of one quote make one gallery', async () => {
    const quoteId = await acceptedQuote();
    const settled = await Promise.allSettled([convertQuote(quoteId), convertQuote(quoteId)]);
    expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const [a, b] = settled.map((r) => r.value);
    expect(a.eventId).toBe(b.eventId);
    expect([a.alreadyConverted, b.alreadyConverted].sort()).toEqual([false, true]);
    expect(await galleriesOfQuote(quoteId)).toHaveLength(1);
    const quote = await db('quotes').where({ id: quoteId }).first();
    expect(quote.status).toBe('converted');
    expect(quote.converted_event_id).toBe(a.eventId);
  });

  it('a quote that never converted to a gallery still answers 409', async () => {
    const quoteId = await acceptedQuote();
    await db('quotes').where({ id: quoteId }).update({ status: 'converted' });
    await expect(convertQuote(quoteId)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('an invoice-only conversion that read the quote before an event conversion committed backs off', async () => {
    const quoteId = await acceptedQuote();
    // The event conversion commits between the invoice-only conversion's
    // reads and its transaction. `db` is a proxy without a set trap, so the
    // one-shot hook sits on the knex client every transaction opens through.
    // It runs before a connection is taken: SQLite has only one.
    const { client } = require('../../src/database/db').db;
    const realTransaction = client.transaction;
    let eventResult;
    client.transaction = function oneShot(...args) {
      client.transaction = realTransaction;
      return (async () => {
        eventResult = await quoteService.convertToEvent(quoteId, adminId);
        return realTransaction.apply(this, args);
      })();
    };
    try {
      await expect(quoteService.convertToInvoiceOnly(quoteId, adminId))
        .rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_CONVERTED_TO_EVENT' });
    } finally {
      client.transaction = realTransaction;
    }
    const quote = await db('quotes').where({ id: quoteId }).first();
    expect(quote.status).toBe('converted');
    expect(quote.converted_event_id).toBe(eventResult.eventId);
    const invoices = await db('invoices').where({ source_quote_id: quoteId });
    expect(invoices.map((i) => i.id).sort()).toEqual([...eventResult.invoiceIds].sort());
  });

  it('a contract whose quote already converted adopts that gallery', async () => {
    // The quote conversion committed, the contract's back-pointer write did not.
    const quoteId = await acceptedQuote();
    const contractId = await signedContract({ source_quote_id: quoteId });
    const first = await convertQuote(quoteId);
    const res = await contractConversions.convertToEvent(contractId, adminId);
    expect(res.eventId).toBe(first.eventId);
    expect((await db('contracts').where({ id: contractId }).first()).converted_event_id).toBe(first.eventId);
  });

  it('two concurrent conversions of one standalone contract make one gallery', async () => {
    const contractId = await signedContract();
    const before = (await db('events').count({ n: '*' }).first()).n;
    const settled = await Promise.allSettled([
      contractConversions.convertToEvent(contractId, adminId),
      contractConversions.convertToEvent(contractId, adminId),
    ]);
    expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const [a, b] = settled.map((r) => r.value);
    expect(a.eventId).toBe(b.eventId);
    expect([a.alreadyConverted, b.alreadyConverted].sort()).toEqual([false, true]);
    expect(Number((await db('events').count({ n: '*' }).first()).n)).toBe(Number(before) + 1);
    expect((await db('contracts').where({ id: contractId }).first()).converted_event_id).toBe(a.eventId);
    expect(await db('event_customer_assignments').where({ event_id: a.eventId })).toHaveLength(1);
  });
});
