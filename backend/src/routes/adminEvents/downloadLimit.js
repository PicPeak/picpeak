// Per-event download limit usage (issue 1560). Same sub-router shape as
// ./downloadResolutions.js — see ./index.js for the registration-order contract.
//
// The limit itself is an ordinary event column and is edited through
// PUT /:id. These routes only read the usage and reset it.

const { db, logActivity } = require('../../database/db');
const { adminAuth } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { errorResponse } = require('../../utils/routeHelpers');
const { requireEventOwnership } = require('../../middleware/ownership');
const { getQuota, resetGrants } = require('../../services/downloadQuota');

async function loadOwnedEvent(req) {
  let q = db('events').where('id', req.params.id);
  if (req.admin.roleName === 'editor') {
    q = q.where('created_by', req.admin.id);
  }
  return q.first();
}

function usageBody(event, quota) {
  return {
    download_limit: quota ? quota.limit : null,
    downloads_used: quota ? quota.used : 0,
    downloads_remaining: quota ? quota.remaining : null,
  };
}

module.exports = (router) => {
  router.get('/:id/download-limit', adminAuth, requirePermission('events.view'), requireEventOwnership, async (req, res) => {
    try {
      const event = await loadOwnedEvent(req);
      if (!event) return res.status(404).json({ error: 'Event not found' });
      res.json(usageBody(event, await getQuota(event)));
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to load download limit usage');
    }
  });

  // Clears every grant, so the gallery gets its whole quota back. Photos the
  // client already downloaded count again if they download them again.
  router.post('/:id/download-limit/reset', adminAuth, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
    try {
      const event = await loadOwnedEvent(req);
      if (!event) return res.status(404).json({ error: 'Event not found' });

      const cleared = await resetGrants(event.id);
      await logActivity('event_download_limit_reset', {
        event_id: event.id, cleared,
      }, null, { type: 'admin', id: req.admin.id, name: req.admin.username });

      res.json(usageBody(event, await getQuota(event)));
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to reset download limit usage');
    }
  });
};
