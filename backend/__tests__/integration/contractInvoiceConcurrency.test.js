/**
 * A contract is claimed once before it becomes an invoice.
 *
 * convertToInvoiceOnly() used to check contract.status === 'fully_signed'
 * and then insert the invoice with nothing in between stopping a second
 * concurrent caller that read the same status. Two replicas, or a double
 * click on "Convert to invoice", could both pass the check and both
 * insert — two invoices for one contract (#1589). The fix is a
 * compare-and-set claim on contracts.invoice_prepared_at (migration 231):
 * only one concurrent caller's UPDATE affects a row, so only one caller
 * proceeds to insert.
 *
 * Runs against SQLite by default. Set PICPEAK_PG_TEST_URL to also run it
 * against Postgres (same pattern as contractInvoiceAtomic.test.js) — CI /
 * a manual run with that env var is how the Postgres path gets covered;
 * this repo's default local `npm test` only exercises SQLite.
 */
const knex = require('knex');
const { randomUUID } = require('crypto');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

const pgUrl = process.env.PICPEAK_PG_TEST_URL;
let db; let cleanup; let adminId; let customerId; let owner; let schema; let service;

beforeAll(async () => {
  if (pgUrl) {
    schema = `contract_invoice_race_${randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    process.env.DATABASE_CLIENT = 'pg';
    jest.doMock('../../knexfile', () => ({ client: 'pg', connection: pgUrl, searchPath: [schema] }));
  }
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId, customerId } = await seedMinimal(db));
  service = require('../../src/services/contract/conversions');
});

afterAll(async () => {
  if (cleanup) await cleanup();
  if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
});

async function makeFullySignedContract(number) {
  const [contract] = await db('contracts').insert({
    contract_number: number, customer_account_id: customerId,
    issue_date: '2026-09-16', status: 'fully_signed', title: 'Race contract', created_by_admin_id: adminId,
  }).returning('id');
  return contract.id ?? contract;
}

test('two concurrent conversions of the same standalone contract create exactly one invoice', async () => {
  const contractId = await makeFullySignedContract('TEST-RACE-1');

  const settled = await Promise.allSettled([
    service.convertToInvoiceOnly(contractId, adminId),
    service.convertToInvoiceOnly(contractId, adminId),
  ]);

  const invoices = await db('invoices').where({ source_contract_id: contractId });
  expect(invoices).toHaveLength(1);

  const fulfilled = settled.filter((r) => r.status === 'fulfilled');
  const rejected = settled.filter((r) => r.status === 'rejected');
  // At least one caller must have won the claim and created the invoice.
  expect(fulfilled.length).toBeGreaterThanOrEqual(1);
  for (const r of fulfilled) expect(r.value.invoiceId).toBe(invoices[0].id);
  // The loser either adopted the winner's invoice (alreadyConverted) or, if
  // it lost the claim before the winner's insert had committed, got a
  // retryable 409 rather than creating a second invoice.
  for (const r of rejected) expect(r.reason.code).toBe('INVOICE_CONVERSION_IN_PROGRESS');

  // A retry after the race has settled always recovers the same invoice —
  // never a second one — whichever way the race went.
  const retry = await service.convertToInvoiceOnly(contractId, adminId);
  expect(retry.invoiceId).toBe(invoices[0].id);
  expect(await db('invoices').where({ source_contract_id: contractId })).toHaveLength(1);
});

test('a claim released after a failed insert lets an immediate retry succeed once', async () => {
  const contractId = await makeFullySignedContract('TEST-RACE-2');

  const prototype = Object.getPrototypeOf(db.client);
  const original = prototype._query;
  const spy = jest.spyOn(prototype, '_query').mockImplementation(function (connection, query) {
    if (/^insert into ["`]invoices["`]/i.test(query.sql)) return Promise.reject(new Error('injected invoice insert failure'));
    return original.call(this, connection, query);
  });
  try {
    await expect(service.convertToInvoiceOnly(contractId, adminId)).rejects.toThrow('injected invoice insert failure');
  } finally {
    spy.mockRestore();
  }
  // The failed attempt must not leave the contract permanently claimed —
  // an immediate retry (well inside the staleness window) has to succeed.
  const result = await service.convertToInvoiceOnly(contractId, adminId);
  expect(result.installmentsCreated).toBe(1);
  const invoices = await db('invoices').where({ source_contract_id: contractId });
  expect(invoices).toHaveLength(1);
  expect(invoices[0].id).toBe(result.invoiceId);
});
