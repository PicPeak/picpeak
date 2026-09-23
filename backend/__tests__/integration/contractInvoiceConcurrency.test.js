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

test('a standalone contract converted long ago is not billed again once its claim goes stale', async () => {
  const contractId = await makeFullySignedContract('TEST-RACE-3');
  const first = await service.convertToInvoiceOnly(contractId, adminId);
  // The claim stays set after success; age it past the staleness window.
  await db('contracts').where({ id: contractId })
    .update({ invoice_prepared_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() });

  const again = await service.convertToInvoiceOnly(contractId, adminId);
  expect(again).toMatchObject({ invoiceId: first.invoiceId, alreadyConverted: true });
  expect(await db('invoices').where({ source_contract_id: contractId })).toHaveLength(1);
});

// Path A: the contract came from a quote, so the invoices are the quote's
// installments and the contract lineage (invoices.source_contract_id) is
// stamped onto them. Both must commit together.
async function makeQuoteBackedContract(number) {
  const quoteService = require('../../src/services/quoteService');
  await db('customer_accounts').where({ id: customerId }).update({ feature_quotes: true, feature_bills: true });
  const quoteId = await quoteService.createQuote({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0, eventName: 'Path A shoot',
    lineItems: [{ position: 1, quantity: 1, description: 'Package', unit_price_minor: 100000, discount_percent: 0 }],
  }, adminId);
  const [contract] = await db('contracts').insert({
    contract_number: number, customer_account_id: customerId, source_quote_id: quoteId,
    issue_date: '2026-09-16', status: 'fully_signed', title: 'Quote contract', created_by_admin_id: adminId,
  }).returning('id');
  const contractId = contract.id ?? contract;
  await db('quotes').where({ id: quoteId }).update({ status: 'accepted', converted_contract_id: contractId });
  return { quoteId, contractId };
}

test('a failed lineage backfill rolls the quote conversion back and a retry links it once', async () => {
  const { quoteId, contractId } = await makeQuoteBackedContract('TEST-RACE-A1');

  const prototype = Object.getPrototypeOf(db.client);
  const original = prototype._query;
  let injected = false;
  const spy = jest.spyOn(prototype, '_query').mockImplementation(function (connection, query) {
    if (!injected && /^update ["`]invoices["`] set ["`]source_contract_id["`]/i.test(query.sql)) {
      injected = true;
      return Promise.reject(new Error('injected lineage backfill failure'));
    }
    return original.call(this, connection, query);
  });
  try {
    await expect(service.convertToInvoiceOnly(contractId, adminId)).rejects.toThrow('injected lineage backfill failure');
  } finally {
    spy.mockRestore();
  }
  expect(injected).toBe(true);
  // Full rollback: no invoices, the quote still convertible, the claim released.
  expect(await db('invoices').where({ source_quote_id: quoteId })).toHaveLength(0);
  expect((await db('quotes').where({ id: quoteId }).first()).status).toBe('accepted');
  expect((await db('contracts').where({ id: contractId }).first()).invoice_prepared_at).toBeNull();

  const result = await service.convertToInvoiceOnly(contractId, adminId);
  const invoices = await db('invoices').where({ source_quote_id: quoteId }).orderBy('id');
  expect(invoices).toHaveLength(1);
  expect(invoices.every((i) => i.source_contract_id === contractId)).toBe(true);
  expect(result.invoiceIds).toEqual(invoices.map((i) => i.id));

  // A later call — even past the claim's staleness window — adopts them.
  await db('contracts').where({ id: contractId })
    .update({ invoice_prepared_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
  const again = await service.convertToInvoiceOnly(contractId, adminId);
  expect(again).toMatchObject({ invoiceIds: invoices.map((i) => i.id), alreadyConverted: true });
  expect(await db('invoices').where({ source_quote_id: quoteId })).toHaveLength(1);
});

test('two concurrent conversions of the same quote-backed contract create its invoices once', async () => {
  const { quoteId, contractId } = await makeQuoteBackedContract('TEST-RACE-A2');

  const settled = await Promise.allSettled([
    service.convertToInvoiceOnly(contractId, adminId),
    service.convertToInvoiceOnly(contractId, adminId),
  ]);

  const invoices = await db('invoices').where({ source_quote_id: quoteId }).orderBy('id');
  expect(invoices).toHaveLength(1);
  expect(invoices[0].source_contract_id).toBe(contractId);
  const fulfilled = settled.filter((r) => r.status === 'fulfilled');
  expect(fulfilled.length).toBeGreaterThanOrEqual(1);
  for (const r of fulfilled) expect(r.value.invoiceIds).toEqual([invoices[0].id]);
  for (const r of settled.filter((s) => s.status === 'rejected')) {
    expect(r.reason.code).toBe('INVOICE_CONVERSION_IN_PROGRESS');
  }

  const retry = await service.convertToInvoiceOnly(contractId, adminId);
  expect(retry.invoiceIds).toEqual([invoices[0].id]);
  expect(await db('invoices').where({ source_quote_id: quoteId })).toHaveLength(1);
});
