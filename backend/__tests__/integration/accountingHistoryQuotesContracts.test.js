/**
 * Quotes and contracts in the accounting change history (migration 219).
 *
 * Every quote and contract flow writes its rows through the recorder
 * (services/accountingHistory.js). These tests run the real services and the
 * customer portal routes and pin the history each flow leaves: what changed,
 * which source wrote it, and who acted. The public token links record a
 * public actor without the token; the portal records the signed-in customer.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

const SIGNATURE_DATA_URL = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PUBLIC_QUOTE = { type: 'public', id: null, name: 'quote-link' };
const PUBLIC_CONTRACT = { type: 'public', id: null, name: 'contract-link' };

let db; let cleanup; let tmpDir; let adminId; let customerId; let portal; let cookie;
let history; let quoteService; let contractService;
const prevCwd = process.cwd();

const historyOf = (type, id) => history.listHistory(type, id);
const entriesFor = (entries, entity, action) => entries.filter((e) => e.entity_type === entity && e.action === action);
const lastUpdate = (entries, entity) => entriesFor(entries, entity, 'updated').pop();

async function withHistoryTableOffline(work) {
  await db.schema.renameTable('accounting_change_history', 'accounting_change_history_offline');
  try {
    return await work();
  } finally {
    await db.schema.renameTable('accounting_change_history_offline', 'accounting_change_history');
  }
}

async function enableFlag(key) {
  const updated = await db('feature_flags').where({ key }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key, value: true });
}

const lineItem = (position, description, price, parentPosition = null) => ({
  position, quantity: 1, description, unit_price_minor: price, discount_percent: 0, parent_position: parentPosition,
});

const createQuote = () => quoteService.createQuote({
  customerAccountId: customerId,
  currency: 'CHF',
  vatRate: 0,
  eventName: 'History shoot',
  lineItems: [lineItem(1, 'Package', 100000), lineItem(2, 'Album', 20000, 1)],
}, adminId);

async function sentQuote() {
  const id = await createQuote();
  const { token } = await quoteService.sendQuote(id, adminId);
  return { id, token };
}

async function acceptedQuote() {
  const { id } = await sentQuote();
  await quoteService.adminAcceptQuote(id, adminId);
  return id;
}

async function sentContract() {
  const id = await contractService.createContract({ customerAccountId: customerId, title: 'History contract' }, adminId);
  const { token } = await contractService.sendContract(id, adminId);
  return { id, token };
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  // Service code's `new Date()` is a sandbox Date that node-sqlite3 stores as
  // "[object Object]"; bind ISO strings instead (see crmMintPaths.test.js).
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
  await enableFlag('quotes');
  await enableFlag('bills');
  await enableFlag('contracts');
  await db('customer_accounts').where({ id: customerId })
    .update({ feature_contracts: true, feature_quotes: true, feature_bills: true });
  const quotesSwitch = await db('app_settings').where({ setting_key: 'customer_feature_quotes_enabled' }).first();
  if (quotesSwitch) {
    await db('app_settings').where({ setting_key: 'customer_feature_quotes_enabled' }).update({ setting_value: 'true' });
  } else {
    await db('app_settings').insert({
      setting_key: 'customer_feature_quotes_enabled', setting_value: 'true', setting_type: 'customer_surface',
    });
  }

  history = require('../../src/services/accountingHistory');
  quoteService = require('../../src/services/quoteService');
  contractService = require('../../src/services/contractService');

  const session = jwt.sign(
    { type: 'customer', customerId, iat: Math.floor(Date.now() / 1000) - 5 },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', issuer: 'picpeak-auth', expiresIn: '1h' },
  );
  cookie = `customer_token=${session}`;
  portal = express();
  portal.use(express.json());
  portal.use(cookieParser());
  portal.use('/api/customer', require('../../src/routes/customer'));
  portal.use(require('../../src/middleware/errorHandler').errorHandler);
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

describe('quotes', () => {
  it('create records the quote and its line items as the admin', async () => {
    const id = await createQuote();
    const entries = await historyOf('quote', id);

    expect(entries.map((e) => [e.entity_type, e.action])).toEqual([
      ['quote', 'created'], ['quote_line_item', 'created'], ['quote_line_item', 'created'],
    ]);
    for (const entry of entries) {
      expect(entry.actor).toEqual({ type: 'admin', id: adminId, name: null });
      expect(entry.source).toBe('quote.create');
    }
    expect(entries[0].changes.status).toEqual({ from: null, to: 'draft' });
    expect(entries[2].changes.parent_line_item_id).toEqual({ from: null, to: entries[1].entity_id });
  });

  it('update records the changed totals and the replaced line items', async () => {
    const id = await createQuote();
    await quoteService.updateQuote(id, { lineItems: [lineItem(1, 'Reduced package', 50000)] }, adminId);
    const entries = (await historyOf('quote', id)).filter((e) => e.source === 'quote.update');

    expect(entriesFor(entries, 'quote_line_item', 'deleted')).toHaveLength(2);
    const [created] = entriesFor(entries, 'quote_line_item', 'created');
    expect(created.changes.description).toEqual({ from: null, to: 'Reduced package' });
    // The priced sub-item sets the parent's total, so the quote stood at 20000.
    expect(lastUpdate(entries, 'quote').changes.total_amount_minor).toEqual({ from: 20000, to: 50000 });
    expect(entries.every((e) => e.actor.type === 'admin' && e.actor.id === adminId)).toBe(true);
  });

  it('send records draft → sent', async () => {
    const { id } = await sentQuote();
    const update = lastUpdate(await historyOf('quote', id), 'quote');
    expect(update).toMatchObject({ source: 'quote.send', actor: { type: 'admin', id: adminId } });
    expect(update.changes.status).toEqual({ from: 'draft', to: 'sent' });
  });

  it('an accept through the public link records a public actor and never the token', async () => {
    const { id, token } = await sentQuote();
    await quoteService.recordResponse({ token, action: 'accept', ip: '127.0.0.1' });
    const entries = await historyOf('quote', id);
    const update = lastUpdate(entries, 'quote');

    expect(update.source).toBe('quote.respond');
    expect(update.actor).toEqual(PUBLIC_QUOTE);
    expect(update.changes.status).toEqual({ from: 'sent', to: 'accepted' });
    expect(JSON.stringify(entries)).not.toContain(token);
  });

  it('an accept in the customer portal records the signed-in customer', async () => {
    const { id } = await sentQuote();
    const res = await request(portal).post(`/api/customer/quotes/${id}/respond`)
      .set('Cookie', cookie).send({ action: 'accept' });
    expect(res.status).toBe(200);

    const update = lastUpdate(await historyOf('quote', id), 'quote');
    expect(update.source).toBe('quote.respond');
    expect(update.actor).toEqual({ type: 'customer', id: customerId, name: 'Test Customer' });
    expect(update.changes.status).toEqual({ from: 'sent', to: 'accepted' });
  });

  it('admin accept and decline record the admin', async () => {
    const { id: accepted } = await sentQuote();
    await quoteService.adminAcceptQuote(accepted, adminId);
    expect(lastUpdate(await historyOf('quote', accepted), 'quote')).toMatchObject({
      source: 'quote.accept.admin',
      actor: { type: 'admin', id: adminId },
      changes: { status: { from: 'sent', to: 'accepted' } },
    });

    const { id: declined } = await sentQuote();
    await quoteService.adminDeclineQuote(declined, adminId, 'Too expensive');
    const update = lastUpdate(await historyOf('quote', declined), 'quote');
    expect(update).toMatchObject({ source: 'quote.decline.admin', actor: { type: 'admin', id: adminId } });
    expect(update.changes.status).toEqual({ from: 'sent', to: 'declined' });
    expect(update.changes.decline_reason).toEqual({ from: null, to: 'Too expensive' });
  });

  it('convert to invoices only records accepted → converted', async () => {
    const id = await acceptedQuote();
    await quoteService.convertToInvoiceOnly(id, adminId);
    const update = lastUpdate(await historyOf('quote', id), 'quote');
    expect(update).toMatchObject({ source: 'quote.convert.invoices', actor: { type: 'admin', id: adminId } });
    expect(update.changes.status).toEqual({ from: 'accepted', to: 'converted' });
  });

  it('convert to a contract records the new contract, its inclusions and the quote back-pointer', async () => {
    const id = await acceptedQuote();
    const { contractId } = await contractService.createFromQuote(id, adminId);

    const quoteUpdate = lastUpdate(await historyOf('quote', id), 'quote');
    expect(quoteUpdate).toMatchObject({ source: 'quote.convert.contract', actor: { type: 'admin', id: adminId } });
    expect(quoteUpdate.changes.converted_contract_id).toEqual({ from: null, to: contractId });

    const contractEntries = await historyOf('contract', contractId);
    expect(contractEntries[0]).toMatchObject({ entity_type: 'contract', action: 'created', source: 'quote.convert.contract' });
    expect(contractEntries[0].changes.source_quote_id).toEqual({ from: null, to: id });
    const inclusions = await db('contract_block_inclusions').where({ contract_id: contractId });
    expect(entriesFor(contractEntries, 'contract_block_inclusion', 'created')).toHaveLength(inclusions.length);
  });

  it('a history row that cannot be written rolls the decline back', async () => {
    const { id } = await sentQuote();
    await withHistoryTableOffline(() => expect(quoteService.adminDeclineQuote(id, adminId)).rejects.toThrow());
    expect((await db('quotes').where({ id }).first()).status).toBe('sent');
    const unused = await db('quote_action_tokens').where({ quote_id: id }).whereNull('used_at');
    expect(unused).toHaveLength(1);
  });
});

describe('contracts', () => {
  it('create records the contract and its seeded inclusions as the admin', async () => {
    const id = await contractService.createContract({ customerAccountId: customerId, title: 'Created' }, adminId);
    const entries = await historyOf('contract', id);
    const inclusions = await db('contract_block_inclusions').where({ contract_id: id });

    expect(inclusions.length).toBeGreaterThan(0);
    expect(entries[0]).toMatchObject({ entity_type: 'contract', action: 'created', source: 'contract.create' });
    expect(entries[0].changes.title).toEqual({ from: null, to: 'Created' });
    expect(entriesFor(entries, 'contract_block_inclusion', 'created')).toHaveLength(inclusions.length);
    expect(entries.every((e) => e.actor.type === 'admin' && e.actor.id === adminId)).toBe(true);
  });

  it('update records the changed fields and the replaced inclusions', async () => {
    const id = await contractService.createContract({ customerAccountId: customerId, title: 'Before' }, adminId);
    const seeded = await db('contract_block_inclusions').where({ contract_id: id }).orderBy('id');
    const kept = seeded.slice(0, 1).map((row) => ({ blockId: row.block_id, included: true, position: 1 }));
    await contractService.updateContract(id, { title: 'After', blocks: kept }, adminId);

    const entries = (await historyOf('contract', id)).filter((e) => e.source === 'contract.update');
    expect(lastUpdate(entries, 'contract').changes.title).toEqual({ from: 'Before', to: 'After' });
    expect(entriesFor(entries, 'contract_block_inclusion', 'deleted')).toHaveLength(seeded.length);
    expect(entriesFor(entries, 'contract_block_inclusion', 'created')).toHaveLength(1);
  });

  it('send records draft → sent', async () => {
    const { id } = await sentContract();
    const update = lastUpdate(await historyOf('contract', id), 'contract');
    expect(update).toMatchObject({ source: 'contract.send', actor: { type: 'admin', id: adminId } });
    expect(update.changes.status).toEqual({ from: 'draft', to: 'sent' });
  });

  it('a signature through the public link records a public actor and never the token', async () => {
    const { id, token } = await sentContract();
    await contractService.recordCustomerSignature({
      token, name: 'Custo Mer', ip: '127.0.0.1', signatureDataUrl: SIGNATURE_DATA_URL, accepted: true,
    });
    const entries = await historyOf('contract', id);
    const signed = entriesFor(entries, 'contract', 'updated').find((e) => e.changes.status?.to === 'signed_by_customer');

    expect(signed.source).toBe('contract.sign.customer');
    expect(signed.actor).toEqual(PUBLIC_CONTRACT);
    expect(signed.changes.status).toEqual({ from: 'sent', to: 'signed_by_customer' });
    expect(signed.changes.signed_customer_name).toEqual({ from: null, to: 'Custo Mer' });
    expect(JSON.stringify(entries)).not.toContain(token);
  });

  it('a signature in the customer portal records the signed-in customer', async () => {
    const { id } = await sentContract();
    const res = await request(portal).post(`/api/customer/contracts/${id}/sign`)
      .set('Cookie', cookie).send({ name: 'Test Customer', accepted: true, signatureDataUrl: SIGNATURE_DATA_URL });
    expect(res.status).toBe(200);

    const signed = entriesFor(await historyOf('contract', id), 'contract', 'updated').find((e) => e.changes.status?.to === 'signed_by_customer');
    expect(signed.source).toBe('contract.sign.customer');
    expect(signed.actor).toEqual({ type: 'customer', id: customerId, name: 'Test Customer' });
  });

  it('a signed PDF uploaded in the customer portal records the signed-in customer', async () => {
    const { id } = await sentContract();
    const res = await request(portal).post(`/api/customer/contracts/${id}/upload-signed-pdf`)
      .set('Cookie', cookie)
      .attach('file', Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n'), {
        filename: 'signed.pdf', contentType: 'application/pdf',
      });
    expect(res.status).toBe(200);

    const update = lastUpdate(await historyOf('contract', id), 'contract');
    expect(update.source).toBe('contract.upload.signed_pdf');
    expect(update.actor).toEqual({ type: 'customer', id: customerId, name: 'Test Customer' });
    expect(update.changes.status).toEqual({ from: 'sent', to: 'fully_signed' });
  });

  it('countersignature records the admin', async () => {
    const { id, token } = await sentContract();
    await contractService.recordCustomerSignature({
      token, name: 'Custo Mer', ip: '127.0.0.1', signatureDataUrl: SIGNATURE_DATA_URL, accepted: true,
    });
    await contractService.recordAdminCountersignature(id, {
      name: 'Admin Signer', ip: '127.0.0.1', signatureDataUrl: SIGNATURE_DATA_URL,
    }, adminId);

    const countersigned = (await historyOf('contract', id))
      .find((e) => e.action === 'updated' && e.changes.status?.to === 'fully_signed');
    expect(countersigned).toMatchObject({ source: 'contract.sign.admin', actor: { type: 'admin', id: adminId } });
    expect(countersigned.changes.status.from).toBe('signed_by_customer');
    expect(countersigned.changes.signed_admin_name).toEqual({ from: null, to: 'Admin Signer' });
  });

  it('cancel records the admin', async () => {
    const { id } = await sentContract();
    await contractService.cancelContract(id, adminId);
    const update = lastUpdate(await historyOf('contract', id), 'contract');
    expect(update).toMatchObject({ source: 'contract.cancel', actor: { type: 'admin', id: adminId } });
    expect(update.changes.status).toEqual({ from: 'sent', to: 'cancelled' });
  });

  it('a history row that cannot be written rolls the customer signature back', async () => {
    const { id, token } = await sentContract();
    await withHistoryTableOffline(() => expect(contractService.recordCustomerSignature({
      token, name: 'Custo Mer', ip: '127.0.0.1', accepted: true,
    })).rejects.toThrow());
    expect((await db('contracts').where({ id }).first()).status).toBe('sent');
    expect((await db('contract_action_tokens').where({ token }).first()).used_at).toBeNull();
  });
});
