const express = require('express');
const { db, logActivity } = require('../../database/db');
const router = express.Router();
const { verifyGalleryAccess } = require('../../middleware/gallery');
const { resolveGuest, scopeGuestToFeedback } = require('../../middleware/guestAuth');
const { noStoreCache } = require('../../middleware/noStoreCache');
const { generateGuestIdentifier } = require('../../middleware/feedbackRateLimit');
const { errorResponse } = require('../../utils/routeHelpers');
const { guestBlockedByReveal } = require('../../utils/revealMode');
const downloadZipService = require('../../services/downloadZipService');
const GALLERY_OPENED_DEBOUNCE_MS = 6 * 60 * 60 * 1000;
const galleryOpenedNotifiedAt = new Map();
function galleryActor(req) {
  // Portal tokens run as accessLevel 'guest' but carry via:'customer'
  // (req.viaCustomer); PIN-client logins carry accessLevel 'client'.
  // Both are customers, not guests (codex review of #849, final round).
  const isCustomer = !!(req && (req.viaCustomer || req.accessLevel === 'client'));
  return { type: isCustomer ? 'customer' : 'guest' };
}
function notifyGalleryOpened(event, req) {
  // Customer-PORTAL opens already log `customer_event_access` on the
  // access-token mint — a second `gallery_opened` per portal click would
  // double-notify. Keyed on the portal provenance (req.viaCustomer), NOT
  // on accessLevel: PIN-client logins are 'client' without any other
  // open signal and must keep notifying (codex review of #849, final
  // round — the previous check had this inverted).
  if (req && req.viaCustomer) return;
  const now = Date.now();
  const last = galleryOpenedNotifiedAt.get(event.id) || 0;
  if (now - last < GALLERY_OPENED_DEBOUNCE_MS) return;
  galleryOpenedNotifiedAt.set(event.id, now);
  // Fire-and-forget — logActivity swallows its own errors.
  logActivity('gallery_opened', {}, event.id, galleryActor(req));
}

router.get('/:slug/photos', verifyGalleryAccess, resolveGuest, scopeGuestToFeedback, noStoreCache, async (req, res) => {
  try {
    const payload = await require('../../services/galleryQueryService').getGalleryPhotos({
      event: req.event, slug: req.params.slug, query: req.query,
      identity: { guestId: req.guest?.id, guestIdentifier: generateGuestIdentifier(req) },
      accessLevel: req.accessLevel, viaCustomer: req.viaCustomer, adminPreview: req.isAdminPreview,
      hiddenForGuest: guestBlockedByReveal(req),
    });
    // Log view — but NOT for the Live Slideshow kiosk. A running projector
    // refetches this list on every new-upload poll, which would massively
    // inflate total_views / unique_visitors. The slideshow is explicitly
    // excluded from real visitor analytics (migration 138 design).
    // Admin preview (#868) is excluded from guest analytics + the "gallery
    // opened" bell — it's the photographer looking at their own gallery.
    if (req.accessLevel !== 'slideshow' && !req.isAdminPreview && !(Number(req.query.page) > 1)) {
      await db('access_logs').insert({
        event_id: req.event.id,
        ip_address: req.ip,
        user_agent: req.headers['user-agent'],
        action: 'view'
      });
      notifyGalleryOpened(req.event, req);
    }
    
    res.json(payload);
  } catch (error) { errorResponse(res, error, 500, 'Failed to fetch photos'); }
});

/**
 * People in this gallery (#1074).
 *
 * Returns [] rather than 403 whenever the feature is unavailable — a guest
 * must not be able to tell "this gallery has no people" from "this gallery
 * has the feature switched off". Same reasoning as reveal mode returning an
 * empty photo set rather than an error.
 *
 * Counts and cover faces are computed against the caller's own visibility
 * scope inside facePeopleService; nothing here reads face_count_total.
 */
// no-store for the same reason as /photos: the people list and its scan
// progress are scoped to what THIS viewer may see.
router.get('/:slug/people', verifyGalleryAccess, resolveGuest, noStoreCache, async (req, res) => {
  try {
    const isClient = req.accessLevel === 'client';
    const { isEnabledForEvent, areFacesVisibleToGuests, getThresholds } =
      require('../../services/faceSettings');

    if (!(await isEnabledForEvent(req.event))) {
      return res.json({ people: [] });
    }
    if (!isClient && !areFacesVisibleToGuests(req.event)) {
      return res.json({ people: [] });
    }
    // While a gallery is hidden behind reveal mode (#838), a plain guest sees
    // no photos — so they see no people either.
    if (guestBlockedByReveal(req)) {
      return res.json({ people: [] });
    }

    const { listPeople, getScanStatus } = require('../../services/facePeopleService');
    const thresholds = await getThresholds();

    const people = await listPeople(req.event.id, {
      isClient,
      forAdmin: false,
      minClusterSize: thresholds.face_min_cluster_size,
    });

    // Drives the "Finding people… 240/1200" progress line during a backfill.
    // Scoped to what this viewer may see — an unscoped total would leak the
    // number of hidden photos through the progress bar.
    const status = await getScanStatus(req.event.id, { isClient });

    res.json({
      people,
      scan: {
        in_progress: status.in_progress,
        scanned: status.scanned,
        total: status.total,
      },
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to fetch people');
  }
});

// Toggle photo visibility (client-only)
router.patch('/:slug/photos/:photoId/visibility', verifyGalleryAccess, async (req, res) => {
  try {
    if (req.accessLevel !== 'client') {
      return res.status(403).json({ error: 'Client access required' });
    }

    const { photoId } = req.params;
    const { visibility } = req.body;

    if (!['visible', 'hidden'].includes(visibility)) {
      return res.status(400).json({ error: 'Invalid visibility value' });
    }

    const photo = await db('photos')
      .where({ id: photoId, event_id: req.event.id })
      .first();

    if (!photo) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    await db('photos')
      .where({ id: photoId, event_id: req.event.id })
      .update({ visibility });

    // A client hiding/showing a photo changes the guest download bundle —
    // drop the cached ZIP so it rebuilds fresh (codex review).
    downloadZipService.invalidate(req.event.id);

    res.json({ message: 'Photo visibility updated', visibility });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update photo visibility');
  }
});

// Bulk toggle photo visibility (client-only)
router.patch('/:slug/photos/visibility/bulk', verifyGalleryAccess, async (req, res) => {
  try {
    if (req.accessLevel !== 'client') {
      return res.status(403).json({ error: 'Client access required' });
    }

    const { photoIds, visibility } = req.body;

    if (!Array.isArray(photoIds) || photoIds.length === 0) {
      return res.status(400).json({ error: 'Invalid photo IDs' });
    }

    if (!['visible', 'hidden'].includes(visibility)) {
      return res.status(400).json({ error: 'Invalid visibility value' });
    }

    const count = await db('photos')
      .whereIn('id', photoIds)
      .where('event_id', req.event.id)
      .update({ visibility });

    // Client bulk hide/show alters the guest download bundle — invalidate
    // the cached ZIP (codex review).
    downloadZipService.invalidate(req.event.id);

    res.json({ message: `${count} photos updated`, visibility });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update photo visibility');
  }
});

// Download single photo

module.exports = router;
