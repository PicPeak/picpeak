// Curated selection and full link (issue 2356).
//
// An external source can name a selection folder; guests of the ordinary link
// and its QR code then see the photos in that folder only. The full link opens
// the same gallery with every photo of the source; the gallery password, when
// set, still applies. Rotating or removing the full link ends the sessions it
// opened (utils/galleryCredentialCutoff.js).

const crypto = require('crypto');
const { db, logActivity } = require('../../database/db');
const { adminAuth } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { requireEventOwnership, scopeEventsQuery } = require('../../middleware/ownership');
const { errorResponse } = require('../../utils/routeHelpers');
const { getFrontendBaseUrl } = require('../../utils/frontendUrl');
const { livePhotos } = require('../../utils/photoVisibility');
const { formatBoolean } = require('../../utils/dbCompat');
const { ExternalMediaAccessError } = require('../../services/externalMediaAccess');
const externalSelection = require('../../services/externalSelection');

async function loadOwnedEvent(req) {
  return scopeEventsQuery(db('events').where('id', req.params.id), req.admin).first();
}

async function fullLinkUrl(event) {
  if (!event.full_share_token) return null;
  const base = (await getFrontendBaseUrl()).replace(/\/$/, '');
  return `${base}/gallery/${event.slug}/full/${event.full_share_token}`;
}

async function selectionState(event) {
  const counts = await livePhotos(db).where({ event_id: event.id })
    .select(db.raw('SUM(CASE WHEN selection_hidden = ? THEN 1 ELSE 0 END) as outside', [formatBoolean(true)]))
    .count({ total: '*' })
    .first();
  const total = Number(counts?.total || 0);
  const outside = Number(counts?.outside || 0);
  return {
    available: event.source_mode === 'reference' && Boolean(event.external_path),
    selection_path: event.selection_path || null,
    in_selection: total - outside,
    outside_selection: outside,
    full_link_url: await fullLinkUrl(event),
  };
}

const actorOf = (req) => ({ type: 'admin', id: req.admin.id, name: req.admin.username });

module.exports = (router) => {
  router.get('/:id/selection', adminAuth, requirePermission('events.view'), requireEventOwnership, async (req, res) => {
    try {
      const event = await loadOwnedEvent(req);
      if (!event) return res.status(404).json({ error: 'Event not found' });
      res.json(await selectionState(event));
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to load the selection');
    }
  });

  // Set or clear the selection folder, then re-mark every photo of the event.
  router.put('/:id/selection', adminAuth, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
    try {
      const event = await loadOwnedEvent(req);
      if (!event) return res.status(404).json({ error: 'Event not found' });
      let selectionPath;
      try {
        selectionPath = await externalSelection.validateSelectionPath(event, req.body?.selection_path);
      } catch (error) {
        if (error instanceof ExternalMediaAccessError) {
          return res.status(error.statusCode || 400).json({ error: error.message, code: 'INVALID_SELECTION_PATH' });
        }
        throw error;
      }
      // Saved and applied in one transaction (externalSelection.js).
      await externalSelection.recomputeSelection(event.id, db, { selectionPath });
      await logActivity('event_selection_updated', { selection_path: selectionPath }, event.id, actorOf(req));
      res.json(await selectionState({ ...event, selection_path: selectionPath }));
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to update the selection');
    }
  });

  // Create or rotate the full link. A new token ends the old link's sessions.
  router.post('/:id/selection/full-link', adminAuth, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
    try {
      const event = await loadOwnedEvent(req);
      if (!event) return res.status(404).json({ error: 'Event not found' });
      if (!event.selection_path) {
        return res.status(400).json({ error: 'Choose a selection folder first', code: 'SELECTION_REQUIRED' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      await db('events').where({ id: event.id }).update({ full_share_token: token });
      await logActivity('event_full_link_generated', { rotated: Boolean(event.full_share_token) }, event.id, actorOf(req));
      res.json(await selectionState({ ...event, full_share_token: token }));
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to create the full link');
    }
  });

  router.delete('/:id/selection/full-link', adminAuth, requirePermission('events.edit'), requireEventOwnership, async (req, res) => {
    try {
      const event = await loadOwnedEvent(req);
      if (!event) return res.status(404).json({ error: 'Event not found' });
      await db('events').where({ id: event.id }).update({ full_share_token: null });
      await logActivity('event_full_link_removed', {}, event.id, actorOf(req));
      res.json(await selectionState({ ...event, full_share_token: null }));
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to remove the full link');
    }
  });
};
