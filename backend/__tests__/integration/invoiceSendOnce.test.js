/**
 * An invoice goes out once, and a booking gate for it closes once it has.
 *
 * sendInvoice accepted 'sent' / 'overdue' rows (the admin's Resend), so every
 * automatic caller could re-mail an invoice that was already out: a booking
 * run whose review gate was confirmed after the admin had sent the invoice by
 * hand walked on to send_document and mailed it a second time. And that gate
 * stayed in the pending-approvals inbox after the invoice was sent or paid.
 *
 * Now only the admin route may re-send, a first send is a compare-and-set on
 * the 'scheduled' status, and sending, paying or cancelling an invoice by hand
 * cancels a run still waiting at a gate for it.
 */
const crypto = require('crypto');
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup; let tmpDir; let adminId; let customerId; let token;
let invoiceApp; let invoiceService; let workflows; let sending;
const prevCwd = process.cwd();

const auth = () => ({ Authorization: `Bearer ${token}` });
// insert(...).returning('id') yields [{ id }] on pg and [id] on SQLite.
const insertId = async (q) => { const [row] = await q.returning('id'); return row && typeof row === 'object' ? row.id : row; };
const invoiceMails = async () => Number((await db('email_queue').where({ email_type: 'invoice_sent' })
  .count('* as n').first()).n);

async function draftInvoice() {
  const res = await request(invoiceApp).post('/api/admin/invoices').set(auth()).send({
    customerAccountId: customerId,
    currency: 'CHF',
    lineItems: [{ position: 1, quantity: 1, description: 'Coverage', unitPriceMinor: 10000, discountPercent: 0 }],
  });
  expect(res.status).toBe(201);
  return Number(res.body.invoiceIds[0]);
}

const ONE_INSTALLMENT = [{ percent: 100, trigger: 'quote_accepted', offset_days: 0, label: 'Total' }];
const DEPOSIT_AND_FINAL = [
  { percent: 30, trigger: 'quote_accepted', offset_days: 0, label: 'Deposit' },
  { percent: 70, trigger: 'quote_accepted', offset_days: 0, label: 'Final' },
];

async function acceptedQuote(installments = ONE_INSTALLMENT) {
  const dealUuid = crypto.randomUUID();
  return insertId(db('quotes').insert({
    quote_number: `Q-${dealUuid.slice(0, 8)}`,
    customer_account_id: customerId,
    status: 'accepted',
    currency: 'CHF',
    issue_date: '2026-01-01',
    net_amount_minor: 100000, vat_amount_minor: 0, shipping_amount_minor: 0, total_amount_minor: 100000,
    payment_term_snapshot: JSON.stringify({ installments, net_days: 30 }),
    deal_uuid: dealUuid,
    created_by_admin_id: adminId,
  }));
}

// Steps a run took after its gate, by run id: 'after' behind the send on the
// confirm path, 'denied' on the deny path.
const ranSteps = new Map();
const recordStep = (step) => async (ctx) => {
  ranSteps.set(ctx.run.id, [...(ranSteps.get(ctx.run.id) || []), step]);
  return { recorded: step };
};
const stepsOf = (runId) => ranSteps.get(runId) || [];

