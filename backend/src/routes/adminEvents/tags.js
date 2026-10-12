// Per-gallery automatic scene tags (issue 1733). Same sub-router shape as
// ./faces.js; see ./index.js for the registration-order contract.
//
// Every route is gated on the `autoTagging` feature flag as well as the
// usual auth/ownership chain.

const { body, validationResult } = require('express-validator');
const { db, logActivity } = require('../../database/db');
const { adminAuth } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { requireFeatureFlag } = require('../../middleware/requireFeatureFlag');
const { requireEventOwnership, scopeEventsQuery } = require('../../middleware/ownership');
const { errorResponse, safeValidationErrors } = require('../../utils/routeHelpers');
const { parseBooleanInput } = require('../../utils/parsers');

const tagSettings = require('../../services/tagSettings');
const tagProcessor = require('../../services/tagProcessor');

const requireTagging = requireFeatureFlag(tagSettings.FLAG_KEY, 'AUTO_TAGGING_DISABLED');

function loadOwnedEvent(req) {
  // Ownership: the rule requireEventOwnership already enforced, kept as
  // defence in depth.
  return scopeEventsQuery(db('events').where('id', req.params.id), req.admin).first();
}

module.exports = (router) => {
  /** The gallery's switch and its queue progress. */
  router.get('/:id/tags', adminAuth, requirePermission('events.view'), requireTagging, requireEventOwnership,
    async (req, res) => {
      try {
        const event = await loadOwnedEvent(req);
        if (!event) return res.status(404).json({ error: 'Event not found' });
        res.json({
          enabled: tagSettings.isSwitchedOnForEvent(event),
          status: await tagProcessor.getTagStatus(event.id),
        });
      } catch (error) {
        errorResponse(res, error, 500, 'Failed to load tagging settings');
      }
    });

  /**
   * Flip the gallery's switch. Switching it on queues the photos that have
   * no tags yet. Switching it off stops there: stored tags stay in the
   * database, and the guest payload stops carrying them.
   */
  router.patch('/:id/tags', adminAuth, requirePermission('events.edit'), requireTagging, requireEventOwnership,
    [body('enabled').isBoolean()],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: safeValidationErrors(errors) });

      try {
        const event = await loadOwnedEvent(req);
        if (!event) return res.status(404).json({ error: 'Event not found' });

        const wasEnabled = tagSettings.isSwitchedOnForEvent(event);
        const nowEnabled = parseBooleanInput(req.body.enabled, false);
        await db('events').where({ id: event.id }).update({ auto_tagging_enabled: nowEnabled });

        const queued = !wasEnabled && nowEnabled
          ? await tagProcessor.enqueueEvent(event.id, { onlyUntagged: true })
          : 0;

        await logActivity('event_tagging_updated', {
          actorType: 'admin',
          actorId: req.admin.id,
          eventId: event.id,
          metadata: { enabled: nowEnabled, queued },
        }).catch(() => {});

        res.json({ success: true, queued });
      } catch (error) {
        errorResponse(res, error, 500, 'Failed to update tagging settings');
      }
    });

  /** Re-run: every photo goes through the sidecar again. */
  router.post('/:id/tags/rescan', adminAuth, requirePermission('events.edit'), requireTagging, requireEventOwnership,
    async (req, res) => {
      try {
        const event = await loadOwnedEvent(req);
        if (!event) return res.status(404).json({ error: 'Event not found' });
        if (!(await tagSettings.isEnabledForEvent(event))) {
          return res.status(400).json({ error: 'Automatic tagging is not enabled for this gallery' });
        }

        const queued = await tagProcessor.enqueueEvent(event.id, { onlyUntagged: false });
        await logActivity('event_tagging_rescan', {
          actorType: 'admin', actorId: req.admin.id, eventId: event.id, metadata: { queued },
        }).catch(() => {});

        res.json({ success: true, queued });
      } catch (error) {
        errorResponse(res, error, 500, 'Failed to queue tagging');
      }
    });
};
