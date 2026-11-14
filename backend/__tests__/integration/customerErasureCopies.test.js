'use strict';

// Customer erasure reaches the copies of the customer's details that other
// records keep: the contact columns on their galleries and the stored
// context of their workflow runs.
const crypto = require('crypto');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

let db, cleanup, adminId;
const json = value => (typeof value === 'string' ? JSON.parse(value) : value);
const idOf = row => row?.id ?? row;
let serial = 0;

async function customer() {
  serial += 1;
  const email = `erase-copy-${serial}@example.test`;
  const [row] = await db('customer_accounts').insert({ email, display_name: `Erase Copy ${serial}`, first_name: 'Vera',
    last_name: `Copy${serial}`, phone: '+00 111 1111', preferred_language: 'de', is_active: 1, created_at: new Date() }).returning('id');
  return { id: idOf(row), email };
}

async function galleryFromQuote(customerId) {
  const dealUuid = crypto.randomUUID();
  const [row] = await db('quotes').insert({ quote_number: `Q-${dealUuid.slice(0, 8)}`, customer_account_id: customerId,
    status: 'accepted', currency: 'CHF', issue_date: '2027-02-01', net_amount_minor: 100000, vat_amount_minor: 0,
    shipping_amount_minor: 0, total_amount_minor: 100000, deal_uuid: dealUuid, created_by_admin_id: adminId }).returning('id');
  const { eventId } = await require('../../src/services/quoteService')
    .convertToEvent(idOf(row), adminId, { hold: true, skipInvoices: true });
  return eventId;
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
});
afterAll(async () => { if (cleanup) await cleanup(); });

describe('gallery contact copies', () => {
  test('erasure blanks the customer\'s details on their galleries and gallery mail finds no recipient', async () => {
    const erased = await customer();
    const eventId = await galleryFromQuote(erased.id);
    const before = await db('events').where({ id: eventId }).first();
    expect(before.customer_email).toBe(erased.email);
    expect(before.host_email).toBe(erased.email);

    await require('../../src/services/customerAccountsService').eraseCustomer(erased.id, adminId);

    const after = await db('events').where({ id: eventId }).first();
    expect({ customer_name: after.customer_name, customer_email: after.customer_email, customer_phone: after.customer_phone,
      host_name: after.host_name, host_email: after.host_email })
      .toEqual({ customer_name: null, customer_email: null, customer_phone: null, host_name: null, host_email: null });

    // A gallery of a customer who stays shows the expiry pass does queue mail.
    const kept = await customer();
    const keptEventId = await galleryFromQuote(kept.id);
    await db('events').whereIn('id', [eventId, keptEventId]).update({ is_draft: false, is_active: true,
      expires_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString() });
    await require('../../src/services/expirationChecker').checkExpirations();
    const queuedTo = address => db('email_queue').whereRaw('LOWER(recipient_email) = ?', [address]);
    expect(await queuedTo(kept.email)).toHaveLength(1);
    expect(await queuedTo(erased.email)).toHaveLength(0);
  });

  test('a contact of the erased customer named as host is cleared too', async () => {
    const erased = await customer();
    const eventId = await galleryFromQuote(erased.id);
    await db('customer_contacts').insert({ customer_account_id: erased.id, email: 'erase-contact@example.test' });
    await db('events').where({ id: eventId }).update({ host_name: 'Contact', host_email: 'erase-contact@example.test' });
    await require('../../src/services/customerAccountsService').eraseCustomer(erased.id, adminId);
    const after = await db('events').where({ id: eventId }).first();
    expect([after.host_name, after.host_email]).toEqual([null, null]);
  });

  test('a host typed for someone else and another customer\'s gallery stay', async () => {
    const erased = await customer();
    const other = await customer();
    const own = await galleryFromQuote(erased.id);
    const foreign = await galleryFromQuote(other.id);
    await db('events').where({ id: own }).update({ host_name: 'Partner', host_email: 'partner@example.test' });

    await require('../../src/services/customerAccountsService').eraseCustomer(erased.id, adminId);

    const ownAfter = await db('events').where({ id: own }).first();
    expect(ownAfter.customer_email).toBeNull();
    expect(ownAfter.host_email).toBe('partner@example.test');
    expect(ownAfter.host_name).toBe('Partner');
    const foreignAfter = await db('events').where({ id: foreign }).first();
    expect(foreignAfter.customer_email).toBe(other.email);
    expect(foreignAfter.host_email).toBe(other.email);
  });
});

