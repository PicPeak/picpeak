const { db } = require('../database/db');
const logger = require('../utils/logger');

/**
 * The admin's reach beyond its own galleries, from the role's permissions
 * (adminAuth puts it on req.admin): events.manage_all acts on every gallery,
 * events.view_all lists and reads every gallery. Galleries only: CRM and
 * transfer code (projects, customers, documents, transfers) reaches events
 * through filterOwnedEventIds, which keeps the owner rule unless a gallery
 * route opts in. `eventScope` is null or
 * missing before migration 259 has run, or on a principal built without it;
 * the legacy rule applies then: the built-in `admin` role reads everything.
 */
function managesAllEvents(admin) {
  return admin?.roleName === 'super_admin' || admin?.eventScope?.manageAll === true;
}

/**
 * Whether the admin owns the event: its creator, an ownerless (legacy/system)
 * event, or a role that manages every gallery. Tells the owner from a team
 * member assigned to the event (migration 269): only the owner changes who is
 * assigned and publishes the uploads held for review.
 */
function ownsEvent(admin, event) {
  return Boolean(admin && event && (managesAllEvents(admin)
    || event.created_by == null || Number(event.created_by) === Number(admin.id)));
}

/**
 * Whether the admin may act on the event's gallery: the owner, or an admin
 * assigned to it. Assignment reaches the gallery the way the creator does,
 * with the role's permissions as the limit; CRM and transfer data stay with
 * the owner (filterOwnedEventIds).
 */
function canAccessEvent(admin, event) {
  return ownsEvent(admin, event)
    || Boolean(admin && event && Array.isArray(admin.assignedEventIds)
      && admin.assignedEventIds.includes(Number(event.id)));
}

/**
 * The events an admin is assigned to (migration 269), as numbers. adminAuth,
 * apiTokenAuth and the gallery preview put them on the principal as
 * `assignedEventIds`, which canAccessEvent reads. Before the migration has
 * run there are none, the same posture roleEventScope takes.
 *
 * @returns {Promise<number[]>}
 */
let assignmentsTableReady = false;
async function loadAssignedEventIds(adminId) {
  // Schema only changes at boot, so a table found once stays found.
  if (!assignmentsTableReady) {
    if (!(await db.schema.hasTable('event_admin_assignments'))) return [];
    assignmentsTableReady = true;
  }
  const ids = await db('event_admin_assignments').where('admin_user_id', adminId).pluck('event_id');
  return ids.map(Number);
}

/**
 * Whether the admin's event lists and details cover every event, owned or not:
 * super_admin, and roles holding events.view_all or events.manage_all (the
 * built-in `admin` role holds view_all as the studio-wide overview). Every
 * other role sees its own events plus ownerless ones, the rule canAccessEvent
 * applies per row.
 */
function seesAllEvents(admin) {
  if (managesAllEvents(admin)) return true;
  if (admin?.eventScope) return admin.eventScope.viewAll === true;
  return admin?.roleName === 'admin';
}

/**
 * Whether CRM documents (an invoice, today) may be linked to this event: the
 * rule the database layer applies to CRM rows (database/crmAccess.js — an
 * event anchors a CRM document only for its creator, or for a super admin).
 * Stricter than ownsEvent on purpose: an ownerless gallery or a role that
 * manages every gallery would link a document its own creator could then no
 * longer read.
 */
function canLinkCrmToEvent(admin, event) {
  if (!admin || !event) return false;
  if (admin.roleName === 'super_admin') return true;
  return event.created_by != null && Number(event.created_by) === Number(admin.id);
}

/**
 * Middleware to enforce event ownership for non-super_admin users.
 * Super admins and roles holding events.manage_all bypass the check. Other
 * admins can only access events they created or are assigned to, plus
 * ownerless ones.
 */
function requireEventOwnership(req, res, next) {
  return checkEvent(req, res, next, canAccessEvent);
}

/**
 * requireEventOwnership without the assignment: for what an assignment must
 * not hand over (issue 743) — deleting or archiving the gallery, and its
 * stored password, client PIN and password reset.
 */
function requireEventOwner(req, res, next) {
  return checkEvent(req, res, next, ownsEvent);
}

