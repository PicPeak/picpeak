const { db } = require('../database/db');

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
      if (event.created_by && event.created_by !== req.admin.id) {
        return res.status(403).json({ error: 'Access denied' });
      }
      next();
    })
    .catch((err) => {
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
 * Ids of the projects an admin may act on, or `null` when unrestricted
 * (GHSA-wrg5).
 *
 * A project is the caller's when EITHER:
 *   - `projects.created_by` is theirs or NULL (unowned/legacy — same
 *     convention the events table uses), OR
 *   - it has at least one linked event they own (the transitive path via
 *     `events.project_id` → `events.created_by`).
 *
 * The union matters: pre-migration-167 rows have no stored creator but do have
 * linked events, and a brand-new empty project has a creator but no events.
 * `created_by` is read defensively so an instance that hasn't run 167 yet
 * simply falls back to the transitive rule instead of throwing.
 *
 * @returns {Promise<number[]|null>}
 */
async function ownedProjectIds(admin) {
  if (admin?.roleName === 'super_admin') return null;

  const ids = new Set();

  if (await db.schema.hasColumn('projects', 'created_by')) {
    const owned = await db('projects')
      .where((q) => q.whereNull('created_by').orWhere('created_by', admin.id))
      .pluck('id');
    owned.forEach((id) => ids.add(Number(id)));
  }

  const viaEvents = await db('events')
    .whereNotNull('project_id')
    .andWhere((q) => q.whereNull('created_by').orWhere('created_by', admin.id))
    .pluck('project_id');
  viaEvents.forEach((id) => ids.add(Number(id)));

  return [...ids];
}

/**
 * Middleware enforcing ownedProjectIds() on a :id project route. 404 (not 403)
 * on a foreign project so the endpoint isn't an existence oracle — same
 * posture filterOwnedEventIds takes for foreign-vs-missing ids.
 */
function requireProjectOwnership(req, res, next) {
  ownedProjectIds(req.admin)
    .then((ids) => {
      if (ids === null) return next();
      const projectId = Number(req.params.id);
      if (!ids.includes(projectId)) {
        return res.status(404).json({ error: 'Project not found' });
      }
      next();
    })
    .catch(() => res.status(500).json({ error: 'Failed to verify project ownership' }));
}

module.exports = {
  requireEventOwnership,
  filterOwnedEventIds,
  scopeEventsQuery,
  ownedProjectIds,
  requireProjectOwnership,
};
