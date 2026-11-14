'use strict';
// Website embed (issue 1112, migration 363): create, rotate and remove the
// embed link of a gallery, and set the websites allowed to frame it. Modelled
// on ./slideshow.js. The public side is routes/gallery/embed.js.

const crypto = require('crypto');
const { db, logActivity } = require('../../database/db');
const { adminAuth } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { requireEventOwnership, scopeEventsQuery } = require('../../middleware/ownership');
const { requireFeatureFlag } = require('../../middleware/requireFeatureFlag');
const { errorResponse } = require('../../utils/routeHelpers');
const { requiresGalleryPassword } = require('../../utils/galleryLifecycle');
const { parseAllowedOrigins, storedOrigins } = require('../../services/galleryEmbed');

async function loadOwnedEvent(req) {
  // Ownership: requireEventOwnership already enforced it; kept as defence in
  // depth like the slideshow routes.
  return scopeEventsQuery(db('events').where('id', req.params.id), req.admin).first();
}

function embedState(event, overrides = {}) {
  const merged = { ...event, ...overrides };
  return {
    embed_token: merged.embed_token || null,
    embed_allowed_origins: storedOrigins(merged) || [],
  };
}

const actor = (req) => ({ type: 'admin', id: req.admin.id, name: req.admin.username });

module.exports = (router) => {
  // Create or rotate the embed link. Rotating stops every page that embeds
  // the old one on its next request.
  router.post('/:id/embed/generate', adminAuth, requirePermission('events.edit'), requireFeatureFlag('embed'), requireEventOwnership, async (req, res) => {
    try {
      const event = await loadOwnedEvent(req);
      if (!event) return res.status(404).json({ error: 'Event not found' });
      // The embed shows the gallery to anyone on the website: only a gallery
      // that has no password can have one. Refused here so the admin learns
      // it, and re-checked on every public request.
      if (requiresGalleryPassword(event)) {
        return res.status(400).json({ error: 'A gallery with a password cannot be embedded', code: 'EMBED_REQUIRES_PUBLIC_GALLERY' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      await db('events').where('id', event.id).update({ embed_token: token });
      await logActivity('embed_link_generated', { eventName: event.event_name, rotated: Boolean(event.embed_token) }, event.id, actor(req));
      res.json(embedState(event, { embed_token: token }));
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to create the embed link');
    }
  });

  // Remove the embed link. Not flag-gated, like disabling the slideshow link:
  // an admin can always take an embed down.
  router.post('/:id/embed/disable', adminAuth, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
    try {
      const event = await loadOwnedEvent(req);
      if (!event) return res.status(404).json({ error: 'Event not found' });
      await db('events').where('id', event.id).update({ embed_token: null });
      await logActivity('embed_link_disabled', { eventName: event.event_name }, event.id, actor(req));
      res.json(embedState(event, { embed_token: null }));
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to remove the embed link');
    }
  });

  // The websites allowed to frame the embed. Empty: any website.
  router.patch('/:id/embed', adminAuth, requirePermission('events.edit'), requireFeatureFlag('embed'), requireEventOwnership, async (req, res) => {
    try {
      const event = await loadOwnedEvent(req);
      if (!event) return res.status(404).json({ error: 'Event not found' });
      if (req.body?.allowed_origins === undefined) {
        return res.status(400).json({ error: 'allowed_origins is required' });
      }
      let origins;
      try {
        origins = parseAllowedOrigins(req.body.allowed_origins);
      } catch (error) {
        return res.status(400).json({ error: error.message, code: 'EMBED_INVALID_ORIGIN' });
      }
      const stored = origins.length > 0 ? JSON.stringify(origins) : null;
      await db('events').where('id', event.id).update({ embed_allowed_origins: stored });
      await logActivity('embed_origins_updated', { eventName: event.event_name, count: origins.length }, event.id, actor(req));
      res.json(embedState(event, { embed_allowed_origins: stored }));
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to save the embed websites');
    }
  });
};
