/**
 * Workflow registry — the curated catalog of CONDITIONS and ACTIONS the engine
 * can run. Node `config.condition` / `config.action` keys map to handlers here.
 *
 * Handlers are async `(ctx) => result`, where ctx = { run, node, vars, db,
 * logger }. `vars` is the run's mutable context bag (loop counters, accumulated
 * values, the trigger payload). A condition returns a boolean; an action may
 * return `{ set: {...} }` to merge values back into `vars`.
 *
 * Keep handlers curated and typed — this is NOT arbitrary code execution. New
 * triggers/actions register here; the canvas palette is derived from these.
 */
const conditions = new Map();
const actions = new Map();

function registerCondition(key, fn) { conditions.set(key, fn); }
function registerAction(key, fn) { actions.set(key, fn); }
function getCondition(key) { return conditions.get(key); }
function getAction(key) { return actions.get(key); }
function listConditions() { return Array.from(conditions.keys()); }
function listActions() { return Array.from(actions.keys()); }

// --- Primitive conditions ---
registerCondition('always', async () => true);
registerCondition('never', async () => false);
// Generic field/op/value compare against the run's `vars` bag.
registerCondition('expr', async (ctx) => {
  const { field, op = 'truthy', value } = ctx.node.config || {};
  const actual = field != null ? ctx.vars[field] : undefined;
  switch (op) {
  case 'eq': return actual == value; // eslint-disable-line eqeqeq
  case 'neq': return actual != value; // eslint-disable-line eqeqeq
  case 'gt': return Number(actual) > Number(value);
  case 'gte': return Number(actual) >= Number(value);
  case 'lt': return Number(actual) < Number(value);
  case 'lte': return Number(actual) <= Number(value);
  case 'falsy': return !actual;
  case 'truthy':
  default: return Boolean(actual);
  }
});

// --- Primitive actions ---
registerAction('noop', async () => ({}));
registerAction('log', async (ctx) => {
  ctx.logger?.info?.('[workflow] log action', { runId: ctx.run.id, message: ctx.node.config?.message });
  return { logged: true };
});
// Merge a static object into the run context (handy for tests + seeding flags).
registerAction('set_context', async (ctx) => ({ set: ctx.node.config?.set || {} }));

module.exports = {
  registerCondition,
  registerAction,
  getCondition,
  getAction,
  listConditions,
  listActions,
  conditions,
  actions,
};
