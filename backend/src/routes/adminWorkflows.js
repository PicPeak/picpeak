/**
 * Admin workflow management API.
 *
 *   GET    /api/admin/workflows                     list
 *   GET    /api/admin/workflows/approvals           pending-approval inbox
 *   POST   /api/admin/workflows/approvals/:id/:act  confirm|deny (webview)
 *   GET    /api/admin/workflows/runs/:runId/steps   run step audit
 *   GET    /api/admin/workflows/:id/runs            run history
 *   GET    /api/admin/workflows/:id                 one workflow + its graph
 *   POST   /api/admin/workflows                     create
 *   PUT    /api/admin/workflows/:id                 update (bumps version)
 *   PATCH  /api/admin/workflows/:id/enabled         enable/disable
 *   DELETE /api/admin/workflows/:id                 delete (built-ins refused)
 *
 * Versioning: editing writes a fresh node/edge set under version+1 and bumps
 * workflows.version; in-flight runs keep executing the version they pinned.
 * All endpoints gated by the `workflows` feature flag + RBAC (view/manage).
 */
const express = require('express');

const router = express.Router();
const { db } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const workflows = require('../services/workflows');
const { hasColumnCached } = require('../utils/schemaCache');

router.use(adminAuth, requireFeatureFlag('workflows'));

// Graph payload caps — a workflows.manage user shouldn't be able to DoS the DB
// with an enormous graph. Generous vs any real flow.
const MAX_NODES = 200;
const MAX_EDGES = 500;
const MAX_NODE_CONFIG_BYTES = 16 * 1024;
const VALID_NODE_TYPES = new Set(['trigger', 'action', 'condition', 'branch', 'loop', 'wait', 'gate', 'webhook']);

function parseJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return fallback; }
}

function validateGraph(body) {
  const nodes = Array.isArray(body.nodes) ? body.nodes : [];
  const edges = Array.isArray(body.edges) ? body.edges : [];
  if (nodes.length > MAX_NODES) return `Too many nodes (max ${MAX_NODES})`;
  if (edges.length > MAX_EDGES) return `Too many edges (max ${MAX_EDGES})`;
  const triggers = nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) return 'A workflow must have exactly one trigger node';
  if (nodes.some((n) => !n.node_key || !n.type)) return 'Every node needs a node_key and type';
  const badType = nodes.find((n) => !VALID_NODE_TYPES.has(n.type));
  if (badType) return `Unknown node type '${badType.type}'`;
  const oversized = nodes.find((n) => JSON.stringify(n.config || {}).length > MAX_NODE_CONFIG_BYTES);
  if (oversized) return `Node '${oversized.node_key}' config is too large (max ${MAX_NODE_CONFIG_BYTES} bytes)`;
  const keys = new Set(nodes.map((n) => n.node_key));
  if (keys.size !== nodes.length) return 'Duplicate node_key in graph';
  for (const e of edges) {
    if (!keys.has(e.from_node) || !keys.has(e.to_node)) return 'Edge references an unknown node';
  }
  return null;
}

// The unimplemented actions a graph references — any action node whose
// `config.action` has no registered handler. Used to refuse enabling a flow
// that would silently no-op at runtime (typo'd or future-but-unwired actions).
// Registry-driven so it can't drift from what the engine can actually run.
function unimplementedActionsIn(nodes = []) {
  const found = new Set();
  for (const n of nodes) {
    const action = n && n.type === 'action' && n.config && n.config.action;
    if (action && !workflows.registry.getAction(action)) found.add(action);
  }
  return [...found];
}

async function writeGraph(trx, workflowId, version, nodes = [], edges = []) {
  for (const n of nodes) {
    await trx('workflow_nodes').insert({
      workflow_id: workflowId, version, node_key: n.node_key, type: n.type,
      config: JSON.stringify(n.config || {}), pos_x: n.pos_x || 0, pos_y: n.pos_y || 0,
    });
  }
  for (const e of edges) {
    await trx('workflow_edges').insert({
      workflow_id: workflowId, version, from_node: e.from_node, from_handle: e.from_handle || null,
      to_node: e.to_node, label: e.label || null, loop_back: !!e.loop_back,
    });
  }
}

// --- Approvals inbox (registered before /:id so 'approvals' isn't an id) ---
router.get('/approvals', requirePermission('workflows.view'), async (req, res, next) => {
  try {
    const items = await workflows.listPending();
    res.json(items.map((a) => ({ ...a, payload: parseJson(a.payload, {}) })));
  } catch (e) { next(e); }
});