// quote.accepted → prepare_invoice → review gate → send_document → a later
// step, the shape of the built-in booking flows plus something behind the
// send (a custom flow's mail or gallery step). Variants:
//   sendFirst — the run sends the invoice itself BEFORE the gate (a "Payment
//               received?" gate), the shape of luap's probe on round 1
//   noSend    — the gate's confirm path has no invoice send at all
//   noDeny    — the gate has no deny edge
let workflowSeq = 0;
async function bookingRunAtGate({ installments, sendFirst = false, noSend = false, noDeny = false } = {}) {
  workflowSeq += 1;
  const trigger = `quote.accepted.test${workflowSeq}`;
  const workflowId = await insertId(db('workflows').insert({ name: `booking ${workflowSeq}`, trigger_type: trigger, version: 1, enabled: true, created_by: adminId }));
  const nodes = [
    { key: 't', type: 'trigger' },
    { key: 'prep', type: 'action', config: { action: 'prepare_invoice' } },
    { key: 'send1', type: 'action', config: { action: 'send_document', document: 'invoice' } },
    { key: 'g', type: 'gate', config: { label: 'Review invoice before sending' } },
    { key: 'send', type: 'action', config: { action: 'send_document', document: 'invoice' } },
    { key: 'after', type: 'action', config: { action: 'test_after' } },
    { key: 'denied', type: 'action', config: { action: 'test_denied' } },
  ];
  const edges = sendFirst
    ? [['t', null, 'prep'], ['prep', null, 'send1'], ['send1', null, 'g']]
    : [['t', null, 'prep'], ['prep', null, 'g']];
  edges.push(noSend ? ['g', 'confirm', 'after'] : ['g', 'confirm', 'send'], ['send', null, 'after']);
  if (!noDeny) edges.push(['g', 'deny', 'denied']);
  for (const n of nodes) {
    await db('workflow_nodes').insert({ workflow_id: workflowId, version: 1, node_key: n.key, type: n.type, config: JSON.stringify(n.config || {}) });
  }
  for (const [from, handle, to] of edges) {
    await db('workflow_edges').insert({ workflow_id: workflowId, version: 1, from_node: from, from_handle: handle, to_node: to, loop_back: false });
  }
  const quoteId = await acceptedQuote(installments);
  const [runId] = await workflows.emitWorkflowEvent(trigger, {
    entityType: 'quote', entityId: quoteId, payload: { adminEmail: 'admin@example.com', actorAdminId: adminId },
  });
  const run = await db('workflow_runs').where({ id: runId }).first();
  expect([run.status, run.error]).toEqual(['waiting', null]);
  const vars = (typeof run.context === 'string' ? JSON.parse(run.context) : run.context).vars;
  const approval = await db('workflow_approvals').where({ run_id: runId }).first();
  expect(approval.status).toBe('pending');
  const invoiceIds = vars.preparedInvoiceIds.map(Number);
  return { runId, approval, invoiceId: invoiceIds[0], invoiceIds };
}

const approvalOf = async (id) => db('workflow_approvals').where({ id }).first();
const runOf = async (id) => db('workflow_runs').where({ id }).first();

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

  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  for (const key of ['bills', 'workflows']) {
    const updated = await db('feature_flags').where({ key }).update({ value: true });
    if (!updated) await db('feature_flags').insert({ key, value: true });
  }
  const profile = await db('business_profile').first();
  if (profile) await db('business_profile').where({ id: profile.id }).update({ email: 'studio@example.com' });

  invoiceService = require('../../src/services/invoiceService');
  workflows = require('../../src/services/workflows');
  sending = require('../../src/services/invoice/sending');
  invoiceApp = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
  workflows.registry.registerAction('test_after', recordStep('after'));
  workflows.registry.registerAction('test_denied', recordStep('denied'));
});

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

