const { db } = require('../database/db');
const logger = require('../utils/logger');

function canAccessEvent(admin, event) {
  return Boolean(admin && event && (admin.roleName === 'super_admin'
    || event.created_by == null || Number(event.created_by) === Number(admin.id)));
}

/**
 * Whether the admin's event lists and details cover every event, owned or not:
 * super_admin, and the built-in `admin` role as the studio-wide overview.
 * Every other role (editor, viewer, team_photographer, custom roles) sees its
 * own events plus ownerless ones, the rule canAccessEvent applies per row.
 */
function seesAllEvents(admin) {
  return admin?.roleName === 'super_admin' || admin?.roleName === 'admin';
}

/**
 * Middleware to enforce event ownership for non-super_admin users.
 * Super admins bypass the check. Other admins can only access events they created.
 */
function requireEventOwnership(req, res, next) {
  if (req.admin.roleName === 'super_admin') {
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
      // Allow access if: event has no owner (legacy/system), or admin owns it
      if (!canAccessEvent(req.admin, event)) {
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
 * events plus their own — the same rule requireEventOwnership enforces
 * per-row.
 */
function scopeEventsQuery(query, admin, column = 'created_by') {
  if (admin?.roleName === 'super_admin') {
    return query;
  }
  return query.where((q) => q.whereNull(column).orWhere(column, admin.id));
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
 * @returns {Promise<{allowed: Array, denied: Array}>}
 */
async function filterOwnedEventIds(admin, eventIds) {
  if (admin.roleName === 'super_admin') {
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
  seesAllEvents,
  requireEventOwnership,
  filterOwnedEventIds,
  scopeEventsQuery,
  scopeEventsListQuery,
  withoutForeignEventSecrets,
  EVENT_BEARER_SECRET_COLUMNS,
  ownedProjectIds,
  ownedProjectsSubquery,
  requireProjectOwnership,
};