router.post('/approvals/:id/:action', requirePermission('workflows.manage'), async (req, res, next) => {
  try {
    const { action } = req.params;
    if (!['confirm', 'deny'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
    const result = await workflows.actById(Number(req.params.id), action, req.admin?.id);
    if (!result.ok && result.reason === 'not_found') return res.status(404).json({ error: 'Approval not found' });
    if (!result.ok && result.reason === 'expired') return res.status(410).json({ error: 'Approval expired' });
    res.json(result);
  } catch (e) { next(e); }
});

// --- Run history ---
router.get('/runs/:runId/steps', requirePermission('workflows.view'), async (req, res, next) => {
  try {
    const steps = await db('workflow_run_steps').where({ run_id: Number(req.params.runId) }).orderBy('id', 'asc');
    res.json(steps.map((s) => ({ ...s, result: parseJson(s.result, null) })));
  } catch (e) { next(e); }
});

router.get('/:id/runs', requirePermission('workflows.view'), async (req, res, next) => {
  try {
    const runs = await db('workflow_runs').where({ workflow_id: Number(req.params.id) }).orderBy('id', 'desc').limit(200);
    res.json(runs.map((r) => ({ ...r, context: parseJson(r.context, {}) })));
  } catch (e) { next(e); }
});

// Test-fire: run the workflow on demand (default dry-run — side effects mocked,
// waits skipped, gates auto-confirm) and return the step-by-step log.
router.post('/:id/test-run', requirePermission('workflows.manage'), async (req, res, next) => {
  try {
    const { entityType, entityId, payload, dryRun } = req.body || {};
    const runId = await workflows.testRun(Number(req.params.id), {
      entityType: entityType || null,
      entityId: entityId != null && entityId !== '' ? Number(entityId) : null,
      payload: payload && typeof payload === 'object' ? payload : {},
      dryRun: dryRun !== false, // default true (safe)
    });
    const run = await db('workflow_runs').where({ id: runId }).first();
    const steps = await db('workflow_run_steps').where({ run_id: runId }).orderBy('id', 'asc');
    res.json({
      runId,
      dryRun: dryRun !== false,
      status: run?.status,
      steps: steps.map((s) => ({ ...s, result: parseJson(s.result, null) })),
    });
  } catch (e) { next(e); }
});

// --- List / get ---
router.get('/', requirePermission('workflows.view'), async (req, res, next) => {
  try {
    const rows = await db('workflows').orderBy('id', 'desc');
    res.json(rows.map((w) => ({ ...w, trigger_config: parseJson(w.trigger_config, null) })));
  } catch (e) { next(e); }
});

router.get('/:id', requirePermission('workflows.view'), async (req, res, next) => {
  try {
    const wf = await db('workflows').where({ id: Number(req.params.id) }).first();
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const nodes = await db('workflow_nodes').where({ workflow_id: wf.id, version: wf.version });
    const edges = await db('workflow_edges').where({ workflow_id: wf.id, version: wf.version });
    res.json({
      ...wf,
      trigger_config: parseJson(wf.trigger_config, null),
      nodes: nodes.map((n) => ({ ...n, config: parseJson(n.config, {}) })),
      edges,
    });
  } catch (e) { next(e); }
});

// --- Create / update / toggle / delete ---
router.post('/', requirePermission('workflows.manage'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.trigger_type) return res.status(400).json({ error: 'name and trigger_type are required' });
    const err = validateGraph(b);
    if (err) return res.status(400).json({ error: err });
    if (b.enabled) {
      const stubs = unimplementedActionsIn(b.nodes);
      if (stubs.length) return res.status(409).json({ error: `This flow can't be enabled yet — it uses actions that aren't implemented: ${stubs.join(', ')}.` });
    }
    const id = await db.transaction(async (trx) => {
      const ins = await trx('workflows').insert({
        name: b.name, description: b.description || null, enabled: !!b.enabled, version: 1,
        trigger_type: b.trigger_type, trigger_config: b.trigger_config ? JSON.stringify(b.trigger_config) : null,
        created_by: req.admin?.id || null,
      }).returning('id');
      // Postgres returns [] without an explicit returning clause, so ins[0]
      // would be undefined → the child node inserts would violate NOT NULL.
      // Normalise the {id} (pg) vs bare id (sqlite) shapes.
      const newId = ins[0]?.id ?? ins[0];
      await writeGraph(trx, newId, 1, b.nodes, b.edges);
      return newId;
    });
    res.status(201).json({ id });
  } catch (e) { next(e); }
});

