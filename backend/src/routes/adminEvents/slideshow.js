// Extracted verbatim from the original routes/adminEvents.js (see ./index.js).
// Exports a register function; ./index.js calls the sub-routers in the original
// registration order so Express route matching is unchanged.

const { body, validationResult } = require('express-validator');
const { db, logActivity } = require('../../database/db');
const { formatBoolean } = require('../../utils/dbCompat');
const { adminAuth } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const crypto = require('crypto');
const { errorResponse } = require('../../utils/routeHelpers');
const { parseBooleanInput } = require('../../utils/parsers');
const { requireEventOwnership } = require('../../middleware/ownership');
const { requireFeatureFlag } = require('../../middleware/requireFeatureFlag');
const { getFrontendBaseUrl } = require('../../utils/frontendUrl');
const { SLIDESHOW_TRANSITIONS, SLIDESHOW_COLORFILTERS } = require('./helpers');

// The watermark LOOK (source/position/opacity/style/size) is global-only
// (app_settings, Settings → Slideshow); events only carry the show_watermark
// mode (NULL=inherit / true / false), so no per-event look enums live here.

// Build the public slideshow URL for a freshly-minted/existing token.
async function buildSlideshowUrl(slug, token) {
  if (!token) return null;
  const base = await getFrontendBaseUrl();
  return `${base.replace(/\/$/, '')}/gallery/${slug}/show/${token}`;
}

// Fetch the event respecting the editor-role ownership scope (requireEventOwnership
// already gates the route; this re-applies the created_by filter for editors so the
// 404 is identical to the rest of this file).
async function loadOwnedEvent(req) {
  let q = db('events').where('id', req.params.id);
  if (req.admin.roleName === 'editor') {
    q = q.where('created_by', req.admin.id);
  }
  return q.first();
}

module.exports = (router) => {


  // Generate (or rotate) the slideshow share token. Idempotent in intent: each
  // call mints a fresh token, which both "Generate" (first time) and "Regenerate"
  // (rotate, kills the old link) use.
  router.post('/:id/slideshow/generate', adminAuth, requirePermission('events.edit'), requireFeatureFlag('slideshow'), requireEventOwnership, async (req, res) => {
    try {
      const event = await loadOwnedEvent(req);
      if (!event) {
        return res.status(404).json({ error: 'Event not found' });
      }

      const token = crypto.randomBytes(32).toString('hex');
      // NB: the events table has no updated_at column (only created_at), so we
      // must not set it here or the UPDATE throws.
      await db('events').where('id', req.params.id).update({
        show_share_token: token
      });

      await logActivity('slideshow_link_generated',
        { eventName: event.event_name, rotated: Boolean(event.show_share_token) },
        req.params.id,
        { type: 'admin', id: req.admin.id, name: req.admin.username }
      );

      res.json({
        show_share_token: token,
        slideshow_url: await buildSlideshowUrl(event.slug, token)
      });
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to generate slideshow link');
    }
  });

  // Disable the slideshow link (null the token). The public /show/ route dies on
  // its next poll, killing any projector currently pointed at the old link.
  router.post('/:id/slideshow/disable', adminAuth, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
    try {
      const event = await loadOwnedEvent(req);
      if (!event) {
        return res.status(404).json({ error: 'Event not found' });
      }

      await db('events').where('id', req.params.id).update({
        show_share_token: null
      });

      await logActivity('slideshow_link_disabled',
        { eventName: event.event_name },
        req.params.id,
        { type: 'admin', id: req.admin.id, name: req.admin.username }
      );

      res.json({ show_share_token: null });
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to disable slideshow link');
    }
  });

  // Update the LIVE slideshow settings (display time / transition style / speed).
  // A running projector picks these up via the show-page settings poll within a
  // few seconds — no need to regenerate the link.
  router.patch('/:id/slideshow', adminAuth, requirePermission('events.edit'), requireFeatureFlag('slideshow'), requireEventOwnership, [
    body('show_interval_ms').optional().isInt({ min: 1000, max: 120000 }),
    body('show_transition').optional().isIn(SLIDESHOW_TRANSITIONS),
    body('show_transition_ms').optional().isInt({ min: 100, max: 5000 }),
    body('show_watermark').optional({ nullable: true }),
    body('show_colorfilter').optional().isIn(SLIDESHOW_COLORFILTERS)
  ], async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Invalid slideshow settings', details: errors.array() });
      }

      const event = await loadOwnedEvent(req);
      if (!event) {
        return res.status(404).json({ error: 'Event not found' });
      }

      // events has no updated_at column — don't set it.
      const updates = {};
      if (req.body.show_interval_ms !== undefined) updates.show_interval_ms = parseInt(req.body.show_interval_ms, 10);
      if (req.body.show_transition !== undefined) updates.show_transition = req.body.show_transition;
      if (req.body.show_transition_ms !== undefined) updates.show_transition_ms = parseInt(req.body.show_transition_ms, 10);
      // Tri-state: explicit null = inherit the global default.
      if (req.body.show_watermark !== undefined) {
        updates.show_watermark = req.body.show_watermark === null
          ? null
          : formatBoolean(parseBooleanInput(req.body.show_watermark, false));
      }
      if (req.body.show_colorfilter !== undefined) updates.show_colorfilter = req.body.show_colorfilter;

      // Knex throws on an empty update; only write if something changed.
      if (Object.keys(updates).length > 0) {
        await db('events').where('id', req.params.id).update(updates);
      }

      res.json({
        show_interval_ms: updates.show_interval_ms ?? event.show_interval_ms ?? 5000,
        show_transition: updates.show_transition ?? event.show_transition ?? 'crossfade',
        show_transition_ms: updates.show_transition_ms ?? event.show_transition_ms ?? 800,
        show_watermark: updates.show_watermark ?? event.show_watermark ?? null,
        show_colorfilter: updates.show_colorfilter ?? event.show_colorfilter ?? 'none'
      });
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to update slideshow settings');
    }
  });

};
