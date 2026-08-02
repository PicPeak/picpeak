/**
 * GHSA-jhcf — data correction for legacy accounting activity rows.
 *
 * expenseService called `logActivity(type, metadata, adminId)`, but the third
 * positional parameter of logActivity is `eventId`, not the actor. Every
 * expense / incoming-invoice entry therefore stored the ACTING ADMIN'S ID in
 * `activity_logs.event_id` (and no actor at all).
 *
 * That is not merely cosmetic. The dashboard activity feed now scopes rows via
 * `WHERE activity_logs.event_id IN (SELECT id FROM events WHERE created_by = me)`.
 * Admin ids and event ids are both small integers drawn from the same range, so
 * on any upgraded instance an editor who happens to own the event whose id
 * equals another admin's id is served that admin's accounting activity —
 * verbatim metadata included. Scoping new writes correctly does nothing for the
 * rows already on disk, so they are corrected here.
 *
 * The stored value is exactly the actor id we lost, so this re-attributes
 * rather than discards: event_id → actor_id (when no actor was recorded), then
 * event_id is cleared so the scope predicate can no longer match it.
 *
 * All ten activity types below are emitted by expenseService and nothing else,
 * so no row with a genuine event_id is touched.
 */

const AFFECTED_TYPES = [
  'incoming_invoice_captured',
  'incoming_invoice_updated',
  'incoming_invoice_categorized',
  'incoming_invoice_rebilled',
  'incoming_invoices_rebilled_bundle',
  'incoming_invoice_supplier_payment',
  'expense_created',
  'expense_updated',
  'expense_invoiced',
  'expense_paid',
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('activity_logs'))) return;
  if (!(await knex.schema.hasColumn('activity_logs', 'event_id'))) return;

  const hasActorId = await knex.schema.hasColumn('activity_logs', 'actor_id');
  const hasActorType = await knex.schema.hasColumn('activity_logs', 'actor_type');

  if (hasActorId) {
    const patch = { actor_id: knex.ref('event_id') };
    if (hasActorType) patch.actor_type = 'admin';
    await knex('activity_logs')
      .whereIn('activity_type', AFFECTED_TYPES)
      .whereNotNull('event_id')
      .whereNull('actor_id')
      .update(patch);
  }

  await knex('activity_logs')
    .whereIn('activity_type', AFFECTED_TYPES)
    .whereNotNull('event_id')
    .update({ event_id: null });
};

// Irreversible by design: this is a data correction, and the pre-migration
// state is a cross-admin disclosure. Re-planting admin ids in event_id would
// reopen GHSA-jhcf.
exports.down = async function down() {};
