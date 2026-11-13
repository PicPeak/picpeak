const { db } = require('../database/db');
const { canAccessEvent, scopeEventsQuery } = require('./ownership');
const { hasColumnCached } = require('../utils/schemaCache');

/**
 * Who may reach a row of `email_queue` (sent and queued mail), to read it or
 * to act on it. The project routes, the project cockpit and the Messages
 * routes share this rule:
 *
 *   - a Super Admin reaches every row;
 *   - an admin reaches the rows it sent itself (`sent_by_admin_id`,
 *     migration 359: messages written in the Messages composer);
 *   - otherwise a row follows its gallery: an admin reaches the mail of a
 *     gallery it may act on (canAccessEvent: owner, assigned, ownerless).
 *     Seeing every gallery (events.view_all) is not enough: gallery mail
 *     carries the gallery's share link and, on older rows, its password,
 *     which the event routes keep from roles that only see a gallery.
 *
 * Rows with neither a sender nor a gallery — CRM document mail, which belongs
 * to the document's creator, and system mail — stay with Super Admins rather
 * than being guessed into access.
 */
function seesEveryQueuedEmail(admin) {
  return admin?.roleName === 'super_admin';
}

/** The id as a number when it is a plain positive integer, else null. */
function canonicalEmailId(raw) {
  const id = Number(raw);
  return /^\d+$/.test(String(raw)) && Number.isSafeInteger(id) && id >= 1 ? id : null;
}

async function senderColumnReady() {
  return hasColumnCached('email_queue', 'sent_by_admin_id');
}

/** Whether `admin` may reach a row with this sender and gallery. */
function reachesQueuedEmailRow(admin, row, event) {
  if (!admin || !row) return false;
  if (seesEveryQueuedEmail(admin)) return true;
  if (row.sent_by_admin_id != null && Number(row.sent_by_admin_id) === Number(admin.id)) return true;
  return Boolean(row.event_id && event && canAccessEvent(admin, event));
}

async function mayReachQueuedEmail(admin, emailId) {
  const id = canonicalEmailId(emailId);
  if (id === null || !admin) return false;
  if (seesEveryQueuedEmail(admin)) return true;
  const columns = ['event_id'];
  if (await senderColumnReady()) columns.push('sent_by_admin_id');
  const row = await db('email_queue').where({ id }).first(columns);
  if (!row) return false;
  const event = row.event_id ? await db('events').where({ id: row.event_id }).first('id', 'created_by') : null;
  return reachesQueuedEmailRow(admin, row, event);
}

/**
 * Route guard on the email_queue id in `req.params[param]`. 404, not 403, so
 * the route is not an id oracle. The checked id goes back into req.params in
 * canonical form, so a handler that parses it acts on the row checked here
 * (SQLite matches '1e1' to row 10, parseInt reads 1).
 */
function requireOwnedQueuedEmail(param = 'emailId') {
  return async (req, res, next) => {
    try {
      if (await mayReachQueuedEmail(req.admin, req.params[param])) {
        req.params[param] = String(canonicalEmailId(req.params[param]));
        return next();
      }
      return res.status(404).json({ error: 'Email not found' });
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * The same rule for list queries over `email_queue`, resolved once per
 * request: returns a function that applies it to a query builder.
 */
async function queuedEmailListScope(admin) {
  if (seesEveryQueuedEmail(admin)) return (query) => query;
  const bySender = await senderColumnReady();
  return (query) => query.where((q) => {
    q.whereIn('email_queue.event_id',
      scopeEventsQuery(db('events').select('events.id'), admin, 'events.created_by'));
    if (bySender) q.orWhere('email_queue.sent_by_admin_id', admin.id);
  });
}

/**
 * The sender stamp for a row an admin writes, or nothing before migration
 * 359 has run.
 */
async function sentByColumns(adminId) {
  return adminId != null && await senderColumnReady() ? { sent_by_admin_id: adminId } : {};
}

module.exports = {
  mayReachQueuedEmail,
  reachesQueuedEmailRow,
  senderColumnReady,
  requireOwnedQueuedEmail,
  queuedEmailListScope,
  sentByColumns,
};
