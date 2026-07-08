/**
 * Workflow execution engine — walks a flow GRAPH (nodes + edges) per run.
 *
 * Node types: trigger | condition/branch | loop | wait | gate | action | webhook.
 * - condition/branch: run a registered condition → follow the yes/no edge.
 * - loop: increment a per-node counter in run.context → follow loop/exit edge
 *   (bounded by config.maxIterations — no infinite runs).
 * - wait: set status='waiting' + wake_at; the scheduler resumes it later.
 * - gate: set status='waiting'; an approval (email confirm/deny or the webview
 *   inbox) resumes it via the matching confirm/deny edge.
 * - action/webhook: dispatch to a registered action handler.
 *
 * Runs are idempotent (unique dedup_key per trigger+entity) and every node
 * writes a workflow_run_steps row for observability / System Health. Designed
 * to be called AFTER the caller's DB commit (emit never throws into callers).
 */
const { db } = require('../../database/db');
const logger = require('../../utils/logger');
const registry = require('./registry');

const MAX_STEPS_PER_ADVANCE = 200;

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (e) { return fallback; }
}

async function loadGraph(workflowId, version) {
  const nodes = await db('workflow_nodes').where({ workflow_id: workflowId, version });
  const edges = await db('workflow_edges').where({ workflow_id: workflowId, version });
  const nodeByKey = new Map(nodes.map((n) => [n.node_key, { ...n, config: parseJson(n.config, {}) }]));
  return { nodeByKey, edges };
}

// Pick the outgoing edge from `fromNode`. With a handle, prefer the matching
// handle; otherwise fall back to a default (null-handle) edge or the sole edge.
function outEdge(edges, fromNode, handle) {
  const candidates = edges.filter((e) => e.from_node === fromNode);
  if (handle != null) {
    const exact = candidates.find((e) => (e.from_handle || null) === handle);
    if (exact) return exact;
  }
  return candidates.find((e) => e.from_handle == null) || (candidates.length === 1 ? candidates[0] : null);
}

function computeWakeAt(config = {}, vars = {}) {
  const cfg = config || {};
  const ms = (Number(cfg.delayDays || 0) * 86400000)
    + (Number(cfg.delayHours || 0) * 3600000)
    + (Number(cfg.delayMinutes || 0) * 60000);
  // Anchor to a context var when given (e.g. dueDate), plus any delay offset —
  // so `{ untilVar: 'dueDate', delayDays: 7 }` means "due date + 7 days"
  // (absolute), and an already-past anchor resumes immediately. Backward
  // compatible: untilVar-only → the var; delay-only → now + delay. Behaviour
  // change for the both-fields case (untilVar + delay): previously the delay was
  // ignored and only the var returned; now they add (this is the intended
  // waitGrace semantics — no seeded node relied on the old both-fields path).
  const base = (cfg.untilVar && vars[cfg.untilVar]) ? new Date(vars[cfg.untilVar]) : new Date();
  return new Date(base.getTime() + ms).toISOString();
}

function gateTimeout(config = {}) {
  const days = Number((config || {}).timeoutDays || 0);
  return days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null;
}

function matchFilter(filter, payload) {
  if (!filter || typeof filter !== 'object') return true;
  const { field, op = 'eq', value } = filter;
  const actual = payload ? payload[field] : undefined;
  // Strict equality: a filter {value: 0} must NOT match false/''/null (loose ==
  // conflated them). Authors must therefore match the payload's actual type.
  switch (op) {
    case 'neq': return actual !== value;
    case 'truthy': return Boolean(actual);
    case 'falsy': return !actual;
    case 'eq':
    default: return actual === value;
  }
}

async function recordStep(runId, node, status, result, error) {
  await db('workflow_run_steps').insert({
    run_id: runId,
    node_key: node.node_key,
    node_type: node.type,
    status,
    result: result ? JSON.stringify(result) : null,
    error: error || null,
    finished_at: db.fn.now(),
  });
}

async function failRun(runId, error) {
  await db('workflow_runs').where({ id: runId }).update({ status: 'failed', error, finished_at: db.fn.now() });
  logger.error('[workflow] run failed', { runId, error });
}

async function finishRun(runId) {
  await db('workflow_runs').where({ id: runId }).update({ status: 'done', finished_at: db.fn.now() });
}