function checkEvent(req, res, next, mayAct) {
  if (managesAllEvents(req.admin)) {
    return next();
  }

  const eventId = req.params.eventId || req.params.id;
  if (!eventId) {
    return res.status(400).json({ error: 'Event ID is required' });
  }

  db('events')
    .where('id', eventId)
    .first()
    .then((event) => {
      if (!event) {
        return res.status(404).json({ error: 'Event not found' });
      }
      // Allow access if: event has no owner (legacy/system), admin owns it,
      // or (requireEventOwnership only) admin is assigned to it
      if (!mayAct(req.admin, event)) {
        return res.status(403).json({ error: 'Access denied' });
      }
      next();
    })
    .catch((err) => {
      logger.error('Event ownership check failed', {
        eventId, adminId: req.admin.id, error: err.message, stack: err.stack,
      });
      res.status(500).json({ error: 'Failed to verify ownership' });
    });
}

/**
 * Apply the ownership predicate to a knex query over `events`, for list
 * endpoints that can't use requireEventOwnership (no :id to check).
 * super_admin is unrestricted; everyone else sees ownerless (legacy/system)
 * events, their own and the ones they are assigned to — the same rule
 * requireEventOwnership enforces per-row. The event id column is the one
 * beside `column` ('events.created_by' -> 'events.id').
 */
function scopeEventsQuery(query, admin, column = 'created_by', { assignments = true } = {}) {
  if (managesAllEvents(admin)) {
    return query;
  }
  const idColumn = column.replace(/created_by$/, 'id');
  return query.where((q) => {
    q.whereNull(column).orWhere(column, admin.id);
    // Every principal loads its assignments first (loadAssignedEventIds), so
    // the flag says whether the table exists yet. `assignments: false` is the
    // requireEventOwner rule.
    if (assignments && assignmentsTableReady) {
      q.orWhereIn(idColumn, db('event_admin_assignments').select('event_id').where('admin_user_id', admin.id));
    }
  });
}

/**
 * scopeEventsQuery for event lists (events, archives, dashboard), leaving the
 * roles that see all events unrestricted. See seesAllEvents.
 */
function scopeEventsListQuery(query, admin, column = 'created_by') {
  return seesAllEvents(admin) ? query : scopeEventsQuery(query, admin, column);
}

// Columns of an events row that open the gallery on their own: the share link
// embeds the share token, the client token unlocks client access, the show
// token opens the slideshow.
const EVENT_BEARER_SECRET_COLUMNS = ['share_token', 'share_link', 'client_share_token', 'show_share_token'];

/**
 * An event payload without its gallery links when the admin cannot act on the
 * event. A role that sees all events still reads the event, but a link that
 * opens another owner's gallery is that owner's to hand out.
 * `share_secrets_hidden` tells the UI why the link is missing.
 */
function withoutForeignEventSecrets(event, admin) {
  if (!event || typeof event !== 'object' || canAccessEvent(admin, event)) return event;
  const copy = { ...event };
  for (const column of EVENT_BEARER_SECRET_COLUMNS) delete copy[column];
  copy.share_secrets_hidden = true;
  return copy;
}

/**
 * Return the subset of `eventIds` the admin may act on, mirroring
 * requireEventOwnership for bulk routes that can't use it (they take an
 * array in the body, not an :id param). super_admin gets everything;
 * other roles get events they created plus ownerless legacy/system
 * events (created_by IS NULL). Ids that are foreign OR non-existent both
 * land in `denied` — deliberately indistinguishable, so bulk routes
 * don't become an ownership/existence oracle.
 *
 * `honourManageAll` lets events.manage_all through as well; only gallery
 * routes pass it, so the permission never reaches CRM or transfer data
 * hanging off another owner's event (GHSA-wrg5). An assignment (migration
 * 269) never counts here: the bulk callers delete and archive, which stay
 * the owner's.
 *
 * @returns {Promise<{allowed: Array, denied: Array}>}
 */