router.put('/:id', requirePermission('workflows.manage'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const wf = await db('workflows').where({ id }).first();
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const b = req.body || {};
    const err = validateGraph(b);
    if (err) return res.status(400).json({ error: err });
    const willEnable = b.enabled != null ? !!b.enabled : (wf.enabled === true || wf.enabled === 1);
    if (willEnable) {
      const stubs = unimplementedActionsIn(b.nodes);
      if (stubs.length) return res.status(409).json({ error: `This flow can't be enabled yet — it uses actions that aren't implemented: ${stubs.join(', ')}.` });
    }
    const newVersion = wf.version + 1;
    const hasAdminToggled = await hasColumnCached('workflows', 'admin_toggled_at');
    await db.transaction(async (trx) => {
      const update = {
        name: b.name ?? wf.name,
        description: b.description ?? wf.description,
        enabled: b.enabled != null ? !!b.enabled : wf.enabled,
        trigger_type: b.trigger_type ?? wf.trigger_type,
        trigger_config: b.trigger_config !== undefined
          ? (b.trigger_config ? JSON.stringify(b.trigger_config) : null)
          : wf.trigger_config,
        version: newVersion,
        updated_at: trx.fn.now(),
      };
      // An admin edit claims ownership of a built-in so the boot seeder stops
      // re-seeding / re-enabling it (see _workflowSeedBoot).
      if (hasAdminToggled) update.admin_toggled_at = trx.fn.now();
      await trx('workflows').where({ id }).update(update);
      await writeGraph(trx, id, newVersion, b.nodes, b.edges);
    });
    res.json({ id, version: newVersion });
  } catch (e) { next(e); }
});

router.patch('/:id/enabled', requirePermission('workflows.manage'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const enabled = !!(req.body && req.body.enabled);
    const wf = await db('workflows').where({ id }).first();
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    // Refuse to enable a flow that would silently no-op — i.e. one whose graph
    // references actions that aren't implemented yet (the booking built-ins'
    // prepare_*/send_document stubs). Concern #5 from review.
    if (enabled) {
      const rows = await db('workflow_nodes').where({ workflow_id: id, version: wf.version });
      const stubs = unimplementedActionsIn(rows.map((n) => ({ type: n.type, config: parseJson(n.config, {}) })));
      if (stubs.length) {
        return res.status(409).json({ error: `This flow can't be enabled yet — it uses actions that aren't implemented: ${stubs.join(', ')}.` });
      }
    }
    const patch = { enabled, updated_at: db.fn.now() };
    // Mark admin ownership so the boot seeder won't re-flip this built-in's
    // enabled state on the next SEED_VERSION bump (review nit #1).
    if (await hasColumnCached('workflows', 'admin_toggled_at')) patch.admin_toggled_at = db.fn.now();
    await db('workflows').where({ id }).update(patch);
    // Turning dunning ON enrolls existing open/unpaid invoices (anchored to
    // their due date) so it starts chasing current debtors, not only invoices
    // sent after enabling (#750). Scoped to this flow's id so the backfill only
    // enrolls dunning, not any custom invoice.sent flow. Best-effort — never
    // fail the toggle over it.
    if (enabled && wf.builtin_key === 'invoice_dunning') {
      try {
        const n = await require('../services/workflows').backfillDunningRuns(id);
        require('../utils/logger').info('[workflow] dunning enabled — enrolled existing invoices', { enrolled: n });
      } catch (e) {
        require('../utils/logger').warn('[workflow] dunning backfill failed', { error: e.message });
      }
    }
    res.json({ id, enabled });
  } catch (e) { next(e); }
});

router.delete('/:id', requirePermission('workflows.manage'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const wf = await db('workflows').where({ id }).first();
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    if (wf.is_builtin) return res.status(409).json({ error: 'Built-in workflows cannot be deleted' });
    await db.transaction(async (trx) => {
      const runIds = (await trx('workflow_runs').where({ workflow_id: id }).select('id')).map((r) => r.id);
      if (runIds.length) {
        await trx('workflow_run_steps').whereIn('run_id', runIds).del();
        await trx('workflow_approvals').whereIn('run_id', runIds).del();
      }
      await trx('workflow_runs').where({ workflow_id: id }).del();
      await trx('workflow_edges').where({ workflow_id: id }).del();
      await trx('workflow_nodes').where({ workflow_id: id }).del();
      await trx('workflows').where({ id }).del();
    });
    res.json({ deleted: true });
  } catch (e) { next(e); }
});

module.exports = router;