/**
 * Walk the graph from the run's current node until it ends, fails, or pauses
 * (wait / gate). Persists context + current_node after each node.
 */
async function advanceRun(runId) {
  let run = await db('workflow_runs').where({ id: runId }).first();
  if (!run || run.status !== 'running') return;
  const { nodeByKey, edges } = await loadGraph(run.workflow_id, run.version);
  const context = parseJson(run.context, { vars: {} });
  if (!context.vars) context.vars = {};

  let currentKey = run.current_node;
  let steps = 0;

  while (currentKey) {
    if (++steps > MAX_STEPS_PER_ADVANCE) { await failRun(runId, 'max steps per advance exceeded'); return; }
    const node = nodeByKey.get(currentKey);
    if (!node) { await failRun(runId, `node not found: ${currentKey}`); return; }

    const ctx = { run, node, vars: context.vars, db, logger };
    let nextKey = null;

    try {
      switch (node.type) {
        case 'trigger': {
          const e = outEdge(edges, currentKey, null);
          nextKey = e ? e.to_node : null;
          await recordStep(runId, node, 'done', null);
          break;
        }
        case 'condition':
        case 'branch': {
          const cond = registry.getCondition(node.config?.condition || 'expr');
          const result = cond ? await cond(ctx) : false;
          const handle = result ? (node.config?.trueHandle || 'yes') : (node.config?.falseHandle || 'no');
          const e = outEdge(edges, currentKey, handle) || outEdge(edges, currentKey, result ? 'true' : 'false');
          nextKey = e ? e.to_node : null;
          await recordStep(runId, node, 'done', { result, handle });
          break;
        }
        case 'loop': {
          const counterKey = `__loop_${node.node_key}`;
          const count = (Number(context.vars[counterKey]) || 0) + 1;
          context.vars[counterKey] = count;
          const max = Number(node.config?.maxIterations ?? node.config?.max ?? 3);
          const handle = count > max ? (node.config?.exitHandle || 'exit') : (node.config?.loopHandle || 'loop');
          const e = outEdge(edges, currentKey, handle);
          nextKey = e ? e.to_node : null;
          await recordStep(runId, node, 'done', { count, max, handle });
          break;
        }
        case 'wait': {
          // Dry-run (test-fire): don't park — pass straight through so the whole
          // flow runs in one shot, recording what it WOULD have waited for.
          if (context.vars.__dryRun) {
            const e = outEdge(edges, currentKey, null);
            nextKey = e ? e.to_node : null;
            await recordStep(runId, node, 'skipped', { dryRun: true, wouldWaitUntil: computeWakeAt(node.config, context.vars) });
            break;
          }
          const wakeAt = computeWakeAt(node.config, context.vars);
          await db('workflow_runs').where({ id: runId })
            .update({ status: 'waiting', wake_at: wakeAt, current_node: currentKey, context: JSON.stringify(context) });
          await recordStep(runId, node, 'waiting', { wake_at: wakeAt });
          return; // paused — scheduler resumes when wake_at passes
        }
        case 'gate': {
          // Dry-run (test-fire): auto-take the 'confirm' path so the escalation
          // is exercised end-to-end, without creating an approval / emailing.
          if (context.vars.__dryRun) {
            const e = outEdge(edges, currentKey, 'confirm') || outEdge(edges, currentKey, null);
            nextKey = e ? e.to_node : null;
            await recordStep(runId, node, 'skipped', { dryRun: true, gateAutoConfirm: true });
            break;
          }
          await db('workflow_runs').where({ id: runId })
            .update({ status: 'waiting', wake_at: gateTimeout(node.config), current_node: currentKey, context: JSON.stringify(context) });
          await recordStep(runId, node, 'waiting', { gate: true });
          // Optional setup hook (create approval + send admin email) — registered
          // by the approval phase. Engine still pauses cleanly without it.
          const setup = registry.getAction('gate_setup');
          if (setup) {
            try { await setup(ctx); } catch (e) { logger.error('[workflow] gate setup failed', { runId, error: e.message }); }
          }
          return; // paused — an approval (email or inbox) resumes via resumeRun
        }
        case 'action':
        case 'webhook': {
          const actionKey = node.config?.action || (node.type === 'webhook' ? 'webhook' : 'noop');
          const action = registry.getAction(actionKey);
          const result = action ? (await action(ctx)) || {} : { skipped: true, reason: `unknown action ${actionKey}` };
          if (result.set && typeof result.set === 'object') Object.assign(context.vars, result.set);
          const e = outEdge(edges, currentKey, null);
          nextKey = e ? e.to_node : null;
          await recordStep(runId, node, result.skipped ? 'skipped' : 'done', result);
          break;
        }
        default: {
          await recordStep(runId, node, 'skipped', { reason: `unknown node type ${node.type}` });
          const e = outEdge(edges, currentKey, null);
          nextKey = e ? e.to_node : null;
        }
      }
    } catch (err) {
      await recordStep(runId, node, 'failed', null, err.message);
      await failRun(runId, `node ${currentKey} failed: ${err.message}`);
      return;
    }

    currentKey = nextKey;
    await db('workflow_runs').where({ id: runId }).update({ current_node: currentKey || null, context: JSON.stringify(context), updated_at: db.fn.now() });
  }

  await finishRun(runId);
}

