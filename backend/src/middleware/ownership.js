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

module.exports = { requireEventOwnership };
