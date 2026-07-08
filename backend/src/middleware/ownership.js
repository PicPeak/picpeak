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

module.exports = { requireEventOwnership, filterOwnedEventIds };
