/**
 * Issue 1588: a contract created from a quote kept the quote "converted"
 * forever once the contract died unsigned. createFromQuote gates purely on
 * `quotes.converted_contract_id`, and nothing cleared that back-pointer
 * when the contract it named was cancelled or declined — so a second
 * createFromQuote call just handed back the dead contract
 * (`alreadyConverted: true`) instead of making a replacement.
 *
 * Scoped to the statuses main can actually produce today: 'cancelled'
 * (admin cancel, backend/src/services/contract/crud.js) and 'declined'
 * (customer decline via signatures v2,
 * backend/src/services/contract/signingV2.js). PR 1577 will add an
 * 'expired' status later — see the TODO next to
 * QUOTE_RELEASING_CONTRACT_STATUSES in
 * backend/src/services/contract/helpers.js for where to extend this.
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
  let signers;
  let signingV2;
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
    signers = require('../../src/services/contract/signers');
    signingV2 = require('../../src/services/contract/signingV2');
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

  it('declining the contract (signing v2) releases the quote the same way', async () => {
    const quoteId = await mkQuote();
    const { contractId } = await contractService.createFromQuote(quoteId, adminId);
    await contractService.sendContract(contractId, adminId);

    const rows = await signers.listSigners(contractId);
    const customerSigner = rows.find((s) => s.role === 'customer');
    expect(customerSigner).toBeTruthy();
    const { token } = await signers.createSession(customerSigner.id, 'otp');

    const result = await signingV2.decline(token, { reason: 'schedule conflict' });
    expect(result.status).toBe('declined');
    expect((await db('contracts').where({ id: contractId }).first('status')).status).toBe('declined');

    const afterDecline = await converted(quoteId);
    expect(afterDecline.converted_contract_id).toBeNull();

    const replacement = await contractService.createFromQuote(quoteId, adminId);
    expect(replacement.alreadyConverted).toBe(false);
    expect(replacement.contractId).not.toBe(contractId);
  });

  it('the release query only clears the pointer when it still names THIS contract (race guard)', async () => {
    const quoteA = await mkQuote();
    const quoteB = await mkQuote();
    const a = await contractService.createFromQuote(quoteA, adminId);
    const b = await contractService.createFromQuote(quoteB, adminId);

    // A stale/foreign contract id trying to release quote B's pointer must
    // be a no-op — this is the exact query shape cancelContract/decline run
    // inside their transaction.
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
