/**
 * Two-stage delivery — admin routes (issue 1562).
 *
 * Mounted at /api/admin. The delivery settings themselves (status, expected
 * count, promised date, badge label) are event fields saved through
 * PUT /api/admin/events/:id like every other gallery setting; this router
 * carries the state read-out and the one deliberate action, "Full gallery is
 * ready".
 *
 * Completing never happens on its own (count reached / date passed would
 * announce an unfinished gallery). It clears the partial state, moves the
 * first-look badge onto full-set copies of first-look photos, queues the new
 * `gallery_completed` mail (to the customer email and every assigned customer
 * account, through galleryNotificationService) and emits the `gallery.completed` workflow event
 * with the customer address and gallery link, so a custom flow can act on it.
 * Duplicate first-look photos are deleted by the client through the regular
 * bulk-delete route (photos.delete), not here.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { db, logActivity } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission, userHasAnyPermission } = require('../middleware/permissions');
const { requireEventOwnership } = require('../middleware/ownership');
const { safeValidationErrors, errorResponse } = require('../utils/routeHelpers');
const { notifyGalleryCompleted, describeRecipients } = require('../services/galleryNotificationService');
const { buildShareLinkVariants } = require('../services/shareLinkService');
const delivery = require('../services/deliveryService');
const logger = require('../utils/logger');

const router = express.Router();

async function deliveryState(eventId) {
  const event = await db('events').where('id', eventId).first();
  if (!event) return null;
  const [{ total }] = await db('photos').where('event_id', eventId).count('id as total');
  const [{ firstLook }] = await db('photos').where('event_id', eventId).where('first_look', true).count('id as firstLook');
  const duplicates = delivery.isPartial(event) ? await delivery.findFirstLookDuplicates(eventId) : [];
  return {
    status: event.delivery_status || 'complete',
    expected_count: event.delivery_expected_count == null ? null : Number(event.delivery_expected_count),
    due_at: event.delivery_due_at || null,
    due_source: event.delivery_due_source || null,
    badge_label: event.delivery_badge_label || null,
    completed_at: event.delivery_completed_at || null,
    delivered_count: Number(total) || 0,
    first_look_count: Number(firstLook) || 0,
    duplicate_count: duplicates.length,
  };
}

router.get('/events/:eventId/delivery', adminAuth, requirePermission('events.view'), requireEventOwnership, async (req, res) => {
  try {
    const state = await deliveryState(parseInt(req.params.eventId, 10));
    if (!state) return res.status(404).json({ error: 'Event not found' });
    res.json(state);
  } catch (err) {
    errorResponse(res, err, 500, 'Failed to load the delivery state');
  }
});

router.post('/events/:eventId/delivery/complete', adminAuth, requirePermission('events.edit'), requireEventOwnership, [
  body('send_email').optional().isBoolean(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: safeValidationErrors(errors) });
  try {
    const eventId = parseInt(req.params.eventId, 10);
    const result = await delivery.completeDelivery(eventId);
    if (!result) return res.status(404).json({ error: 'Event not found' });
    if (result.already) return res.status(409).json({ error: 'The gallery is not waiting for a full delivery', code: 'DELIVERY_NOT_PARTIAL' });

    const event = result.event;
    const sendEmail = !(req.body.send_email === false || req.body.send_email === 'false');
    const recipient = event.customer_email || event.host_email || null;
    const { shareUrl } = await buildShareLinkVariants({ slug: event.slug, shareToken: event.share_token });
    const [{ total }] = await db('photos').where('event_id', eventId).count('id as total');
    const photoCount = Math.max(0, (Number(total) || 0) - result.duplicates.length);

    // The inline address and every assigned customer account the gallery
    // was announced to (customers.events, as on every announcing route).
    // The delivery is already complete at this point: a failure here is
    // logged and reported as "no mail queued", not a 500 that would also
    // skip the workflow event, with a retry refused as already complete.
    let sent = { inlineEmail: null, accounts: [] };
    if (sendEmail) {
      try {
        sent = await notifyGalleryCompleted(event, {
          includeAccounts: await userHasAnyPermission(req.admin.id, ['customers.events']),
          buildEmailData: ({ name, link }) => ({
            host_name: name,
            customer_name: name,
            event_name: event.event_name,
            event_date: event.event_date,
            gallery_link: link,
            photo_count: photoCount,
            expiry_date: event.expires_at,
          }),
        });
      } catch (err) {
        logger.warn('gallery_completed notification failed', { eventId, error: err.message });
      }
    }
    const emailQueued = Boolean(sent.inlineEmail) || sent.accounts.length > 0;

    await logActivity('delivery_completed', {
      eventName: event.event_name,
      emailQueued,
      ...(sent.accounts.length > 0 ? { assigned_accounts: sent.accounts.length } : {}),
      duplicates: result.duplicates.length,
    }, eventId, { type: 'admin', id: req.admin.id, name: req.admin.username });

    try {
      await require('../services/workflows').emitWorkflowEvent('gallery.completed', {
        entityType: 'event',
        entityId: eventId,
        dedupSuffix: String(Date.parse(event.delivery_completed_at) || Date.now()),
        payload: {
          eventId,
          slug: event.slug,
          eventName: event.event_name,
          customerEmail: recipient,
          adminEmail: event.admin_email || null,
          galleryLink: shareUrl,
          photoCount,
          completedAt: event.delivery_completed_at,
        },
      });
    } catch (err) {
      logger.warn('gallery.completed workflow event failed', { eventId, error: err.message });
    }

    // Names and addresses of the accounts are customers.view data; a failed
    // lookup shows the count only rather than failing the completed request.
    let withIdentities = false;
    if (sent.accounts.length > 0) {
      try {
        withIdentities = await userHasAnyPermission(req.admin.id, ['customers.view']);
      } catch (err) {
        logger.warn('customers.view lookup failed', { eventId, error: err.message });
      }
    }

    require('../services/downloadZipService').invalidate(eventId);
    res.json({
      completed: true,
      email_queued: emailQueued,
      recipients: describeRecipients(sent, { withIdentities }),
      duplicate_photo_ids: result.duplicates.map((d) => d.first_look_id),
      state: await deliveryState(eventId),
    });
  } catch (err) {
    errorResponse(res, err, 500, 'Failed to complete the delivery');
  }
});

module.exports = router;
