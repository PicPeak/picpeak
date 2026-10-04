/**
 * Workflow approval links have a bounded, server-enforced lifetime.
 *
 * Before: a gate with no timeoutDays (the editor calls it optional, the
 * shipped seeds omit it) stored expires_at = NULL, and both the public
 * interstitial and finalization treated NULL as never expiring, so the
 * emailed bearer link could resume the run indefinitely. Now a missing, zero
 * or invalid timeout gets a 14-day default, the configured value is capped at
 * 90 days, and a NULL expiry on an existing row fails closed.
 * Scanner finding 1065a3a1.
 */
const { bootCrmDb } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let engine;
const calls = { confirm: 0 };
const DAY = 86400000;

async function makeWorkflow({ trigger, gateConfig }) {
  const ins = await db('workflows').insert({ name: 'wf', trigger_type: trigger, version: 1, enabled: true });
  const workflowId = ins[0];
  const nodes = [
    { key: 't', type: 'trigger' },
    { key: 'g', type: 'gate', config: gateConfig },
    { key: 'c', type: 'action', config: { action: 'lifetime_confirm' } },
  ];
  for (const n of nodes) {
    await db('workflow_nodes').insert({
      workflow_id: workflowId, version: 1, node_key: n.key, type: n.type, config: JSON.stringify(n.config || {}),
    });
  }
  for (const e of [{ from: 't', to: 'g' }, { from: 'g', handle: 'confirm', to: 'c' }]) {
    await db('workflow_edges').insert({
      workflow_id: workflowId, version: 1, from_node: e.from, from_handle: e.handle || null, to_node: e.to, loop_back: false,
    });
  }
}

async function pendingGate(trigger, gateConfig) {
  await makeWorkflow({ trigger, gateConfig });
  const [runId] = await engine.emitWorkflowEvent(trigger, {
    entityType: 'invoice', entityId: 7, payload: { adminEmail: 'admin@example.com' },
  });
  const approval = await db('workflow_approvals').where({ run_id: runId, status: 'pending' }).first();
  expect(approval).toBeTruthy();
  return { runId, approval };
}

const daysFromNow = (iso) => (new Date(iso).getTime() - Date.now()) / DAY;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  engine = require('../../src/services/workflows');
  require('../../src/services/workflows/registry').registerAction('lifetime_confirm', async () => { calls.confirm += 1; return {}; });
  await db('feature_flags').insert({ key: 'workflows', value: true });
});

afterAll(async () => { if (cleanup) await cleanup(); });
beforeEach(() => { calls.confirm = 0; });

describe('approval lifetime is bounded on the server', () => {
  test.each([
    ['missing', {}],
    ['zero', { timeoutDays: 0 }],
    ['negative', { timeoutDays: -3 }],
    ['not a number', { timeoutDays: 'soon' }],
  ])('a gate whose timeout is %s gets the 14-day default', async (label, extra) => {
    const { approval } = await pendingGate(`lifetime.default.${label.replace(/\s/g, '_')}`, { prompt: 'Confirm?', ...extra });
    expect(approval.expires_at).not.toBeNull();
    expect(daysFromNow(approval.expires_at)).toBeCloseTo(14, 1);
  });

  test('a configured timeout is honoured up to the 90-day cap', async () => {
    const { approval: short } = await pendingGate('lifetime.short', { timeoutDays: 3 });
    expect(daysFromNow(short.expires_at)).toBeCloseTo(3, 1);
    const { approval: long } = await pendingGate('lifetime.long', { timeoutDays: 400 });
    expect(daysFromNow(long.expires_at)).toBeCloseTo(90, 1);
  });

  test('an existing pending row with a NULL expiry fails closed at preview and finalization', async () => {
    const { runId, approval } = await pendingGate('lifetime.null');
    await db('workflow_approvals').where({ id: approval.id }).update({ expires_at: null });
    // The raw token is only ever emailed; drive the public paths through a
    // token whose hash we control.
    const raw = 'f'.repeat(64);
    await db('workflow_approvals').where({ id: approval.id }).update({ token_hash: engine.hashToken(raw) });

    expect(await engine.peekApproval(raw)).toMatchObject({ found: true, status: 'pending', expired: true });
    expect(await engine.actByToken(raw, 'confirm')).toEqual({ ok: false, reason: 'expired' });
    expect(calls.confirm).toBe(0);
    expect((await db('workflow_approvals').where({ id: approval.id }).first()).status).toBe('expired');
    expect((await db('workflow_runs').where({ id: runId }).first()).status).toBe('waiting');
  });

  test('a link within its lifetime still confirms', async () => {
    const { runId, approval } = await pendingGate('lifetime.live');
    const raw = 'e'.repeat(64);
    await db('workflow_approvals').where({ id: approval.id }).update({ token_hash: engine.hashToken(raw) });
    expect(await engine.actByToken(raw, 'confirm')).toEqual({ ok: true, status: 'confirmed' });
    expect(calls.confirm).toBe(1);
    expect((await db('workflow_runs').where({ id: runId }).first()).status).toBe('done');
  });

  test('the admin inbox can still decide an approval whose link has run out', async () => {
    // The lifetime bounds the emailed bearer, not the run: a gate that waits
    // longer than the default must stay decidable from the authenticated
    // inbox, and stay listed there.
    const { runId, approval } = await pendingGate('lifetime.inbox');
    await db('workflow_approvals').where({ id: approval.id })
      .update({ expires_at: new Date(Date.now() - DAY).toISOString() });
    expect((await engine.listPending()).map((a) => a.id)).toContain(approval.id);

    expect(await engine.actById(approval.id, 'confirm', 1)).toEqual({ ok: true, status: 'confirmed' });
    expect(calls.confirm).toBe(1);
    expect((await db('workflow_runs').where({ id: runId }).first()).status).toBe('done');
  });

  test('an approval a late link click marked expired stays in the inbox and decidable there', async () => {
    const { runId, approval } = await pendingGate('lifetime.inbox_after_link');
    const raw = 'd'.repeat(64);
    await db('workflow_approvals').where({ id: approval.id })
      .update({ token_hash: engine.hashToken(raw), expires_at: new Date(Date.now() - DAY).toISOString() });
    expect(await engine.actByToken(raw, 'confirm')).toEqual({ ok: false, reason: 'expired' });
    expect((await db('workflow_approvals').where({ id: approval.id }).first()).status).toBe('expired');
    expect((await engine.listPending()).map((a) => a.id)).toContain(approval.id);

    expect(await engine.actById(approval.id, 'deny', 1)).toEqual({ ok: true, status: 'denied' });
    expect(calls.confirm).toBe(0);
    expect((await db('workflow_runs').where({ id: runId }).first()).status).not.toBe('waiting');
    // A second decision from anywhere is answered as already decided.
    expect(await engine.actById(approval.id, 'confirm', 1)).toMatchObject({ ok: true, already: true, status: 'denied' });
  });
});
