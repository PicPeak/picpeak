/**
 * Team members on a gallery (issue 743, migration 269).
 *
 * An admin account assigned to an event reaches its gallery the way the
 * creator does (middleware/ownership.js canAccessEvent), with its role's
 * permissions as the limit. Only the owner changes who is assigned
 * (ownership.ownsEvent); the routes check that before calling in here.
 */

const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { AppError } = require('../utils/errors');

// More than any studio has team members; keeps the IN lists bounded.
const MAX_ASSIGNED_ADMINS = 100;
// pg_advisory_xact_lock class for one gallery's team save. 1074-1077 are taken.
const TEAM_SAVE_LOCK = 1078;

const adminColumns = ['admin_users.id', 'admin_users.username', 'roles.display_name as role_name'];

function toApi(row) {
  return { id: Number(row.id), username: row.username, role_name: row.role_name || null };
}

/** Active admin accounts the picker offers: id, username and role, no emails. */
async function listAssignableAdmins({ includeSuperAdmins = false } = {}) {
  const query = db('admin_users')
    .leftJoin('roles', 'roles.id', 'admin_users.role_id')
    .where('admin_users.is_active', formatBoolean(true));
  // A super_admin reaches every gallery already, and which logins hold it is
  // not for every events.edit holder to read; only a super_admin sees them.
  if (!includeSuperAdmins) {
    query.where((q) => q.whereNull('roles.name').orWhereNot('roles.name', 'super_admin'));
  }
  const rows = await query
    .select(adminColumns)
    .orderBy('admin_users.username', 'asc');
  return rows.map(toApi);
}

/** The admins assigned to an event, for the event details. */
async function listAssignedAdmins(eventId) {
  const rows = await db('event_admin_assignments')
    .join('admin_users', 'admin_users.id', 'event_admin_assignments.admin_user_id')
    .leftJoin('roles', 'roles.id', 'admin_users.role_id')
    .where('event_admin_assignments.event_id', eventId)
    .select(adminColumns)
    .orderBy('admin_users.username', 'asc');
  return rows.map(toApi);
}

/**
 * The submitted `assigned_admin_ids` as a clean id list: deduplicated, the
 * event owner left out (the owner reaches the gallery anyway), every new id
 * an active admin account. An admin already assigned stays valid after the
 * account is deactivated, so the team can be saved until someone removes
 * them. Anything else is a 400 rather than silently dropped, so the form
 * never reports a team it did not save.
 *
 * @returns {Promise<number[]>}
 */
async function resolveAssignableIds(ids, ownerId, alreadyAssigned = []) {
  if (!Array.isArray(ids)) {
    throw new AppError('assigned_admin_ids must be an array', 400, 'INVALID_ASSIGNED_ADMINS');
  }
  const wanted = [...new Set(ids.map(Number))].filter((id) => ownerId == null || id !== Number(ownerId));
  if (wanted.some((id) => !Number.isInteger(id) || id < 1)) {
    throw new AppError('assigned_admin_ids must hold admin ids', 400, 'INVALID_ASSIGNED_ADMINS');
  }
  if (wanted.length > MAX_ASSIGNED_ADMINS) {
    throw new AppError(`At most ${MAX_ASSIGNED_ADMINS} team members per gallery`, 400, 'TOO_MANY_ASSIGNED_ADMINS');
  }
  const added = wanted.filter((id) => !alreadyAssigned.includes(id));
  if (added.length === 0) return wanted;
  const found = await db('admin_users')
    .whereIn('id', added)
    .where('is_active', formatBoolean(true))
    .pluck('id');
  if (found.length !== added.length) {
    throw new AppError('Only active admin accounts can be assigned to a gallery', 400, 'INVALID_ASSIGNED_ADMINS');
  }
  return wanted;
}

/**
 * Replace the event's assigned set with `adminIds` (from resolveAssignableIds).
 * Returns the ids added and removed, for the activity log.
 *
 * @returns {Promise<{added: number[], removed: number[]}>}
 */
async function setAssignedAdmins(eventId, adminIds, assignedBy, trx = db) {
  // One team save per gallery at a time (issue 1979). Two saves that read the
  // team either side of a third one's commit can each delete or insert a row
  // the other then inserts: a unique-index wait in both directions on
  // PostgreSQL. An advisory lock, not a stronger lock on the event row: the
  // admin hard delete holds assignment rows while its SET NULL onto
  // events.created_by updates the row, which a stronger lock would hold back.
  // SQLite runs one transaction at a time.
  if (trx.client.config.client === 'pg') {
    await trx.raw('SELECT pg_advisory_xact_lock(?, ?)', [TEAM_SAVE_LOCK, Number(eventId)]);
  }
  // The event row before any assignment row (issue 1979): the key-share lock
  // the insert below takes on it anyway, taken up front. Deleting a gallery
  // locks the event row and then its assignments, so taking it last could
  // deadlock with that on PostgreSQL. A key-share lock does not hold back an
  // edit of the event. No-op on SQLite.
  await trx('events').where('id', eventId).forKeyShare().first('id');
  const existing = (await trx('event_admin_assignments').where('event_id', eventId).pluck('admin_user_id'))
    .map(Number);
  const wanted = new Set(adminIds);
  const removed = existing.filter((id) => !wanted.has(id));
  const added = adminIds.filter((id) => !existing.includes(id));
  if (removed.length > 0) {
    // Locked in id order before the delete, the order the admin hard delete
    // (userManagementService.deleteAdminUser) takes them in; the DELETE alone
    // locks in scan order and can deadlock with it on PostgreSQL (issue 1979).
    // No-op on SQLite.
    await trx('event_admin_assignments').where('event_id', eventId).whereIn('admin_user_id', removed)
      .orderBy('id').forUpdate().pluck('id');
    await trx('event_admin_assignments').where('event_id', eventId).whereIn('admin_user_id', removed).del();
  }
  if (added.length > 0) {
    // A concurrent save of the same set already inserted the row: same result.
    await trx('event_admin_assignments')
      .insert(added.map((id) => ({ event_id: eventId, admin_user_id: id, assigned_by: assignedBy })))
      .onConflict(['event_id', 'admin_user_id']).ignore();
  }
  return { added, removed };
}

module.exports = {
  MAX_ASSIGNED_ADMINS,
  listAssignableAdmins,
  listAssignedAdmins,
  resolveAssignableIds,
  setAssignedAdmins,
};
