/**
 * The running bill of a monthly- or manual-billing customer (the accumulator
 * draft, invoice/drafts.js) keeps what a converted quote says (issue 2649,
 * item 1):
 *
 *   - currency: a EUR quote never lands on a CHF draft as CHF; one open draft
 *     per customer AND currency;
 *   - VAT: one open draft per customer, currency AND rate, so a 0 % quote
 *     never retaxes an 8.1 % quote that came first;
 *   - shipping: the quote's shipping is added to the draft's;
 *   - parent totals: a zero-priced parent counts its priced sub-items;
 *   - booking flow: prepare_invoice says the amounts were accumulated and
 *     send_document skips the running bill instead of failing;
 *   - lineage: the quotes and contracts accumulated into a draft are
 *     recorded, so a contract-conversion retry finds the draft.
 *
 * Real SQLite with the full core-migration run (helpers/crmDb).
 */
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup; let tmpDir; let adminId;
let quoteService; let invoiceService; let workflows; let token;
const prevCwd = process.cwd();

// insert(...).returning('id') yields [{ id }] on pg and [id] on SQLite.
const insertId = async (q) => { const [row] = await q.returning('id'); return row && typeof row === 'object' ? row.id : row; };

let customerSeq = 0;
async function accumulatorCustomer(cadence = 'monthly', extra = {}) {
  customerSeq += 1;
  return insertId(db('customer_accounts').insert({
    email: `acc-${customerSeq}@example.com`,
    display_name: `Accumulator ${customerSeq}`,
    password_hash: 'unused',
    preferred_language: 'de',
    is_active: 1,
    billing_cadence: cadence,
    created_at: new Date().toISOString(),
    ...extra,
  }));
}

/** An accepted quote made by the quote service (its totals are its own). */
async function acceptedQuote(customerId, { currency = 'CHF', vatRate = 0, shippingAmountMinor = 0, lineItems } = {}) {
  const quoteId = await quoteService.createQuote({
    customerAccountId: customerId,
    currency,
    vatRate,
    shippingAmountMinor,
    lineItems: lineItems || [{ position: 1, quantity: 1, description: 'Shoot', unit_price_minor: 10000, discount_percent: 0, parent_position: null }],
  }, adminId);
  await db('quotes').where({ id: quoteId }).update({ status: 'accepted' });
  return quoteId;
}

const openDrafts = (customerId) => db('invoices')
  .where({ customer_account_id: customerId, is_monthly_draft: true, status: 'scheduled' })
  .orderBy('id');

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  // Under jest's vm sandbox node-sqlite3 stores service-created Dates as
  // "[object Object]"; normalise bindings the way the other invoice suites do.
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
  db.client.pool.acquireTimeoutMillis = 2000;

  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  for (const key of ['bills', 'workflows']) {
    const updated = await db('feature_flags').where({ key }).update({ value: true });
    if (!updated) await db('feature_flags').insert({ key, value: true });
  }
  const profile = await db('business_profile').first();
  await db('business_profile').where({ id: profile.id }).update({ default_currency: 'CHF', email: 'studio@example.com' });

  quoteService = require('../../src/services/quoteService');
  invoiceService = require('../../src/services/invoiceService');
  workflows = require('../../src/services/workflows');
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

