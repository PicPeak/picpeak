const { db, logActivity } = require('../../database/db');
const { adminAuth } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { requireEventOwnership, scopeEventsQuery } = require('../../middleware/ownership');
const { readGalleryPassword, isRecoverableStorageEnabled } = require('../../utils/galleryPasswordVault');
const { errorResponse } = require('../../utils/routeHelpers');
const { noStoreCache } = require('../../middleware/noStoreCache');

/**
 * Show a gallery's stored password (#1271).
 *
 * Only meaningful when the security setting
 * `security_gallery_password_recoverable` is on: the plaintext exists in no
 * other place, the hash cannot be reversed. The response says whether the
 * feature is enabled at all, so the UI can explain instead of failing.
 * Every reveal of a real password is written to the activity log.
 */
module.exports = (router) => {
  // Whether "Show password" should exist at all. Editors hold events.edit but
  // not settings.view, so the event page cannot read the security setting
  // itself; this answers the one question it has without touching the copy.
  router.get('/:id/password-status', adminAuth, noStoreCache, requirePermission('events.view'), requireEventOwnership, async (req, res) => {
    try {
      const { id } = req.params;
      // Ownership: the rule requireEventOwnership already enforced, kept as
      // defence in depth (issue 1670, §2.4).
      const event = await scopeEventsQuery(db('events').where('id', id), req.admin).first('id');
      if (!event) return res.status(404).json({ error: 'Event not found' });
      res.json({ enabled: await isRecoverableStorageEnabled() });
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to read gallery password status');
    }
  });

  router.get('/:id/password', adminAuth, noStoreCache, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
    try {
      const { id } = req.params;
      // Ownership: the rule requireEventOwnership already enforced, kept as
      // defence in depth (issue 1670, §2.4).
      const event = await scopeEventsQuery(db('events').where('id', id), req.admin).first('id', 'event_name', 'require_password', 'client_access_enabled');
      if (!event) return res.status(404).json({ error: 'Event not found' });

      const stored = await readGalleryPassword(id);
      if (stored.password || stored.clientPassword) {
        await logActivity('gallery_password_viewed',
          { eventName: event.event_name, galleryPassword: Boolean(stored.password), clientPassword: Boolean(stored.clientPassword) },
          id,
          { type: 'admin', id: req.admin.id, name: req.admin.username });
      }
      res.json({
        enabled: stored.enabled,
        password: stored.password,
        client_password: stored.clientPassword
      });
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to read gallery password');
    }
  });
};
