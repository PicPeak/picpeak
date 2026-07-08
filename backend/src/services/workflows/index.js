/**
 * Workflow engine public surface.
 *
 *   const { emitWorkflowEvent } = require('./services/workflows');
 *
 * `engine` holds the executor (start/advance/resume), `registry` the catalog
 * of conditions/actions. Action/condition handler modules require `registry`
 * and call registerAction/registerCondition at load time.
 */
const engine = require('./engine');
const registry = require('./registry');
// Side-effect import: registers the data-touching action/condition handlers
// (send_email, invoice_paid, prepare_* document actions) onto the registry.
require('./actions');
// Registers the gate_setup action + exposes approval helpers.
const approvals = require('./approvals');

module.exports = {
  ...engine,
  ...approvals,
  registry,
};