describe.each(['monthly', 'manual'])('converting quotes for a %s-billing customer', (cadence) => {
  test('currency: a EUR quote opens its own EUR draft and is never relabelled CHF', async () => {
    const customerId = await accumulatorCustomer(cadence);
    await quoteService.convertToInvoiceOnly(await acceptedQuote(customerId, { currency: 'CHF' }), adminId);
    await quoteService.convertToInvoiceOnly(await acceptedQuote(customerId, { currency: 'EUR' }), adminId);

    const drafts = await openDrafts(customerId);
    expect(drafts.map((d) => [d.currency, Number(d.total_amount_minor)])).toEqual([['CHF', 10000], ['EUR', 10000]]);
  });

  test('VAT: a 0 % quote after an 8.1 % one never retaxes the first', async () => {
    const customerId = await accumulatorCustomer(cadence);
    await quoteService.convertToInvoiceOnly(await acceptedQuote(customerId, { vatRate: 8.1 }), adminId);
    await quoteService.convertToInvoiceOnly(await acceptedQuote(customerId, { vatRate: 0 }), adminId);
    // A second 8.1 % quote joins the 8.1 % draft.
    await quoteService.convertToInvoiceOnly(await acceptedQuote(customerId, { vatRate: 8.1 }), adminId);

    const drafts = await openDrafts(customerId);
    expect(drafts.map((d) => [Number(d.vat_rate), Number(d.net_amount_minor), Number(d.vat_amount_minor), Number(d.total_amount_minor)]))
      .toEqual([[8.1, 20000, 1620, 21620], [0, 10000, 0, 10000]]);
  });

  test('shipping: the quote\'s shipping is added to the draft', async () => {
    const customerId = await accumulatorCustomer(cadence);
    await quoteService.convertToInvoiceOnly(await acceptedQuote(customerId, { shippingAmountMinor: 1500 }), adminId);
    await quoteService.convertToInvoiceOnly(await acceptedQuote(customerId, { shippingAmountMinor: 500 }), adminId);

    const [draft] = await openDrafts(customerId);
    expect([Number(draft.shipping_amount_minor), Number(draft.total_amount_minor)]).toEqual([2000, 22000]);

    // A later re-total (an hours entry, a line edited in place) keeps it.
    const { retotalUnissuedInvoice } = require('../../src/services/invoice/drafts');
    await db.transaction((trx) => retotalUnissuedInvoice(trx, draft, {}));
    const after = await db('invoices').where({ id: draft.id }).first();
    expect([Number(after.shipping_amount_minor), Number(after.total_amount_minor)]).toEqual([2000, 22000]);
  });

  test('parent totals: a zero-priced parent counts its priced sub-item', async () => {
    const customerId = await accumulatorCustomer(cadence);
    const quoteId = await acceptedQuote(customerId, {
      lineItems: [
        { position: 1, quantity: 1, description: 'Package', unit_price_minor: 0, discount_percent: 0, parent_position: null },
        { position: 2, quantity: 1, description: 'Coverage', unit_price_minor: 10000, discount_percent: 0, parent_position: 1 },
      ],
    });
    await quoteService.convertToInvoiceOnly(quoteId, adminId);

    const [draft] = await openDrafts(customerId);
    expect([Number(draft.net_amount_minor), Number(draft.total_amount_minor)]).toEqual([10000, 10000]);
  });

  test('lineage: the accumulated quote and its contract are recorded, and a contract retry finds the draft', async () => {
    const customerId = await accumulatorCustomer(cadence);
    const quoteId = await acceptedQuote(customerId);
    const contractId = await insertId(db('contracts').insert({
      contract_number: `C-${cadence}-${customerSeq}`,
      customer_account_id: customerId,
      source_quote_id: quoteId,
      status: 'fully_signed',
      issue_date: '2026-01-01',
      title: 'Agreement',
      language: 'de',
      created_by_admin_id: adminId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
    await db('quotes').where({ id: quoteId }).update({ converted_contract_id: contractId });

    const conversions = require('../../src/services/contract/conversions');
    const first = await conversions.convertToInvoiceOnly(contractId, adminId);
    const [draft] = await openDrafts(customerId);
    expect(first.invoiceIds).toEqual([draft.id]);
    const links = await db('invoice_accumulated_sources').where({ invoice_id: draft.id });
    expect(links.map((l) => [Number(l.quote_id), Number(l.contract_id)])).toEqual([[quoteId, contractId]]);

    // The claim goes stale (or the request is retried): the retry adopts the
    // draft instead of failing on the converted quote.
    await db('contracts').where({ id: contractId }).update({ invoice_prepared_at: null });
    const again = await conversions.convertToInvoiceOnly(contractId, adminId);
    expect(again).toMatchObject({ alreadyConverted: true, invoiceIds: [draft.id] });
    expect(await db('invoice_line_items').where({ invoice_id: draft.id })).toHaveLength(1);
  });
});

describe('every open draft of a customer', () => {
  test('the customer page lists each draft and "Trigger invoice now" issues all of them', async () => {
    const customerId = await accumulatorCustomer('manual');
    await quoteService.convertToInvoiceOnly(await acceptedQuote(customerId, { currency: 'CHF' }), adminId);
    await quoteService.convertToInvoiceOnly(await acceptedQuote(customerId, { currency: 'EUR' }), adminId);

    const preview = await invoiceService.getMonthlyDrafts(customerId);
    expect(preview.map((d) => d.currency)).toEqual(['CHF', 'EUR']);

    const result = await invoiceService.triggerMonthlyBillNow(customerId, adminId);
    expect(result.invoices.map((i) => i.invoiceId)).toEqual(preview.map((d) => d.id));
    expect(await openDrafts(customerId)).toHaveLength(0);
  });

  test('editing a draft onto the currency and rate of another open draft answers 409', async () => {
    const customerId = await accumulatorCustomer('monthly');
    await quoteService.convertToInvoiceOnly(await acceptedQuote(customerId, { vatRate: 8.1 }), adminId);
    await quoteService.convertToInvoiceOnly(await acceptedQuote(customerId, { vatRate: 0 }), adminId);
    const [first] = await openDrafts(customerId);

    const invoiceApp = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
    const res = await request(invoiceApp).put(`/api/admin/invoices/${first.id}`)
      .set('Authorization', `Bearer ${token}`).send({ vatRate: 0 });
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 409, code: 'MONTHLY_DRAFT_KEY_TAKEN' });
    expect(Number((await db('invoices').where({ id: first.id }).first()).vat_rate)).toBe(8.1);
  });

  test('a line that states no rate (an hours entry) joins the open draft at its rate without retaxing it', async () => {
    const customerId = await accumulatorCustomer('monthly');
    await quoteService.convertToInvoiceOnly(await acceptedQuote(customerId, { vatRate: 8.1 }), adminId);
    const customer = await db('customer_accounts').where({ id: customerId }).first();
    await db.transaction((trx) => invoiceService.appendOneLineItemToMonthlyDraft(customer, {
      description: 'Editing 1h', quantity: 1, unit_price_minor: 10000, discount_percent: 0,
    }, adminId, trx));

    const drafts = await openDrafts(customerId);
    expect(drafts.map((d) => [Number(d.vat_rate), Number(d.net_amount_minor), Number(d.total_amount_minor)]))
      .toEqual([[8.1, 20000, 21620]]);
  });
});

describe('booking flow for an accumulator customer', () => {
  test('prepare_invoice records the accumulation and send_document skips the running bill', async () => {
    const customerId = await accumulatorCustomer('monthly');
    const workflowId = await insertId(db('workflows').insert({
      name: 'booking accumulator', trigger_type: 'quote.accepted.acc', version: 1, enabled: true, created_by: adminId,
    }));
    const nodes = [
      { key: 't', type: 'trigger' },
      { key: 'prep', type: 'action', config: { action: 'prepare_invoice' } },
      { key: 'send', type: 'action', config: { action: 'send_document', document: 'invoice' } },
    ];
    for (const n of nodes) {
      await db('workflow_nodes').insert({ workflow_id: workflowId, version: 1, node_key: n.key, type: n.type, config: JSON.stringify(n.config || {}) });
    }
    for (const [from, to] of [['t', 'prep'], ['prep', 'send']]) {
      await db('workflow_edges').insert({ workflow_id: workflowId, version: 1, from_node: from, from_handle: null, to_node: to, loop_back: false });
    }
    const quoteId = await acceptedQuote(customerId);
    const [runId] = await workflows.emitWorkflowEvent('quote.accepted.acc', {
      entityType: 'quote', entityId: quoteId, payload: { actorAdminId: adminId },
    });
    const run = await db('workflow_runs').where({ id: runId }).first();
    expect([run.status, run.error]).toEqual(['done', null]);

    const [draft] = await openDrafts(customerId);
    const vars = (typeof run.context === 'string' ? JSON.parse(run.context) : run.context).vars;
    expect(vars.preparedInvoiceIds.map(Number)).toEqual([draft.id]);
    expect(vars.accumulatedInvoiceIds.map(Number)).toEqual([draft.id]);

    const send = workflows.registry.getAction('send_document');
    const result = await send({ db, run: { id: runId, entity_type: 'quote', entity_id: quoteId }, node: { config: { document: 'invoice' } }, vars });
    expect(result).toMatchObject({ skipped: true, accumulated: [draft.id] });
    expect((await db('invoices').where({ id: draft.id }).first()).is_monthly_draft).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Authorization and atomicity of the accumulator (Codex round 1 on the fix).
// ---------------------------------------------------------------------------

let roleSeq = 0;
async function adminWithPermissions(permissions) {
  roleSeq += 1;
  const name = `acc_role_${roleSeq}`;
  const roleId = await insertId(db('roles').insert({ name, display_name: name }));
  for (const p of await db('permissions').whereIn('name', permissions)) {
    await db('role_permissions').insert({ role_id: roleId, permission_id: p.id });
  }
  return insertId(db('admin_users').insert({
    username: name, email: `${name}@example.com`, password_hash: 'unused',
    must_change_password: false, role_id: roleId, created_at: new Date().toISOString(),
  }));
}

/** A booking flow authored by `authorId`: prepare_invoice → send_document. */
let flowSeq = 0;
async function bookingRun(quoteId, authorId) {
  flowSeq += 1;
  const trigger = `quote.accepted.auth${flowSeq}`;
  const workflowId = await insertId(db('workflows').insert({
    name: `booking auth ${flowSeq}`, trigger_type: trigger, version: 1, enabled: true, created_by: authorId,
  }));
  const nodes = [
    { key: 't', type: 'trigger' },
    { key: 'prep', type: 'action', config: { action: 'prepare_invoice' } },
    { key: 'send', type: 'action', config: { action: 'send_document', document: 'invoice' } },
  ];
  for (const n of nodes) {
    await db('workflow_nodes').insert({ workflow_id: workflowId, version: 1, node_key: n.key, type: n.type, config: JSON.stringify(n.config || {}) });
  }
  for (const [from, to] of [['t', 'prep'], ['prep', 'send']]) {
    await db('workflow_edges').insert({ workflow_id: workflowId, version: 1, from_node: from, from_handle: null, to_node: to, loop_back: false });
  }
  const [runId] = await workflows.emitWorkflowEvent(trigger, { entityType: 'quote', entityId: quoteId, payload: {} });
  return db('workflow_runs').where({ id: runId }).first();
}

/** An accepted quote owned by `ownerId`. */
async function ownedAcceptedQuote(customerId, ownerId, { currency = 'CHF', vatRate = 0 } = {}) {
  const quoteId = await quoteService.createQuote({
    customerAccountId: customerId, currency, vatRate,
    lineItems: [{ position: 1, quantity: 1, description: 'Shoot', unit_price_minor: 10000, discount_percent: 0, parent_position: null }],
  }, ownerId);
  await db('quotes').where({ id: quoteId }).update({ status: 'accepted', created_by_admin_id: ownerId });
  return quoteId;
}

describe('accumulator authorization', () => {
  let quotesOnlyId; let billerId; let billingOnlyId;
  beforeAll(async () => {
    quotesOnlyId = await adminWithPermissions(['quotes.view', 'quotes.manage']);
    billerId = await adminWithPermissions(['quotes.view', 'quotes.manage', 'bills.view', 'bills.manage']);
    billingOnlyId = await adminWithPermissions(['bills.view', 'bills.manage']);
    // The role cache is warm from the suites above; read the new roles.
    require('../../src/middleware/permissions').clearPermissionCache();
  });

  test('a booking flow whose author may not manage bills opens no running bill', async () => {
    const customerId = await accumulatorCustomer('monthly');
    const quoteId = await ownedAcceptedQuote(customerId, quotesOnlyId);
    const run = await bookingRun(quoteId, quotesOnlyId);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/Insufficient CRM permissions/);
    expect(await db('invoices').where({ customer_account_id: customerId })).toHaveLength(0);
    expect(await db('invoice_accumulated_sources').where({ quote_id: quoteId })).toHaveLength(0);
  });

  test('a booking flow never appends to another admin\'s running bill', async () => {
    const customerId = await accumulatorCustomer('monthly');
    // The super-admin's own draft for CHF 0 %.
    await quoteService.convertToInvoiceOnly(await acceptedQuote(customerId), adminId);
    const [foreign] = await openDrafts(customerId);

    const quoteId = await ownedAcceptedQuote(customerId, billerId);
    const run = await bookingRun(quoteId, billerId);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/another admin/i);
    const after = await db('invoices').where({ id: foreign.id }).first();
    expect(Number(after.total_amount_minor)).toBe(10000);
    expect(await db('invoice_line_items').where({ invoice_id: foreign.id })).toHaveLength(1);
    expect(await openDrafts(customerId)).toHaveLength(1);
  });

  test('a booking flow whose author manages bills opens and fills its own running bill', async () => {
    const customerId = await accumulatorCustomer('monthly');
    const first = await bookingRun(await ownedAcceptedQuote(customerId, billerId), billerId);
    expect([first.status, first.error]).toEqual(['done', null]);
    const second = await bookingRun(await ownedAcceptedQuote(customerId, billerId), billerId);
    expect([second.status, second.error]).toEqual(['done', null]);

    const drafts = await openDrafts(customerId);
    expect(drafts.map((d) => [Number(d.created_by_admin_id), Number(d.total_amount_minor)])).toEqual([[billerId, 20000]]);
  });

  test('the bill editor cannot record another customer\'s or an unreadable quote as accumulated', async () => {
    const customerId = await accumulatorCustomer('monthly');
    const otherCustomerId = await accumulatorCustomer('monthly');
    const foreignCustomerQuote = await acceptedQuote(otherCustomerId);
    const ownCustomerQuote = await acceptedQuote(customerId);
    const invoiceApp = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
    const save = (id, sourceQuoteId) => request(invoiceApp).post('/api/admin/invoices')
      .set('Authorization', `Bearer ${mintAdminToken(id)}`)
      .send({
        customerAccountId: customerId, currency: 'CHF', vatRate: 0, sourceQuoteId,
        lineItems: [{ position: 1, quantity: 1, description: 'Edited', unitPriceMinor: 10000, discountPercent: 0 }],
      });

    // Another customer's quote.
    const crossCustomer = await save(adminId, foreignCustomerQuote);
    expect(crossCustomer.status).toBeGreaterThanOrEqual(400);
    // A quote this billing-only admin cannot read.
    const unreadable = await save(billingOnlyId, ownCustomerQuote);
    expect(unreadable.status).toBeGreaterThanOrEqual(400);
    expect(await db('invoices').where({ customer_account_id: customerId })).toHaveLength(0);

    // A readable quote of the customer: saved, but an editor save is no
    // conversion, so nothing is recorded as accumulated and the quote still
    // converts (and is recorded) later.
    const ok = await save(adminId, ownCustomerQuote);
    expect(ok.status).toBe(201);
    expect(await db('invoice_accumulated_sources').whereIn('quote_id', [foreignCustomerQuote, ownCustomerQuote])).toHaveLength(0);
    await quoteService.convertToInvoiceOnly(ownCustomerQuote, adminId);
    expect(await db('invoice_accumulated_sources').where({ quote_id: ownCustomerQuote })).toHaveLength(1);
  });
});

describe('accumulator atomicity and totals', () => {
  test('a repeated conversion outside a transaction appends once', async () => {
    const customerId = await accumulatorCustomer('monthly');
    const customer = await db('customer_accounts').where({ id: customerId }).first();
    const quoteId = await acceptedQuote(customerId);
    const convert = () => invoiceService.spawnInstallmentInvoices({
      trx: db, customer, adminId, quoteId, currency: 'CHF',
      lineItems: [{ position: 1, quantity: 1, description: 'Shoot', unit_price_minor: 10000, discount_percent: 0, parent_position: null }],
      totals: { net: 10000, vat: 0, shipping: 0, total: 10000, vatRate: 0 },
      installments: [{ percent: 100 }],
    });
    const first = await convert();
    const again = await convert().catch((err) => err);
    expect(again.invoiceIds).toEqual(first.invoiceIds);
    const [draft] = await openDrafts(customerId);
    expect(await db('invoice_line_items').where({ invoice_id: draft.id })).toHaveLength(1);
    expect(Number(draft.total_amount_minor)).toBe(10000);
  });

  test('editing an hours entry on a rounded-total draft keeps its net', async () => {
    const settings = require('../../src/utils/appSettings');
    const hours = require('../../src/services/customerHoursService');
    const flag = await db('feature_flags').where({ key: 'hoursLogging' }).update({ value: true });
    if (!flag) await db('feature_flags').insert({ key: 'hoursLogging', value: true });
    const customerId = await accumulatorCustomer('monthly', { feature_hours_logging: true });
    await settings.upsertAppSetting('crm_invoice_round_total', 'true', 'crm');
    try {
      // 15 minutes at 33.33/h: each line is 8.3325, rounded 8.33; three of
      // them are 24.9975 exactly, 25.00 rounded once, 24.99 line by line.
      const entries = [];
      for (const start of ['09:00', '10:00', '11:00']) {
        const end = `${start.slice(0, 2)}:15`;
        entries.push(await hours.createEntry(customerId, {
          entryDate: '2026-11-02', startTime: start, endTime: end, hourlyRateMinorOverride: 3333,
        }, adminId));
      }
      const [draft] = await openDrafts(customerId);
      expect(Number(draft.net_amount_minor)).toBe(2500);
      const entry = await db('customer_hour_entries').where({ customer_account_id: customerId }).orderBy('id').first();
      await hours.updateEntry(entry.id, { description: 'Retouching' }, adminId);
      expect(Number((await db('invoices').where({ id: draft.id }).first()).net_amount_minor)).toBe(2500);
    } finally {
      await settings.upsertAppSetting('crm_invoice_round_total', 'false', 'crm');
    }
  });
});

describe('accumulator draft creation race', () => {
  test('a draft the same admin opened concurrently is adopted, not refused as out of reach', async () => {
    const crmAccess = require('../../src/database/crmAccess');
    const drafts = require('../../src/services/invoice/drafts');
    const customerId = await accumulatorCustomer('monthly');
    const customer = await db('customer_accounts').where({ id: customerId }).first();
    const key = { currency: 'CHF', vatRate: 0 };

    // A concurrent conversion by the same admin commits its draft between
    // this call's own lookup (none) and its check whether the key is held.
    let rival = null;
    const real = crmAccess.withTrustedCrmAccess;
    const spy = jest.spyOn(crmAccess, 'withTrustedCrmAccess').mockImplementation(async (reason, work) => {
      if (!rival && /out of reach/.test(reason)) {
        spy.mockImplementation(real);
        rival = await drafts.getOrCreateMonthlyDraft(customer, adminId, db, key);
      }
      return real(reason, work);
    });
    try {
      const result = await drafts.getOrCreateMonthlyDraft(customer, adminId, db, key);
      expect(rival).not.toBeNull();
      expect({ id: result.id, created: result.created }).toEqual({ id: rival.id, created: false });
    } finally {
      spy.mockRestore();
    }
    expect(await openDrafts(customerId)).toHaveLength(1);
  });
});

describe('accumulator draft creation race under a booking flow', () => {
  test('the flow adopts the draft the same admin opened concurrently under another deal', async () => {
    const crmAccess = require('../../src/database/crmAccess');
    const drafts = require('../../src/services/invoice/drafts');
    const billerId = await adminWithPermissions(['quotes.view', 'quotes.manage', 'bills.view', 'bills.manage']);
    const customerId = await accumulatorCustomer('monthly');
    const customer = await db('customer_accounts').where({ id: customerId }).first();
    const key = { currency: 'CHF', vatRate: 0 };
    const quoteId = await ownedAcceptedQuote(customerId, billerId);
    const quote = await db('quotes').where({ id: quoteId }).first();
    // The booking flow's actor: the biller, fenced to the quote's deal.
    const actor = Object.freeze({
      id: billerId, roleName: 'crm_workflow_creator',
      permissions: new Set(['quotes.view', 'quotes.manage', 'bills.view', 'bills.manage']),
      capability: Object.freeze({ root: 'quotes', id: quoteId, dealUuid: quote.deal_uuid, eventId: null }),
    });

    // A concurrent request by the same admin commits its draft, with a deal
    // of its own, between the flow's lookup (none) and its key check.
    let rival = null;
    const real = crmAccess.withTrustedCrmAccess;
    const spy = jest.spyOn(crmAccess, 'withTrustedCrmAccess').mockImplementation(async (reason, work) => {
      if (!rival && /out of reach/.test(reason)) {
        spy.mockImplementation(real);
        rival = await real('test: concurrent request', () => drafts.getOrCreateMonthlyDraft(customer, billerId, db, key));
      }
      return real(reason, work);
    });
    let result;
    try {
      result = await crmAccess.withCrmActor(actor, () => drafts.withAccumulatorDraftDeal(db, customer, key,
        (dealUuid) => drafts.getOrCreateMonthlyDraft(customer, billerId, db, { ...key, dealUuid })));
    } finally {
      spy.mockRestore();
    }
    expect(rival).not.toBeNull();
    expect(rival.row.deal_uuid).not.toBe(quote.deal_uuid);
    expect({ id: result.id, created: result.created }).toEqual({ id: rival.id, created: false });
    expect(await openDrafts(customerId)).toHaveLength(1);
  });
});