/** Begin a freshly-created run at its trigger node. */
async function startRun(runId) {
  const run = await db('workflow_runs').where({ id: runId }).first();
  if (!run || ['done', 'failed', 'cancelled'].includes(run.status)) return;
  const { nodeByKey } = await loadGraph(run.workflow_id, run.version);
  let entry = null;
  for (const n of nodeByKey.values()) { if (n.type === 'trigger') { entry = n; break; } }
  if (!entry) { await failRun(runId, 'no trigger node'); return; }
  await db('workflow_runs').where({ id: runId }).update({ status: 'running', current_node: entry.node_key, updated_at: db.fn.now() });
  await advanceRun(runId);
}

/**
 * Resume a paused (waiting) run. For a wait node, pass no handle. For a gate,
 * pass decisionHandle = 'confirm' | 'deny' so the matching edge is taken.
 */
async function resumeRun(runId, { decisionHandle = null } = {}) {
  const run = await db('workflow_runs').where({ id: runId }).first();
  if (!run || run.status !== 'waiting') return;
  const { edges } = await loadGraph(run.workflow_id, run.version);
  // For a gate decision, the edge MUST match the handle exactly — we cannot fall
  // back to outEdge's "sole edge" heuristic, or a 'deny' with only a 'confirm'
  // edge would silently take the confirm path. A missing handle edge is a broken
  // graph → fail loudly (same posture as unknown nodes) so the lost decision is
  // visible in run history instead of masquerading as a green 'done'.
  let e;
  if (decisionHandle != null) {
    e = edges.find((x) => x.from_node === run.current_node && (x.from_handle || null) === decisionHandle);
    if (!e) {
      await failRun(runId, `gate decision '${decisionHandle}' has no matching edge from node '${run.current_node}'`);
      return;
    }
  } else {
    e = outEdge(edges, run.current_node, null);
  }
  const nextKey = e ? e.to_node : null;
  await db('workflow_runs').where({ id: runId }).update({ status: 'running', current_node: nextKey, wake_at: null, updated_at: db.fn.now() });
  if (!nextKey) { await finishRun(runId); return; }
  await advanceRun(runId);
}

/**
 * Entry point for lifecycle events. Creates one run per matching enabled
 * workflow (idempotent via dedup_key) and starts it. Never throws — safe to
 * call after a caller's commit. Fails CLOSED if the flag system is unavailable.
 */
async function emitWorkflowEvent(triggerType, { entityType = null, entityId = null, payload = {}, targetWorkflowId = null } = {}) {
  try {
    const { isFeatureEnabled } = require('../../middleware/requireFeatureFlag');
    let enabled = false;
    try { enabled = await isFeatureEnabled('workflows'); } catch (e) {
      logger.warn('[workflow] flag check failed — treating workflows as disabled', { error: e.message });
      return [];
    }
    if (!enabled) return [];

    // targetWorkflowId restricts the fan-out to a SINGLE chosen flow — used when
    // the entity explicitly selected which flow to run (e.g. a quote picks its
    // booking workflow). Still gated on enabled + matching trigger_type, so a
    // disabled/mismatched selection simply runs nothing.
    const q = db('workflows').where({ enabled: true, trigger_type: triggerType });
    if (targetWorkflowId != null) q.where({ id: targetWorkflowId });
    const workflows = await q;
    const runIds = [];
    for (const wf of workflows) {
      const tcfg = parseJson(wf.trigger_config, {});
      if (tcfg && tcfg.filter && !matchFilter(tcfg.filter, payload)) continue;

      const dedupKey = `${wf.id}:${wf.version}:${triggerType}:${entityType || ''}:${entityId || ''}`;
      const existing = await db('workflow_runs').where({ dedup_key: dedupKey }).first();
      if (existing) continue;

      try {
        await db('workflow_runs').insert({
          workflow_id: wf.id,
          version: wf.version,
          trigger_event: triggerType,
          entity_type: entityType,
          entity_id: entityId,
          status: 'pending',
          context: JSON.stringify({ vars: { ...payload } }),
          dedup_key: dedupKey,
        });
      } catch (e) {
        continue; // unique race — another emitter created it
      }
      const row = await db('workflow_runs').where({ dedup_key: dedupKey }).first();
      if (!row) continue;
      runIds.push(row.id);
      await startRun(row.id).catch((err) => logger.error('[workflow] start failed', { runId: row.id, error: err.message }));
    }
    return runIds;
  } catch (e) {
    logger.error('[workflow] emit failed', { triggerType, error: e.message });
    return [];
  }
}

