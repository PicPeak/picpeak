/**
 * Issue 1588: a contract created from a quote kept the quote "converted"
 * forever once the contract died unsigned. createFromQuote gates purely on
 * `quotes.converted_contract_id`, and nothing cleared that back-pointer
 * when the contract it named was cancelled — so a second createFromQuote
 * call just handed back the dead contract (`alreadyConverted: true`)
 * instead of making a replacement.
 *
 * Stable twin: signatures v2 (#1446, which adds a customer 'declined'
 * status) hasn't landed on this branch, so a contract here can only die
 * unsigned via 'cancelled' (backend/src/services/contract/crud.js). See
 * QUOTE_RELEASING_CONTRACT_STATUSES in
 * backend/src/services/contract/helpers.js for where to add 'declined'
 * once signatures v2 backports.
 */

const crypto = require('crypto');
const {
  bootCrmDb, seedMinimal, assignAdminRole,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

describe('quote release on dead contract (issue 1588)', () => {
  let db;
  let cleanup;
  let adminId;
  let customerId;
  let contractService;
  let releaseQuoteOnDeadContract;

  const mkQuote = async () => {
    const inserted = await db('quotes').insert({
      quote_number: `Q-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      customer_account_id: customerId,
      deal_uuid: crypto.randomUUID(),
      status: 'accepted',
      currency: 'EUR',
      issue_date: '2026-08-01',
      total_amount_minor: 1000,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id');
    return inserted[0]?.id ?? inserted[0];
  };

  const converted = (quoteId) => db('quotes').where({ id: quoteId }).first('converted_contract_id');

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId, customerId } = await seedMinimal(db));
    await assignAdminRole(db, adminId, 'super_admin');
    contractService = require('../../src/services/contractService');
    ({ releaseQuoteOnDeadContract } = require('../../src/services/contract/helpers'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('cancelling the contract releases the quote so a replacement can be created', async () => {
    const quoteId = await mkQuote();
    const first = await contractService.createFromQuote(quoteId, adminId);
    expect(first.alreadyConverted).toBe(false);

    // While the contract is alive, a second call is idempotent (existing
    // behaviour — unchanged by this fix).
    const stillAlive = await contractService.createFromQuote(quoteId, adminId);
    expect(stillAlive).toEqual({ contractId: first.contractId, alreadyConverted: true });

    await contractService.cancelContract(first.contractId, adminId);

    const afterCancel = await converted(quoteId);
    expect(afterCancel.converted_contract_id).toBeNull();
    expect((await db('contracts').where({ id: first.contractId }).first('source_quote_id')).source_quote_id)
      .toBe(quoteId); // lineage pointer is untouched

    const second = await contractService.createFromQuote(quoteId, adminId);
    expect(second.alreadyConverted).toBe(false);
    expect(second.contractId).not.toBe(first.contractId);

    const afterRecreate = await converted(quoteId);
    expect(Number(afterRecreate.converted_contract_id)).toBe(Number(second.contractId));
  });

  it('the release query only clears the pointer when it still names THIS contract (race guard)', async () => {
    const quoteA = await mkQuote();
    const quoteB = await mkQuote();
    const a = await contractService.createFromQuote(quoteA, adminId);
    const b = await contractService.createFromQuote(quoteB, adminId);

    // A stale/foreign contract id trying to release quote B's pointer must
    // be a no-op — this is the exact query shape cancelContract runs
    // inside its transaction.
    await db.transaction(async (trx) => {
      await releaseQuoteOnDeadContract(trx, a.contractId, quoteB);
    });
    const rowBUnchanged = await converted(quoteB);
    expect(Number(rowBUnchanged.converted_contract_id)).toBe(Number(b.contractId));

    // The real cancel path only ever releases the quote it names — a
    // different quote pointing at a different contract stays untouched.
    await contractService.cancelContract(a.contractId, adminId);
    const rowA = await converted(quoteA);
    const rowB = await converted(quoteB);
    expect(rowA.converted_contract_id).toBeNull();
    expect(Number(rowB.converted_contract_id)).toBe(Number(b.contractId));
  });
});