describe('sendInvoice sends once', () => {
  it('an automatic send of an invoice that is already out mails nothing', async () => {
    const id = await draftInvoice();
    expect((await invoiceService.sendInvoice(id, adminId)).sent).toBe(true);
    const before = await invoiceMails();

    const again = await invoiceService.sendInvoice(id, adminId);
    expect(again).toEqual({ sent: false, alreadySent: true });
    expect(await invoiceMails()).toBe(before);
  });

  it('the admin Send button still re-sends on purpose', async () => {
    const id = await draftInvoice();
    await request(invoiceApp).post(`/api/admin/invoices/${id}/send`).set(auth()).send({}).expect(200);
    const before = await invoiceMails();
    await request(invoiceApp).post(`/api/admin/invoices/${id}/send`).set(auth()).send({}).expect(200);
    expect(await invoiceMails()).toBe(before + 1);
  });

  it('two concurrent first sends queue one email', async () => {
    const id = await draftInvoice();
    const before = await invoiceMails();
    const results = await Promise.all([
      invoiceService.sendInvoice(id, adminId),
      invoiceService.sendInvoice(id, null),
    ]);
    expect(results.filter((r) => r.sent)).toHaveLength(1);
    expect(await invoiceMails()).toBe(before + 1);
    expect((await db('invoices').where({ id }).first()).status).toBe('sent');
  });

  it('two quick clicks on Send mail once (round 1 nit)', async () => {
    const id = await draftInvoice();
    const before = await invoiceMails();
    const [a, b] = await Promise.all([
      request(invoiceApp).post(`/api/admin/invoices/${id}/send`).set(auth()).send({}),
      request(invoiceApp).post(`/api/admin/invoices/${id}/send`).set(auth()).send({}),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const bodies = [a.body.data ?? a.body, b.body.data ?? b.body];
    expect(bodies.filter((x) => x.sent)).toHaveLength(1);
    expect(bodies.filter((x) => x.alreadySent)).toHaveLength(1);
    expect(await invoiceMails()).toBe(before + 1);
  });

  it('two concurrent sends of one storno mail once', async () => {
    const id = await draftInvoice();
    await invoiceService.sendInvoice(id, adminId);
    const stornoId = await db.transaction(async (trx) => sending.createStorno(id, adminId, trx));
    const stornoMails = async () => Number((await db('email_queue').where({ email_type: 'storno_issued' }).count('* as n').first()).n);
    const before = await stornoMails();
    const results = await Promise.all([sending.sendStorno(stornoId, adminId), sending.sendStorno(stornoId, null)]);
    expect(results.map((r) => r.status)).toEqual(['sent', 'sent']);
    expect(await stornoMails()).toBe(before + 1);
  });
});

describe('a booking gate for an invoice handled by hand', () => {
  it('sending the invoice by hand answers the gate, the run goes on, and the approval leaves the inbox', async () => {
    const { runId, approval, invoiceId } = await bookingRunAtGate();
    expect((await workflows.listPending()).map((a) => a.id)).toContain(approval.id);
    const before = await invoiceMails();

    const res = await request(invoiceApp).post(`/api/admin/invoices/${invoiceId}/send`).set(auth()).send({}).expect(200);
    expect(res.body.data?.sent ?? res.body.sent).toBe(true);

    const a = await approvalOf(approval.id);
    expect([a.status, a.acted_via]).toEqual(['confirmed', 'system']);
    expect((await runOf(runId)).status).toBe('done');
    // The step behind the send ran (round 1 concern 1), and the send itself was
    // skipped: one mail, the admin's.
    expect(stepsOf(runId)).toEqual(['after']);
    expect(await invoiceMails()).toBe(before + 1);
    expect((await workflows.listPending()).map((x) => x.id)).not.toContain(approval.id);
  });

  it('a late confirm on the answered gate sends nothing', async () => {
    const { approval, invoiceId } = await bookingRunAtGate();
    await request(invoiceApp).post(`/api/admin/invoices/${invoiceId}/send`).set(auth()).send({}).expect(200);
    const before = await invoiceMails();

    const res = await workflows.actById(approval.id, 'confirm', adminId);
    expect(res.already).toBe(true);
    expect(await invoiceMails()).toBe(before);
  });

  it('paying an unsent invoice by hand answers the gate too, with no mail', async () => {
    const { runId, approval, invoiceId } = await bookingRunAtGate();
    const before = await invoiceMails();
    await invoiceService.markPaid(invoiceId, { amountMinor: 100000 }, adminId);
    expect((await approvalOf(approval.id)).status).toBe('confirmed');
    expect((await runOf(runId)).status).toBe('done');
    expect(stepsOf(runId)).toEqual(['after']);
    expect(await invoiceMails()).toBe(before);
  });

  it('a gate after the run\'s own send stays with the admin when the payment is recorded', async () => {
    // luap's probe (round 1, blocker 1): t → prep → send1 → g → send.
    const { runId, approval, invoiceId } = await bookingRunAtGate({ sendFirst: true });
    expect((await db('invoices').where({ id: invoiceId }).first()).status).toBe('sent');
    await invoiceService.markPaid(invoiceId, { amountMinor: 100000 }, adminId);
    expect([(await approvalOf(approval.id)).status, (await runOf(runId)).status]).toEqual(['pending', 'waiting']);
    expect(stepsOf(runId)).toEqual([]);
  });

  it('cancelling the unsent invoice by hand takes the deny path', async () => {
    const { runId, approval, invoiceId } = await bookingRunAtGate();
    await invoiceService.cancelInvoice(invoiceId, adminId);
    expect((await approvalOf(approval.id)).status).toBe('denied');
    expect(stepsOf(runId)).toEqual(['denied']);
  });

  it('without a deny edge, a cancel takes the confirm path instead of failing the run', async () => {
    const { runId, approval, invoiceId } = await bookingRunAtGate({ noDeny: true });
    const before = await invoiceMails();
    await invoiceService.cancelInvoice(invoiceId, adminId);
    expect((await approvalOf(approval.id)).status).toBe('confirmed');
    expect([(await runOf(runId)).status, (await runOf(runId)).error]).toEqual(['done', null]);
    expect(await invoiceMails()).toBe(before);
  });

  it('an untouched gate stays pending and its confirm sends the invoice once', async () => {
    const { runId, approval, invoiceId } = await bookingRunAtGate();
    const before = await invoiceMails();
    await workflows.actById(approval.id, 'confirm', adminId);
    expect((await db('invoices').where({ id: invoiceId }).first()).status).toBe('sent');
    expect((await runOf(runId)).status).toBe('done');
    expect(await invoiceMails()).toBe(before + 1);
  });

  it('with a deposit sent by hand the gate stays, and its confirm sends only the final', async () => {
    const { runId, approval, invoiceIds } = await bookingRunAtGate({ installments: DEPOSIT_AND_FINAL });
    expect(invoiceIds).toHaveLength(2);
    const [deposit, final] = invoiceIds;
    await request(invoiceApp).post(`/api/admin/invoices/${deposit}/send`).set(auth()).send({}).expect(200);
    expect((await approvalOf(approval.id)).status).toBe('pending');
    expect((await runOf(runId)).status).toBe('waiting');

    const before = await invoiceMails();
    await workflows.actById(approval.id, 'confirm', adminId);
    expect(await invoiceMails()).toBe(before + 1);
    expect((await db('invoices').where({ id: final }).first()).status).toBe('sent');
  });

  it('once every prepared invoice is handled by hand the gate is answered', async () => {
    const { runId, approval, invoiceIds } = await bookingRunAtGate({ installments: DEPOSIT_AND_FINAL });
    for (const id of invoiceIds) {
      await request(invoiceApp).post(`/api/admin/invoices/${id}/send`).set(auth()).send({}).expect(200);
    }
    expect((await approvalOf(approval.id)).status).toBe('confirmed');
    expect((await runOf(runId)).status).toBe('done');
  });

  it('a gate that does not lead to an invoice send is left alone', async () => {
    const { runId, approval, invoiceId } = await bookingRunAtGate({ noSend: true });
    await request(invoiceApp).post(`/api/admin/invoices/${invoiceId}/send`).set(auth()).send({}).expect(200);
    expect((await approvalOf(approval.id)).status).toBe('pending');
    expect((await runOf(runId)).status).toBe('waiting');
  });

  it('send_document skips an invoice that is already out', async () => {
    const id = await draftInvoice();
    await invoiceService.sendInvoice(id, adminId);
    const before = await invoiceMails();
    const action = workflows.registry.getAction('send_document');
    const result = await action({
      db, run: { id: 0, entity_type: 'quote', entity_id: 0 }, node: { config: { document: 'invoice' } },
      vars: { preparedInvoiceIds: [id], actorAdminId: adminId },
    });
    expect(result.skipped).toBe(true);
    expect(await invoiceMails()).toBe(before);
  });
});