/**
 * Resume runs whose wait has elapsed. Called from the cron scheduler tick.
 * Only advances `wait` nodes — gate timeouts are handled by the approvals
 * layer. Fails CLOSED if the workflows flag is off (master kill-switch).
 */
async function runDueWaits(limit = 100) {
  try {
    const { isFeatureEnabled } = require('../../middleware/requireFeatureFlag');
    let enabled = false;
    try { enabled = await isFeatureEnabled('workflows'); } catch (e) { return 0; }
    if (!enabled) return 0;

    const nowIso = new Date().toISOString();
    const due = await db('workflow_runs')
      .where({ status: 'waiting' })
      .whereNotNull('wake_at')
      .where('wake_at', '<=', nowIso)
      .limit(limit);

    let resumed = 0;
    for (const run of due) {
      try {
        const node = await db('workflow_nodes')
          .where({ workflow_id: run.workflow_id, version: run.version, node_key: run.current_node })
          .first();
        if (node && node.type === 'wait') {
          await resumeRun(run.id);
          resumed += 1;
        }
      } catch (err) {
        logger.error('[workflow] runDueWaits item failed', { runId: run.id, error: err.message });
      }
    }
    return resumed;
  } catch (e) {
    logger.error('[workflow] runDueWaits failed', { error: e.message });
    return 0;
  }
}

const RECOVERY_STALE_MS = 10 * 60 * 1000; // a 'running' run idle this long = orphaned by a crash
const MAX_RECOVERY_ATTEMPTS = 5;

/**
 * Resume runs orphaned by a crash. A run left in 'running'/'pending' has nothing
 * to resume it (the scheduler only wakes 'waiting'), so this sweep picks up ones
 * whose heartbeat (updated_at) has gone stale and re-enters them from their
 * persisted node. Re-entry is at-least-once: the current node may re-execute —
 * loop counters + the late-fee math are idempotent, so the only residual risk is
 * a duplicate reminder email. `attempts` caps recovery so a node that reliably
 * crashes the process is marked failed instead of looping forever. Flag-gated
 * (fails closed when workflows is off). Called from the scheduler tick + boot.
 */
async function recoverStaleRuns({ staleMs = RECOVERY_STALE_MS, limit = 50 } = {}) {
  try {
    const { isFeatureEnabled } = require('../../middleware/requireFeatureFlag');
    let enabled = false;
    try { enabled = await isFeatureEnabled('workflows'); } catch (e) { return 0; }
    if (!enabled) return 0;
    if (!(await db.schema.hasColumn('workflow_runs', 'updated_at'))) return 0;

    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const stale = await db('workflow_runs')
      .whereIn('status', ['running', 'pending'])
      .where('updated_at', '<=', cutoff)
      .limit(limit);

    let recovered = 0;
    for (const run of stale) {
      try {
        const attempts = Number(run.attempts) || 0;
        if (attempts >= MAX_RECOVERY_ATTEMPTS) {
          await failRun(run.id, `abandoned after ${attempts} recovery attempts (suspected crash loop)`);
          continue;
        }
        await db('workflow_runs').where({ id: run.id }).update({ attempts: attempts + 1, updated_at: db.fn.now() });
        if (!run.current_node) {
          await startRun(run.id);
        } else {
          await db('workflow_runs').where({ id: run.id }).update({ status: 'running', updated_at: db.fn.now() });
          await advanceRun(run.id);
        }
        recovered += 1;
      } catch (err) {
        logger.error('[workflow] recovery failed', { runId: run.id, error: err.message });
      }
    }
    return recovered;
  } catch (e) {
    logger.error('[workflow] recoverStaleRuns failed', { error: e.message });
    return 0;
  }
}

