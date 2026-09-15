/**
 * The signing event log (#1446): events chain by hash; the chain verifies,
 * and a changed, removed or reordered event is found at the right place.
 */

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let contractId;
let events;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const { customerId } = await seedMinimal(db);
  const inserted = await db('contracts').insert({
    contract_number: 'C-2026-9001', customer_account_id: customerId, status: 'sent', language: 'de',
    issue_date: '2026-09-14', created_at: new Date(), updated_at: new Date(),
  }).returning('id');
  contractId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  events = require('../../src/services/contract/signingEvents');
}, 120000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

test('events chain by hash and the chain verifies', async () => {
  const first = await events.appendEvent(db, contractId, { type: 'sent', actorType: 'admin', actorLabel: 'tester', artifactSha256: 'a'.repeat(64) });
  const second = await events.appendEvent(db, contractId, { type: 'verified', actorType: 'signer', signerId: 7, payload: { via: 'otp' } });
  await db.transaction((trx) => events.appendEvent(trx, contractId, { type: 'signed', actorType: 'signer', signerId: 7, payload: { mode: 'drawn' } }));

  expect(first.prevHash).toBe(events.GENESIS);
  expect(second.prevHash).toBe(first.eventHash);
  const result = await events.verifyChain(contractId);
  expect(result).toEqual(expect.objectContaining({ ok: true, count: 3 }));
  const contract = await db('contracts').where({ id: contractId }).first();
  expect(contract.audit_chain_head).toBe(result.head);
  expect((await events.listEvents(contractId)).map((e) => e.type)).toEqual(['sent', 'verified', 'signed']);
});

test('a changed event breaks the chain at that event', async () => {
  const row = await db('contract_signing_events').where({ contract_id: contractId, seq: 2 }).first();
  await db('contract_signing_events').where({ id: row.id }).update({ payload: '{"via":"portal"}' });
  expect(await events.verifyChain(contractId)).toEqual(expect.objectContaining({ ok: false, brokenAt: 2, reason: 'altered_event' }));
  await db('contract_signing_events').where({ id: row.id }).update({ payload: row.payload });
  expect((await events.verifyChain(contractId)).ok).toBe(true);
});

test('a removed event is found', async () => {
  const row = await db('contract_signing_events').where({ contract_id: contractId, seq: 2 }).first();
  await db('contract_signing_events').where({ id: row.id }).del();
  expect(await events.verifyChain(contractId)).toEqual(expect.objectContaining({ ok: false, brokenAt: 2, reason: 'missing_event' }));
  await db('contract_signing_events').insert(row);
  expect((await events.verifyChain(contractId)).ok).toBe(true);
});

test('a head that no longer matches the log is reported', async () => {
  await db('contracts').where({ id: contractId }).update({ audit_chain_head: 'f'.repeat(64) });
  expect(await events.verifyChain(contractId)).toEqual(expect.objectContaining({ ok: false, reason: 'head_mismatch' }));
});