describe('workflow runs', () => {
  const formatBoolean = value => require('../../src/utils/dbCompat').formatBoolean(value);
  let workflowId;

  beforeAll(async () => {
    const flag = await db('feature_flags').where({ key: 'workflows' }).first();
    if (flag) await db('feature_flags').where({ key: 'workflows' }).update({ value: formatBoolean(true) });
    else await db('feature_flags').insert({ key: 'workflows', value: formatBoolean(true) });
    require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
    const [row] = await db('workflows').insert({ name: 'welcome later', version: 1, trigger_type: 'customer.created',
      enabled: formatBoolean(true), created_by: adminId }).returning('id');
    workflowId = idOf(row);
    await db('workflow_nodes').insert([
      { workflow_id: workflowId, version: 1, node_key: 'a', type: 'trigger', config: '{}' },
      { workflow_id: workflowId, version: 1, node_key: 'b', type: 'wait', config: JSON.stringify({ delayDays: 1 }) },
      { workflow_id: workflowId, version: 1, node_key: 'c', type: 'action',
        config: JSON.stringify({ action: 'send_email', recipientClass: 'customer' }) },
    ]);
    await db('workflow_edges').insert([
      { workflow_id: workflowId, version: 1, from_node: 'a', to_node: 'b' },
      { workflow_id: workflowId, version: 1, from_node: 'b', to_node: 'c' },
    ]);
  });

  async function waitingRunFor(email) {
    const { id } = await require('../../src/services/customerAccountsService')
      .createDirect({ email, prefill: { displayName: 'Wanda Waiting' }, createdByAdminId: adminId });
    const run = await db('workflow_runs').where({ workflow_id: workflowId, entity_type: 'customer', entity_id: id }).first();
    expect(run.status).toBe('waiting');
    return { customerId: id, runId: run.id };
  }

  async function wake(...runIds) {
    await db('workflow_runs').whereIn('id', runIds).where({ status: 'waiting' }).update({ wake_at: new Date(Date.now() - 60000).toISOString() });
    return require('../../src/services/workflows/engine').runDueWaits();
  }

  test('erasure cancels the customer\'s waiting run and removes the address it copied', async () => {
    const email = 'wf-erase@example.test';
    const { customerId, runId } = await waitingRunFor(email);
    const [approval] = await db('workflow_approvals').insert({ run_id: runId, node_key: 'b', status: 'pending',
      token_hash: crypto.randomBytes(32).toString('hex'), payload: JSON.stringify({ prompt: null, vars: { customerEmail: email } }) })
      .returning('id');
    const [expired] = await db('workflow_approvals').insert({ run_id: runId, node_key: 'b', status: 'expired',
      token_hash: crypto.randomBytes(32).toString('hex'), payload: JSON.stringify({ prompt: null, vars: {} }) }).returning('id');

    await require('../../src/services/customerAccountsService').eraseCustomer(customerId, adminId);

    const run = await db('workflow_runs').where({ id: runId }).first();
    expect(run.status).toBe('cancelled');
    expect(JSON.stringify(run.context)).not.toContain(email);
    const approvalAfter = await db('workflow_approvals').where({ id: idOf(approval) }).first();
    expect(approvalAfter.status).toBe('cancelled');
    expect(JSON.stringify(approvalAfter.payload)).not.toContain(email);
    expect((await db('workflow_approvals').where({ id: idOf(expired) }).first()).status).toBe('cancelled');

    expect(await wake(runId)).toBe(0);
    expect(await db('email_queue').whereRaw('LOWER(recipient_email) = ?', [email])).toHaveLength(0);
    const steps = await db('workflow_run_steps').where({ run_id: runId });
    expect(JSON.stringify(steps)).not.toContain(email);
  });

  test('another customer\'s run is left alone', async () => {
    const keep = await waitingRunFor('wf-keep@example.test');
    const erase = await waitingRunFor('wf-gone@example.test');
    await require('../../src/services/customerAccountsService').eraseCustomer(erase.customerId, adminId);
    const kept = await db('workflow_runs').where({ id: keep.runId }).first();
    expect(kept.status).toBe('waiting');
    expect(JSON.stringify(kept.context)).toContain('wf-keep@example.test');
  });

  test('a run the erasure cancels while it is being advanced stays cancelled', async () => {
    const registry = require('../../src/services/workflows/registry');
    const engine = require('../../src/services/workflows/engine');
    // Stands in for an erasure committing between two steps of this run.
    registry.registerAction('erase_fixture', async ctx => {
      await db.transaction(trx => engine.forgetCustomer(trx, ctx.vars.customerAccountId, { email: ctx.vars.customerEmail }));
      return { sent_to: ctx.vars.customerEmail };
    });
    const [row] = await db('workflows').insert({ name: 'erased mid-run', version: 1, trigger_type: 'crm.erase.fixture',
      enabled: formatBoolean(true), created_by: adminId }).returning('id');
    const id = idOf(row);
    await db('workflow_nodes').insert([
      { workflow_id: id, version: 1, node_key: 'a', type: 'trigger', config: '{}' },
      { workflow_id: id, version: 1, node_key: 'b', type: 'action', config: JSON.stringify({ action: 'erase_fixture' }) },
      { workflow_id: id, version: 1, node_key: 'c', type: 'action', config: JSON.stringify({ action: 'noop' }) },
    ]);
    await db('workflow_edges').insert([
      { workflow_id: id, version: 1, from_node: 'a', to_node: 'b' },
      { workflow_id: id, version: 1, from_node: 'b', to_node: 'c' },
    ]);
    const someone = await customer();
    const [runId] = await engine.emitWorkflowEvent('crm.erase.fixture', {
      entityType: 'customer', entityId: someone.id, payload: { customerAccountId: someone.id, customerEmail: someone.email },
    });
    const run = await db('workflow_runs').where({ id: runId }).first();
    expect(run.status).toBe('cancelled');
    expect(JSON.stringify(run.context)).not.toContain(someone.email);
    expect(await db('workflow_run_steps').where({ run_id: runId, node_key: 'c' })).toHaveLength(0);
    expect(JSON.stringify(await db('workflow_run_steps').where({ run_id: runId }))).not.toContain(someone.email);
  });

  async function runOf(trigger, graph, emit) {
    const [row] = await db('workflows').insert({ name: trigger, version: 1, trigger_type: trigger,
      enabled: formatBoolean(true), created_by: adminId }).returning('id');
    const id = idOf(row);
    await db('workflow_nodes').insert(graph.map(([key, type, config]) => ({ workflow_id: id, version: 1,
      node_key: key, type, config: JSON.stringify(config) })));
    await db('workflow_edges').insert(graph.slice(1).map(([key], i) => ({ workflow_id: id, version: 1,
      from_node: graph[i][0], to_node: key })));
    const [runId] = await require('../../src/services/workflows/engine').emitWorkflowEvent(trigger, emit);
    return runId;
  }

  test('a run whose trigger gave no customer address mails nobody', async () => {
    const someone = await customer();
    const runId = await runOf('crm.nomail.fixture', [['a', 'trigger', {}], ['b', 'action', { action: 'send_email', recipientClass: 'customer' }]],
      { entityType: 'customer', entityId: someone.id, payload: { customerAccountId: someone.id, customerEmail: null } });
    expect(await db('email_queue').whereRaw('LOWER(recipient_email) = ?', [someone.email])).toHaveLength(0);
    const step = await db('workflow_run_steps').where({ run_id: runId, node_key: 'b' }).first();
    expect(json(step.result)).toEqual(expect.objectContaining({ skipped: true }));
  });

  test('runs that carry the address but are someone else\'s stay', async () => {
    const erased = await customer();
    const other = await customer();
    const unassigned = await galleryFromQuote(other.id);
    const wait = [['a', 'trigger', {}], ['b', 'wait', { delayDays: 1 }]];
    const otherCustomersRun = await runOf('crm.other.fixture', wait,
      { entityType: 'quote', entityId: 1, payload: { customerAccountId: other.id, customerEmail: erased.email } });
    const foreignGalleryRun = await runOf('crm.gallery.fixture', wait,
      { entityType: 'event', entityId: unassigned, payload: { customerEmail: erased.email } });
    await require('../../src/services/customerAccountsService').eraseCustomer(erased.id, adminId);
    for (const runId of [otherCustomersRun, foreignGalleryRun]) {
      expect((await db('workflow_runs').where({ id: runId }).first()).status).toBe('waiting');
    }
  });

  test('send_email reads the customer as they are when it runs', async () => {
    const moved = await waitingRunFor('wf-old@example.test');
    await db('customer_accounts').where({ id: moved.customerId }).update({ email: 'wf-new@example.test' });
    const paused = await waitingRunFor('wf-paused@example.test');
    await db('customer_accounts').where({ id: paused.customerId }).update({ is_active: formatBoolean(false) });

    expect(await wake(moved.runId, paused.runId)).toBe(2);

    const to = async address => db('email_queue').whereRaw('LOWER(recipient_email) = ?', [address]);
    expect(await to('wf-old@example.test')).toHaveLength(0);
    expect(await to('wf-new@example.test')).toHaveLength(1);
    expect(await to('wf-paused@example.test')).toHaveLength(0);
    const step = await db('workflow_run_steps').where({ run_id: paused.runId, node_key: 'c' }).first();
    expect(json(step.result)).toEqual(expect.objectContaining({ skipped: true }));
  });

  test('send_email keeps the run\'s address while it is still one of the account\'s own', async () => {
    require('../../src/services/workflows'); // registers send_email
    const mail = [['a', 'trigger', {}], ['b', 'action', { action: 'send_email', recipientClass: 'customer' }]];
    const to = async address => db('email_queue').whereRaw('LOWER(recipient_email) = ?', [address]);
    const sendTo = async (trigger, someone, customerEmail) => runOf(trigger, mail,
      { entityType: 'invoice', entityId: 1, payload: { customerAccountId: someone.id, customerEmail } });

    // The billing address an invoice trigger chose, in another case and padded.
    const billed = await customer();
    await db('customer_accounts').where({ id: billed.id }).update({ billing_email: 'wf-books@example.test' });
    await sendTo('crm.billing.fixture', billed, '  WF-Books@Example.test ');
    expect(await to('wf-books@example.test')).toHaveLength(1);
    expect(await to(billed.email)).toHaveLength(0);

    // An active contact's address stays; an inactive contact's falls back.
    const withContacts = await customer();
    await db('customer_contacts').insert([
      { customer_account_id: withContacts.id, email: 'wf-contact@example.test', is_active: formatBoolean(true) },
      { customer_account_id: withContacts.id, email: 'wf-gone-contact@example.test', is_active: formatBoolean(false) },
    ]);
    await sendTo('crm.contact.fixture', withContacts, 'wf-contact@example.test');
    await sendTo('crm.gone-contact.fixture', withContacts, 'wf-gone-contact@example.test');
    expect(await to('wf-contact@example.test')).toHaveLength(1);
    expect(await to('wf-gone-contact@example.test')).toHaveLength(0);
    expect(await to(withContacts.email)).toHaveLength(1);

    // An address the account no longer has falls back to its primary one.
    const changed = await customer();
    await sendTo('crm.stale-billing.fixture', changed, 'wf-old-books@example.test');
    expect(await to('wf-old-books@example.test')).toHaveLength(0);
    expect(await to(changed.email)).toHaveLength(1);
  });
});