/**
 * True when the workflows flag is on AND a built-in flow with this key is
 * enabled. The hardcoded automations (reminder ladder, expiry emails, pre-event
 * reminders) call this to STAND DOWN when their engine flow is live — so the
 * engine and the legacy path never double-fire. Fails CLOSED (returns false) on
 * any error so the legacy path keeps running if the workflow subsystem is down.
 */
async function isBuiltinFlowActive(builtinKey) {
  try {
    const { isFeatureEnabled } = require('../../middleware/requireFeatureFlag');
    if (!(await isFeatureEnabled('workflows'))) return false;
    if (!(await db.schema.hasTable('workflows'))) return false;
    const wf = await db('workflows').where({ builtin_key: builtinKey, enabled: true }).first();
    return !!wf;
  } catch (e) {
    return false;
  }
}

/**
 * Enroll every open, unpaid invoice into the dunning flow by emitting
 * `invoice.sent` for it — called when the dunning built-in is turned ON so it
 * starts chasing invoices that were already sent, not only new ones (#750).
 * Idempotent: emitWorkflowEvent's per-(flow, entity) dedup means at most one
 * run per invoice, so re-enabling is safe. Paired with the due-date-anchored
 * grace wait, already-overdue invoices dun on their real timeline immediately.
 *
 * Scoped to `targetWorkflowId` (the dunning flow being enabled) so the backfill
 * only enrolls invoices into dunning — never into unrelated custom `invoice.sent`
 * flows an admin may have built, which would fire their actions for every
 * historical invoice.
 */
async function backfillDunningRuns(targetWorkflowId) {
  let enrolled = 0;
  try {
    if (!(await db.schema.hasTable('invoices'))) return 0;
    const invoices = await db('invoices')
      .whereIn('status', ['sent', 'overdue'])
      .whereNotNull('due_date')
      .whereRaw('COALESCE(paid_amount_minor, 0) < total_amount_minor');
    for (const inv of invoices) {
      const ids = await emitWorkflowEvent('invoice.sent', {
        entityType: 'invoice',
        entityId: inv.id,
        targetWorkflowId,
        payload: {
          invoiceId: inv.id,
          invoiceNumber: inv.invoice_number,
          eventId: inv.event_id || null,
          customerAccountId: inv.customer_account_id,
          dueDate: inv.due_date,
          issueDate: inv.issue_date,
          totalMinor: inv.total_amount_minor,
          currency: inv.currency,
        },
      });
      if (ids && ids.length) enrolled += 1;
    }
  } catch (e) {
    logger.error('[workflow] dunning backfill failed', { error: e.message });
  }
  return enrolled;
}

/**
 * Emit `event.date_approaching` for events entering an enabled flow's lead
 * window. This is the trigger source for the pre-event reminder built-in, so it
 * faithfully honours the same per-event controls the legacy eventReminderService
 * pass uses (migration 143): skips `event_reminder_disabled` events, skips ones
 * already sent (`event_reminder_sent_at`), and fires at `event_date − offset`
 * where offset = the event's `event_reminder_offset_days` override else the
 * flow's `daysBefore`. emitWorkflowEvent's per-(flow,entity) dedup_key keeps the
 * hourly sweep to a single run per event. Fails CLOSED when the flag is off.
 */
