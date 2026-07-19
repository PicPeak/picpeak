/**
 * Regression tests for logActivity calls inside transactions (#850 review
 * find). createContract / updateContract / createStorno / reissueInvoice
 * called logActivity() (and contract paths also adminActor()) from inside
 * a knex transaction WITHOUT the trx executor. On single-connection SQLite
 * the audit insert then waits on a second pool connection while the trx
 * holds the only one — a 60s acquire-timeout stall per call, after which
 * logActivity's catch swallows the failure and the audit row is silently
 * lost. Postgres was unaffected.
 *
 * The observable fix: the activity_logs rows now exist, and the calls
 * complete without waiting on the pool. The shrunken acquire timeout
 * below makes any reintroduced deadlock fail the test quickly instead
 * of appearing to pass after a long stall.
 */
const path = require('path');
const {
  bootCrmDb, seedMinimal, assignAdminRole,
} = require('../integration/helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let contractService;
let invoiceService;

const prevCwd = process.cwd();

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  // Business-doc artifacts land under process.cwd()/storage — isolate.
  process.chdir(tmpDir);

  // A reintroduced in-trx pool grab should fail fast (2s), not stall 60s.
  db.client.pool.acquireTimeoutMillis = 2000;

  // node-sqlite3 detects Date bindings via the NATIVE realm's Date —
  // under jest's vm sandbox that check fails and Dates stringify to
  // "[object Object]". Normalize to ISO strings on the client prototype
  // (transaction clients are Object.create()d from it). Same shim as
  // crmMintPaths.test.js.
  const clientProto = Object.getPrototypeOf(db.client);
  const origQuery = clientProto._query;
  clientProto._query = function patchedQuery(connection, obj) {
    if (obj && Array.isArray(obj.bindings)) {
      obj.bindings = obj.bindings.map(
        (b) => (b && typeof b === 'object' && typeof b.toISOString === 'function' ? b.toISOString() : b),
      );
    }
    return origQuery.call(this, connection, obj);
  };

  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');

  contractService = require('../../src/services/contractService');
  invoiceService = require('../../src/services/invoiceService');
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('createContract persists the contract_created audit row (was silently lost on SQLite)', async () => {
  const contractId = await contractService.createContract({
    customerAccountId: customerId,
    title: 'Audit-Trail-Vertrag',
  }, adminId);

  const row = await db('activity_logs')
    .where({ activity_type: 'contract_created' })
    .orderBy('id', 'desc')
    .first();
  expect(row).toBeTruthy();
  expect(JSON.parse(row.metadata).contractId).toBe(contractId);
  expect(row.actor_type).toBe('admin');
});

test('updateContract persists the contract_updated audit row', async () => {
  const contractId = await contractService.createContract({
    customerAccountId: customerId,
    title: 'Vorher',
  }, adminId);

  await contractService.updateContract(contractId, { title: 'Nachher' }, adminId);

  const row = await db('activity_logs')
    .where({ activity_type: 'contract_updated' })
    .orderBy('id', 'desc')
    .first();
  expect(row).toBeTruthy();
  expect(JSON.parse(row.metadata).contractId).toBe(contractId);
});

test('cancelInvoice (Storno mint) persists the invoice_cancelled_via_storno audit row', async () => {
  const { invoiceIds } = await invoiceService.createInvoice({
    customerAccountId: customerId,
    currency: 'CHF',
    vatRate: 0,
    lineItems: [
      { position: 1, quantity: 1, description: 'Coverage', unit_price_minor: 100000, discount_percent: 0 },
    ],
  }, adminId);
  const id = invoiceIds[0];
  await db('invoices').where({ id }).update({ status: 'sent', sent_at: new Date(), updated_at: new Date() });

  const result = await invoiceService.cancelInvoice(id, adminId);
  expect(result.cancelled).toBe(true);

  const row = await db('activity_logs')
    .where({ activity_type: 'invoice_cancelled_via_storno' })
    .orderBy('id', 'desc')
    .first();
  expect(row).toBeTruthy();
  const meta = JSON.parse(row.metadata);
  expect(meta.invoiceId).toBe(id);
  expect(meta.stornoId).toBe(result.stornoId);
});

test('reissueInvoice completes on SQLite and persists the invoice_reissued audit row', async () => {
  const { invoiceIds } = await invoiceService.createInvoice({
    customerAccountId: customerId,
    currency: 'CHF',
    vatRate: 0,
    lineItems: [
      { position: 1, quantity: 1, description: 'Album', unit_price_minor: 50000, discount_percent: 0 },
    ],
  }, adminId);
  const id = invoiceIds[0];
  await db('invoices').where({ id }).update({ status: 'sent', sent_at: new Date(), updated_at: new Date() });

  // Pre-fix this stalled inside the wrapping transaction (createInvoice's
  // global-connection reads vs. the single-connection pool) and aborted
  // before the replacement existed — with the Storno already committed.
  const result = await invoiceService.reissueInvoice(id, adminId);
  expect(result.id).toBeGreaterThan(0);
  expect(result.replaces).toBe(id);

  const replacement = await db('invoices').where({ id: result.id }).first();
  expect(replacement.replaces_invoice_id).toBe(id);

  const row = await db('activity_logs')
    .where({ activity_type: 'invoice_reissued' })
    .orderBy('id', 'desc')
    .first();
  expect(row).toBeTruthy();
  expect(JSON.parse(row.metadata).newInvoiceId).toBe(result.id);
});

void path; // referenced for parity with sibling suites
