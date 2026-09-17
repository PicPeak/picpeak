const knex = require('knex');
const { randomUUID } = require('crypto');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');
const pgUrl = process.env.PICPEAK_PG_TEST_URL;
let db; let cleanup; let adminId; let customerId; let owner; let schema; let service; let contractId;
beforeAll(async () => {
  if (pgUrl) {
    schema = `contract_invoice_${randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    process.env.DATABASE_CLIENT = 'pg';
    jest.doMock('../../knexfile', () => ({ client: 'pg', connection: pgUrl, searchPath: [schema] }));
  }
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId, customerId } = await seedMinimal(db));
  service = require('../../src/services/contract/conversions');
  const [contract] = await db('contracts').insert({ contract_number: 'TEST-CONTRACT', customer_account_id: customerId,
    issue_date: '2026-09-16', status: 'fully_signed', title: 'Standalone contract', created_by_admin_id: adminId }).returning('id');
  contractId = contract.id ?? contract;
});
afterAll(async () => {
  if (cleanup) await cleanup();
  if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
});

test('failed standalone invoice creation rolls back its sequence claim', async () => {
  const before = await db('document_sequences').where({ kind: 'invoice' });
  const prototype = Object.getPrototypeOf(db.client);
  const original = prototype._query;
  const spy = jest.spyOn(prototype, '_query').mockImplementation(function(connection, query) {
    if (/^insert into ["`]invoices["`]/i.test(query.sql)) return Promise.reject(new Error('injected invoice insert failure'));
    return original.call(this, connection, query);
  });
  try { await expect(service.convertToInvoiceOnly(contractId, adminId)).rejects.toThrow('injected invoice insert failure'); }
  finally { spy.mockRestore(); }
  expect(await db('document_sequences').where({ kind: 'invoice' })).toEqual(before);
  expect(Number((await db('invoices').count('* as count').first()).count)).toBe(0);
});

test('retry persists the invoice, lineage, and exactly one sequence claim together', async () => {
  const result = await service.convertToInvoiceOnly(contractId, adminId);
  expect(result.installmentsCreated).toBe(1);
  const invoice = await db('invoices').where({ id: result.invoiceId }).first();
  expect(invoice.source_contract_id).toBe(contractId);
  expect(invoice.event_name).toBe('Standalone contract');
  expect(invoice.invoice_number).toBeTruthy();
  expect(Number((await db('document_sequences').where({ kind: 'invoice' }).first()).current_value)).toBe(1);
});