async function emitDueEventReminders(limit = 200) {
  try {
    const { isFeatureEnabled } = require('../../middleware/requireFeatureFlag');
    let enabled = false;
    try { enabled = await isFeatureEnabled('workflows'); } catch (e) { return 0; }
    if (!enabled) return 0;
    if (!(await db.schema.hasTable('events'))) return 0;

    const flows = await db('workflows').where({ enabled: true, trigger_type: 'event.date_approaching' });
    if (!flows.length) return 0;

    const { hasColumnCached } = require('../../utils/schemaCache');
    const hasReminderCols = await hasColumnCached('events', 'event_reminder_sent_at');

    // The admin heads-up resolves its recipient from ctx.vars.adminEmail; events
    // don't carry one, so source it from the business profile (best-effort).
    let adminEmail = null;
    try {
      if (await db.schema.hasTable('business_profile')) {
        const profile = await db('business_profile').where({ id: 1 }).first();
        adminEmail = profile?.email || null;
      }
    } catch (_) { /* best-effort */ }

    const now = Date.now();
    const todayIso = new Date(now).toISOString().slice(0, 10);
    let emitted = 0;
    for (const wf of flows) {
      const cfg = parseJson(wf.trigger_config, {});
      const daysBefore = Number(cfg.daysBefore) > 0 ? Number(cfg.daysBefore) : 3;
      // Surface every still-upcoming event up to the widest the offset could be;
      // the per-event triggerAt check below decides if it's actually due.
      const maxOffset = Math.max(daysBefore, 60);
      const windowEndIso = new Date(now + maxOffset * 86400000).toISOString().slice(0, 10);

      let q = db('events')
        .where('is_active', true)
        .where('is_archived', false)
        .whereNotNull('event_date')
        .where('event_date', '>=', todayIso)
        .where('event_date', '<=', windowEndIso);
      // Faithful to the legacy pass: never remind a disabled or already-sent event.
      if (hasReminderCols) {
        q = q.where('event_reminder_disabled', false).whereNull('event_reminder_sent_at');
      }
      const events = await q.limit(limit);

      for (const ev of events) {
        // A null/blank per-event offset means "use the flow's daysBefore" — guard
        // against Number(null)===0 silently making the reminder fire on the event day.
        const rawOffset = hasReminderCols ? ev.event_reminder_offset_days : null;
        const offset = (rawOffset != null && rawOffset !== '' && Number.isFinite(Number(rawOffset)))
          ? Number(rawOffset)
          : daysBefore;
        const ed = ev.event_date instanceof Date ? ev.event_date : new Date(ev.event_date);
        const triggerAt = ed.getTime() - offset * 86400000;
        if (now < triggerAt) continue; // not yet inside this event's lead window

        const runIds = await emitWorkflowEvent('event.date_approaching', {
          entityType: 'event',
          entityId: ev.id,
          payload: {
            eventId: ev.id,
            eventName: ev.event_name || null,
            eventDate: ev.event_date,
            eventType: ev.event_type || null,
            hostName: ev.host_name || null,
            customerEmail: ev.customer_email || ev.host_email || null,
            adminEmail,
            daysBefore: offset,
          },
        });
        emitted += runIds.length;
      }
    }
    return emitted;
  } catch (e) {
    logger.error('[workflow] emitDueEventReminders failed', { error: e.message });
    return 0;
  }
}

/**
 * Test-fire a workflow on demand (admin testing). Creates a run for the given
 * entity/payload and starts it. Defaults to dryRun: side-effecting actions are
 * mocked, waits pass through, and gates auto-take 'confirm' — so the WHOLE flow
 * runs in one shot and the step log shows exactly what it would do, without
 * sending real customer mail or charging fees.
 */
async function testRun(workflowId, { entityType = null, entityId = null, payload = {}, dryRun = true } = {}) {
  const wf = await db('workflows').where({ id: workflowId }).first();
  if (!wf) throw new Error('Workflow not found');
  const vars = { ...(payload || {}), __test: true };
  if (dryRun) vars.__dryRun = true;
  const dedupKey = `test:${workflowId}:${Date.now()}:${Math.round(Math.random() * 1e9)}`;
  await db('workflow_runs').insert({
    workflow_id: wf.id,
    version: wf.version,
    trigger_event: `test:${wf.trigger_type}`,
    entity_type: entityType,
    entity_id: entityId,
    status: 'pending',
    context: JSON.stringify({ vars }),
    dedup_key: dedupKey,
    updated_at: db.fn.now(),
  });
  const row = await db('workflow_runs').where({ dedup_key: dedupKey }).first();
  await startRun(row.id);
  return row.id;
}

module.exports = {
  emitWorkflowEvent,
  isBuiltinFlowActive,
  backfillDunningRuns,
  runDueWaits,
  emitDueEventReminders,
  recoverStaleRuns,
  testRun,
  startRun,
  advanceRun,
  resumeRun,
  finishRun,
  failRun,
  // exported for tests / introspection
  loadGraph,
  outEdge,
  computeWakeAt,
};
