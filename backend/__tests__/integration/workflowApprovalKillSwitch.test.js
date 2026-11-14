/**
 * The workflows feature flag is a master kill-switch: no run is created or
 * resumed while it is off. The public approval routes are refused while it is
 * off, like the other public document routes, and the engine holds the line
 * too: actByToken() and resumeRun() fail closed — the approval stays pending
 * and the run stays waiting until the flag is back on.
 */
const crypto = require('crypto');
const { bootCrmDb } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let engine;
let flags;
const calls = { confirm: 0 };

async function makeWorkflow(trigger) {
  const ins = await db('workflows').insert({ name: 'wf', trigger_type: trigger, version: 1, enabled: true });
  const workflowId = ins[0];
  const nodes = [
    { key: 't', type: 'trigger' },
    { key: 'g', type: 'gate', config: { prompt: 'Confirm?', timeoutDays: 7 } },
    { key: 'c', type: 'action', config: { action: 'kill_confirm' } },
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

async function pendingGate(trigger) {
  await setFlag(true);
  await makeWorkflow(trigger);
  const [runId] = await engine.emitWorkflowEvent(trigger, {
    entityType: 'invoice', entityId: 7, payload: { adminEmail: 'admin@example.com' },
  });
  const approval = await db('workflow_approvals').where({ run_id: runId, status: 'pending' }).first();
  expect(approval).toBeTruthy();
  // The raw token is only ever emailed; drive the public path through one whose hash we control.
  const raw = crypto.randomBytes(32).toString('hex');
  await db('workflow_approvals').where({ id: approval.id }).update({ token_hash: engine.hashToken(raw) });
  return { runId, approval, raw };
}

async function setFlag(on) {
  await db('feature_flags').where({ key: 'workflows' }).update({ value: on ? 1 : 0 });
  flags.invalidateFeatureFlagCache();
}

const state = async (runId, approvalId) => ({
  run: (await db('workflow_runs').where({ id: runId }).first()).status,
  approval: (await db('workflow_approvals').where({ id: approvalId }).first()).status,
});

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  engine = require('../../src/services/workflows');
  flags = require('../../src/middleware/requireFeatureFlag');
  require('../../src/services/workflows/registry').registerAction('kill_confirm', async () => { calls.confirm += 1; return {}; });
  await db('feature_flags').insert({ key: 'workflows', value: 1 });
});

afterAll(async () => { if (cleanup) await cleanup(); });
beforeEach(() => { calls.confirm = 0; jest.restoreAllMocks(); });

describe('workflows kill-switch holds for pending approvals', () => {
  test('a public decision while the flag is off changes nothing, and works again once it is on', async () => {
    const { runId, approval, raw } = await pendingGate('kill.public');
    await setFlag(false);

    expect(await engine.actByToken(raw, 'confirm')).toEqual({ ok: false, reason: 'disabled' });
    expect(await engine.actByToken(raw, 'deny')).toEqual({ ok: false, reason: 'disabled' });
    expect(calls.confirm).toBe(0);
    expect(await state(runId, approval.id)).toEqual({ run: 'waiting', approval: 'pending' });

    await setFlag(true);
    expect(await engine.actByToken(raw, 'confirm')).toEqual({ ok: true, status: 'confirmed' });
    expect(calls.confirm).toBe(1);
    expect(await state(runId, approval.id)).toEqual({ run: 'done', approval: 'confirmed' });
  });

  test('resumeRun() does not claim a waiting run while the flag is off', async () => {
    const { runId, approval } = await pendingGate('kill.resume');
    await setFlag(false);

    await require('../../src/services/workflows/engine').resumeRun(runId, { decisionHandle: 'confirm' });
    expect(calls.confirm).toBe(0);
    expect(await state(runId, approval.id)).toEqual({ run: 'waiting', approval: 'pending' });
  });

  test('a flag that flips between the decision and the resume leaves the approval pending', async () => {
    const { runId, approval, raw } = await pendingGate('kill.flip');
    // finalizeApproval reads the flag, records the decision, then resumeRun
    // reads it again: on, then off. The decision used to stay recorded on a
    // run nothing would ever resume.
    const spy = jest.spyOn(flags, 'isFeatureEnabled');
    spy.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect(await engine.actByToken(raw, 'confirm')).toEqual({ ok: false, reason: 'disabled' });
    expect(calls.confirm).toBe(0);
    expect(await state(runId, approval.id)).toEqual({ run: 'waiting', approval: 'pending' });

    spy.mockRestore();
    await setFlag(true);
    expect(await engine.actByToken(raw, 'confirm')).toEqual({ ok: true, status: 'confirmed' });
    expect(await state(runId, approval.id)).toEqual({ run: 'done', approval: 'confirmed' });
  });

  test('the public approval routes are refused while the flag is off', async () => {
    const request = require('supertest');
    const { buildRouteApp } = require('./helpers/crmDb');
    const app = buildRouteApp('/api/public/workflow-approvals', require('../../src/routes/publicWorkflowApprovals'));
    const { runId, approval, raw } = await pendingGate('kill.route');
    await setFlag(false);

    for (const res of [
      await request(app).get(`/api/public/workflow-approvals/${raw}/confirm`),
      await request(app).post(`/api/public/workflow-approvals/${raw}/confirm`),
    ]) {
      expect(res.status).toBe(403);
      expect(res.text).toContain('Workflows are disabled');
    }
    expect(calls.confirm).toBe(0);
    expect(await state(runId, approval.id)).toEqual({ run: 'waiting', approval: 'pending' });

    await setFlag(true);
    expect((await request(app).get(`/api/public/workflow-approvals/${raw}/confirm`)).status).toBe(200);
    expect((await request(app).post(`/api/public/workflow-approvals/${raw}/confirm`)).status).toBe(200);
    expect(await state(runId, approval.id)).toEqual({ run: 'done', approval: 'confirmed' });
  });

  test('a flag lookup failure fails closed', async () => {
    const { runId, approval, raw } = await pendingGate('kill.failure');
    jest.spyOn(flags, 'isFeatureEnabled').mockRejectedValue(new Error('db gone'));

    expect(await engine.actByToken(raw, 'confirm')).toEqual({ ok: false, reason: 'disabled' });
    expect(calls.confirm).toBe(0);
    expect(await state(runId, approval.id)).toEqual({ run: 'waiting', approval: 'pending' });
  });
});
