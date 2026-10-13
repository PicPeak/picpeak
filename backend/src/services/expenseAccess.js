/**
 * Who may see and change an internal expense or an incoming invoice.
 *
 * The same per-admin rule the CRM documents follow (database/crmAccess.js):
 * a super admin reaches everything, every other admin reaches
 *
 *   - what they recorded themselves (created_by_admin_id),
 *   - what is booked to a gallery they created (event_id), and
 *   - what belongs to nobody yet: no recorder and no gallery. That is an
 *     invoice the mailbox intake captured and nobody has triaged. Whoever
 *     categorises it becomes its owner (expenseService.categorizeInbound).
 *
 * The actor is the one adminAuth / apiTokenAuth put on the request
 * (crmAccess.withCrmActor). With no actor the caller is a system job (mail
 * intake, retention, scheduled exports) and nothing is narrowed.
 */

const { AppError } = require('../utils/errors');
const { currentCrmActor } = require('../database/crmAccess');

/** The admin the rule applies to, or null for a super admin / a system job. */
function scopedActor() {
  const actor = currentCrmActor();
  return actor && actor.roleName !== 'super_admin' ? actor : null;
}

/**
 * knex `.modify()` callback that keeps only the rows of `table` (`expenses`,
 * `inbound_documents`, or an alias of either) the current admin may reach.
 */
const ownedBy = (table) => (qb) => {
  const actor = scopedActor();
  if (!actor) return;
  qb.where((own) => own
    .where(`${table}.created_by_admin_id`, actor.id)
    .orWhere((nobody) => nobody.whereNull(`${table}.created_by_admin_id`).whereNull(`${table}.event_id`))
    .orWhereExists(function ownEvent() {
      this.select('own_event.id').from('events as own_event')
        .whereColumn('own_event.id', `${table}.event_id`)
        .where('own_event.created_by', actor.id);
    }));
};

/**
 * Refuses booking a cost to a gallery the admin did not create: the rule
 * ownership.canLinkCrmToEvent applies to an invoice's event.
 */
async function assertEventLinkable(eventId, conn) {
  const actor = scopedActor();
  if (!actor || !eventId) return;
  const event = await conn('events').where({ id: eventId }).first('created_by');
  if (!event || event.created_by == null || Number(event.created_by) !== Number(actor.id)) {
    throw new AppError('That event is not yours to link', 403, 'EVENT_NOT_YOURS');
  }
}

/**
 * Reads the row of `table` the current admin may reach and, on PostgreSQL,
 * locks it until the transaction ends. A second admin's concurrent request
 * then waits here and is answered from the row as the first one left it, so
 * the check cannot pass on a row that was claimed or moved in between. SQLite
 * has a single connection: the transaction itself already excludes others.
 */
function lockOwned(trx, table, id) {
  const query = trx(table).where({ id }).modify(ownedBy(table));
  // Same lock strength as accountingHistory.auditedUpdate, for the same reason.
  if (trx.client.config.client === 'pg') query.forNoKeyUpdate();
  return query.first();
}

/**
 * Refuses an edit that would put the row out of the admin's own reach. Only
 * one edit can: taking a row another admin recorded off the gallery that
 * makes it the caller's (a new gallery was checked by assertEventLinkable).
 * Without this the change commits and the caller is then answered 404.
 */
function assertKeepsAccess(row, nextEventId) {
  const actor = scopedActor();
  if (!actor || nextEventId != null) return;
  if (row.created_by_admin_id == null || Number(row.created_by_admin_id) === Number(actor.id)) return;
  throw new AppError(
    'Another admin recorded this; it is yours only through its gallery, so it has to stay booked to one of your galleries.',
    409, 'ACCESS_THROUGH_EVENT_ONLY',
  );
}

module.exports = { scopedActor, ownedBy, assertEventLinkable, lockOwned, assertKeepsAccess };