async function filterOwnedEventIds(admin, eventIds, { honourManageAll = false } = {}) {
  if (admin.roleName === 'super_admin' || (honourManageAll && managesAllEvents(admin))) {
    return { allowed: [...eventIds], denied: [] };
  }
  const rows = await db('events')
    .whereIn('id', eventIds)
    .andWhere((q) => q.whereNull('created_by').orWhere('created_by', admin.id))
    .select('id');
  const allowedSet = new Set(rows.map((r) => r.id));
  const allowed = [];
  const denied = [];
  for (const id of eventIds) {
    if (allowedSet.has(id) || allowedSet.has(Number(id))) {
      allowed.push(id);
    } else {
      denied.push(id);
    }
  }
  return { allowed, denied };
}

/**
 * Knex subquery selecting the ids of projects `admin` may act on, or `null`
 * when the caller is unrestricted (GHSA-wrg5).
 *
 * Rules, in priority order:
 *   1. A project's STORED owner is authoritative. If `projects.created_by` is
 *      set to a live admin, only that admin (and super_admin) may act on it.
 *      Earlier this union'd in "any linked event I can see", which meant one
 *      legacy ownerless event inside another admin's project exposed the whole
 *      project — its other events, invoices and emails — through the overview.
 *   2. Only when there is NO usable stored owner (NULL, or pointing at a
 *      deleted admin) do we derive from linked events, and then EVERY linked
 *      event must be accessible: a project the old unrestricted routes filled
 *      with several admins' events is ambiguous, and migration 167 deliberately
 *      leaves those NULL. Granting on "any" would have made exactly those
 *      mixed projects readable by everyone.
 *   3. A project with no usable owner AND no linked events (an orphan — not
 *      creatable since createProject stamps created_by) stays super_admin-only.
 *      Failing closed beats failing open; a super_admin can reassign it.
 *
 * Returned as a subquery so callers avoid materialising an id list.
 */
function ownedProjectsSubquery(admin) {
  if (admin?.roleName === 'super_admin') return null;

  const linkedEvents = () => db('events').select(db.raw('1')).whereRaw('events.project_id = projects.id');

  return db('projects').select('projects.id').where((w) => {
    w.where('projects.created_by', admin.id)
      .orWhere((noOwner) => {
        noOwner
          // No usable stored owner: NULL, or a creator that no longer exists
          // (hard-deleted admin) — otherwise that project would be locked away
          // from everyone but super_admin forever.
          .where((c) => c
            .whereNull('projects.created_by')
            .orWhereNotIn('projects.created_by', db('admin_users').select('id')))
          .whereExists(linkedEvents())
          .whereNotExists(
            linkedEvents().whereNotNull('events.created_by').whereNot('events.created_by', admin.id),
          );
      });
  });
}

/**
 * Materialised form of ownedProjectsSubquery, for callers that need the ids
 * themselves. `null` = unrestricted.
 *
 * @returns {Promise<number[]|null>}
 */
async function ownedProjectIds(admin) {
  const sub = ownedProjectsSubquery(admin);
  if (sub === null) return null;
  const rows = await sub;
  return rows.map((r) => Number(r.id));
}

/**
 * Middleware enforcing ownedProjectIds() on a :id project route. 404 (not 403)
 * on a foreign project so the endpoint isn't an existence oracle — same
 * posture filterOwnedEventIds takes for foreign-vs-missing ids.
 */
function requireProjectOwnership(req, res, next) {
  const sub = ownedProjectsSubquery(req.admin);
  if (sub === null) return next();
  const projectId = Number(req.params.id);
  sub.clone()
    .where('projects.id', projectId)
    .first()
    .then((row) => {
      if (!row) return res.status(404).json({ error: 'Project not found' });
      next();
    })
    .catch((err) => {
      logger.error('Project ownership check failed', {
        projectId, adminId: req.admin?.id, error: err.message, stack: err.stack,
      });
      res.status(500).json({ error: 'Failed to verify project ownership' });
    });
}

module.exports = {
  canAccessEvent,
  ownsEvent,
  loadAssignedEventIds,
  managesAllEvents,
  seesAllEvents,
  requireEventOwnership,
  requireEventOwner,
  filterOwnedEventIds,
  canLinkCrmToEvent,
  scopeEventsQuery,
  scopeEventsListQuery,
  withoutForeignEventSecrets,
  EVENT_BEARER_SECRET_COLUMNS,
  ownedProjectIds,
  ownedProjectsSubquery,
  requireProjectOwnership,
};
