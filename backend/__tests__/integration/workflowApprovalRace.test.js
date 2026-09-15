/**
 * A workflow gate is decided once.
 *
 * The emailed confirm/deny links, the admin inbox and a double click can all
 * act on one approval at the same moment. finalizeApproval read the pending
 * status and then updated unconditionally, and resumeRun did the same for the
 * waiting run, so two concurrent decisions both resumed it: confirm and deny
 * each ran their branch, or one branch ran twice (a document sent twice).
 */
const { bootCrmDb } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let engine;
let registry;
const calls = { confirm: 0, deny: 0 };

async function makeWorkflow({ nodes, edges, trigger }) {
  const ins = await db('workflows').insert({ name: 'wf', trigger_type: trigger, version: 1, enabled: true });
  const workflowId = ins[0];
  for (const n of nodes) {
    await db('workflow_nodes').insert({
      workflow_id: workflowId, version: 1, node_key: n.key, type: n.type,
      config: JSON.stringify(n.config || {}),
    });
  }
  for (const e of edges) {
    await db('workflow_edges').insert({
      workflow_id: workflowId, version: 1, from_node: e.from, from_handle: e.handle || null, to_node: e.to,
      loop_back: false,
    });
  }
  return workflowId;
}

async function pendingGate(trigger) {
  await makeWorkflow({
    trigger,
    nodes: [
      { key: 't', type: 'trigger' },
      { key: 'g', type: 'gate', config: { type: 'payment_confirm', prompt: 'Confirm?' } },
      { key: 'c', type: 'action', config: { action: 'race_confirm' } },
      { key: 'd', type: 'action', config: { action: 'race_deny' } },
    ],
    edges: [
      { from: 't', to: 'g' },
      { from: 'g', handle: 'confirm', to: 'c' },
      { from: 'g', handle: 'deny', to: 'd' },
    ],
  });
  const [runId] = await engine.emitWorkflowEvent(trigger, {
    entityType: 'invoice', entityId: 7, payload: { adminEmail: 'admin@example.com' },
  });
  const approval = await db('workflow_approvals').where({ run_id: runId, status: 'pending' }).first();
  expect(approval).toBeTruthy();
  return { runId, approval };
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  engine = require('../../src/services/workflows');
  registry = require('../../src/services/workflows/registry');
  registry.registerAction('race_confirm', async () => { calls.confirm += 1; return {}; });
  registry.registerAction('race_deny', async () => { calls.deny += 1; return {}; });
  await db('feature_flags').insert({ key: 'workflows', value: true });
});

afterAll(async () => { if (cleanup) await cleanup(); });

beforeEach(() => { calls.confirm = 0; calls.deny = 0; });

describe('workflow gate decisions under concurrent requests', () => {
  test('confirm and deny at the same time run exactly one branch', async () => {
    const { runId, approval } = await pendingGate('race.confirm_deny');

    const results = await Promise.all([
      engine.actById(approval.id, 'confirm', null),
      engine.actById(approval.id, 'deny', null),
    ]);

    expect(calls.confirm + calls.deny).toBe(1);
    expect(results.filter((r) => r.already)).toHaveLength(1);
    const winner = results.find((r) => !r.already);
    const stored = await db('workflow_approvals').where({ id: approval.id }).first();
    expect(stored.status).toBe(winner.status);
    expect(calls[winner.status === 'confirmed' ? 'confirm' : 'deny']).toBe(1);
    expect((await db('workflow_runs').where({ id: runId }).first()).status).toBe('done');
  });

  test('a repeated confirm resumes the run once', async () => {
    const { approval } = await pendingGate('race.double_confirm');

    const results = await Promise.all([1, 2, 3].map(() => engine.actById(approval.id, 'confirm', null)));

    expect(calls.confirm).toBe(1);
    expect(calls.deny).toBe(0);
    expect(results.filter((r) => r.already)).toHaveLength(2);
  });

  test('two resumes of one waiting run advance it once', async () => {
    const { runId } = await pendingGate('race.resume');
    const workflowEngine = require('../../src/services/workflows/engine');

    await Promise.all([
      workflowEngine.resumeRun(runId, { decisionHandle: 'confirm' }),
      workflowEngine.resumeRun(runId, { decisionHandle: 'confirm' }),
    ]);

    expect(calls.confirm).toBe(1);
    expect((await db('workflow_runs').where({ id: runId }).first()).status).toBe('done');
  });
});
