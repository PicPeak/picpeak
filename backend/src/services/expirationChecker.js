const cron = require('node-cron');
const { db } = require('../database/db');
const { archiveEvent } = require('./archiveService');
const { queueEmail, getSupportEmail } = require('./emailProcessor');
const { buildShareLinkVariants } = require('./shareLinkService');
const logger = require('../utils/logger');
const { formatBoolean } = require('../utils/dbCompat');

function startExpirationChecker() {
  // Check every hour for expired events and warnings
  cron.schedule('0 * * * *', async () => {
    await checkExpirations();
  });

  logger.info('Expiration checker started');
}

async function checkExpirations() {
  try {
    const now = new Date();
    const warningDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days from now

    // Mutual exclusion with the workflow engine: when the matching built-in flow
    // is enabled, the engine sends the email (via notify_gallery_* actions). We
    // still EMIT the trigger every pass (for the built-in AND any custom flows),
    // but skip the LEGACY email so the two never double-send. State transitions
    // (is_active=false, archive) always run regardless — they're the expiry
    // mechanic, not the notification.
    // Enabled-based mutual exclusion: the legacy email stands down only when the
    // matching built-in is ENABLED (then its action sends the identical mail). A
    // disabled built-in leaves the legacy send running — so the flows can ship
    // disabled without galleries going un-notified, and disabling a flow reverts
    // to legacy. The trigger is still emitted regardless (for any custom flows).
    const { isBuiltinFlowActive } = require('./workflows');
    const warningFlowOwns = await isBuiltinFlowActive('gallery_expiring');
    const expiredFlowOwns = await isBuiltinFlowActive('gallery_expired');

    // Check for events needing warning emails
    // Skip events with null expires_at (they never expire)
    const eventsNeedingWarning = await db('events')
      .where('is_active', formatBoolean(true))
      .where('is_archived', formatBoolean(false))
      .whereNotNull('expires_at')
      .where('expires_at', '<=', warningDate)
      .where('expires_at', '>', now);

    for (const event of eventsNeedingWarning) {
      await emitGalleryExpiring(event); // always — for the built-in + any custom flows
      if (!warningFlowOwns) {
        await queueExpirationWarning(event); // legacy email (self-dedupes)
      }
    }

    // Check for expired events
    // Skip events with null expires_at (they never expire)
    const expiredEvents = await db('events')
      .where('is_active', formatBoolean(true))
      .where('is_archived', formatBoolean(false))
      .whereNotNull('expires_at')
      .where('expires_at', '<=', now);

    for (const event of expiredEvents) {
      await handleExpiredEvent(event, { sendLegacyEmails: !expiredFlowOwns });
    }

  } catch (error) {
    logger.error('Error checking expirations:', error);
  }
}

/**
 * Emit gallery.expiring for the workflow engine. Best-effort / fail-closed;
 * deduped per (workflow, event) by emitWorkflowEvent so the hourly sweep fires
 * a flow at most once per gallery.
 */
async function emitGalleryExpiring(event) {
  try {
    const daysRemaining = Math.ceil((new Date(event.expires_at) - new Date()) / (1000 * 60 * 60 * 24));
    const { shareUrl } = await buildShareLinkVariants({ slug: event.slug, shareToken: event.share_token });
    await require('./workflows').emitWorkflowEvent('gallery.expiring', {
      entityType: 'event',
      entityId: event.id,
      payload: {
        eventId: event.id,
        slug: event.slug,
        eventName: event.event_name,
        eventDate: event.event_date,
        expiresAt: event.expires_at,
        daysRemaining,
        customerEmail: event.customer_email || event.host_email || null,
        adminEmail: event.admin_email || null,
        galleryLink: shareUrl,
      },
    });
  } catch (err) {
    logger.warn('Failed to emit gallery.expiring workflow event', { eventId: event.id, error: err.message });
  }
}

/**
 * Queue the customer expiration-warning email. Self-dedupes on the
 * (event_id, 'expiration_warning') email_queue row so both the legacy hourly
 * loop and the workflow `notify_gallery_expiring` action are safe to call it.
 */
async function queueExpirationWarning(event) {
  const existingWarning = await db('email_queue')
    .where('event_id', event.id)
    .where('email_type', 'expiration_warning')
    .first();
  if (existingWarning) return;

  const daysRemaining = Math.ceil((new Date(event.expires_at) - new Date()) / (1000 * 60 * 60 * 24));

  const recipientEmail = event.customer_email || event.host_email;
  const recipientName = event.customer_name || event.host_name || (recipientEmail ? recipientEmail.split('@')[0] : null);
  // event.share_link is the path-only form; use the full URL so the
  // recipient's mail client renders a clickable absolute link.
  const { shareUrl } = await buildShareLinkVariants({ slug: event.slug, shareToken: event.share_token });

  // Date formatting + language detection happen inside processTemplate using
  // the recipient's resolved language — pass the raw ISO date and let the
  // processor format it. Don't pre-format here with a hard-coded `.de`/`en`
  // sniff (that helper got the wrong language for nl/pt/ru recipients).
  //
  // gallery_password is sent as the security-message sentinel because by the
  // time the warning fires we no longer have the plaintext (only the bcrypt
  // hash); the processor localises this to "(Not shown for security reasons)".
  await queueEmail(event.id, recipientEmail, 'expiration_warning', {
    customer_name: recipientName,
    customer_email: recipientEmail,
    host_name: recipientName,
    event_name: event.event_name,
    event_date: event.event_date,
    days_remaining: daysRemaining.toString(),
    expiry_date: event.expires_at,
    gallery_link: shareUrl,
    gallery_password: '{{password_security_message}}'
  // Relationship mail — hold to business hours (no-op unless configured).
  }, { respectBusinessHours: true });

  logger.info(`Queued expiration warning for event ${event.slug}`);
}

/**
 * Queue the gallery_expired emails (customer + optional admin). Self-dedupes on
 * the (event_id, 'gallery_expired') email_queue row, so both the legacy expiry
 * handler and the workflow `notify_gallery_expired` action are safe to call it.
 */
async function sendGalleryExpiredEmails(event) {
  const existing = await db('email_queue')
    .where('event_id', event.id)
    .where('email_type', 'gallery_expired')
    .first();
  if (existing) return;

  // The shipped templates (EN/DE in legacy 028, NL/PT/RU in core 075) reference
  // {{host_name}}, {{event_date}}, {{expiry_date}} and {{support_email}} — fill
  // them all here.
  const recipientEmail = event.customer_email || event.host_email;
  const recipientName = event.customer_name || event.host_name || (recipientEmail ? recipientEmail.split('@')[0] : null);
  const supportEmail = await getSupportEmail();

  const customerVars = {
    customer_name: recipientName,
    customer_email: recipientEmail,
    host_name: recipientName,
    event_name: event.event_name,
    event_date: event.event_date,
    expiry_date: event.expires_at,
    admin_email: event.admin_email,
    support_email: supportEmail
  };

  if (recipientEmail) {
    await queueEmail(event.id, recipientEmail, 'gallery_expired', customerVars);
  }
  // Also notify admin (when configured).
  if (event.admin_email && event.admin_email !== recipientEmail) {
    await queueEmail(event.id, event.admin_email, 'gallery_expired', {
      ...customerVars,
      host_name: 'Admin'
    });
  }
}

async function handleExpiredEvent(event, { sendLegacyEmails = true } = {}) {
  try {
    // Mark as inactive
    await db('events').where('id', event.id).update({ is_active: formatBoolean(false) });

    // Fire event.expired BEFORE the cascading archive call so receivers
    // get the lifecycle in order (expired → archived). Canonical event
    // subject (#341) so receivers see the same shape across all event.*
    // types; expires_at retained as an event.expired-specific extra.
    try {
      const webhookService = require('./webhookService');
      await webhookService.fire('event.expired', {
        event: {
          ...webhookService.buildEventSubject({
            id: event.id,
            slug: event.slug,
            event_name: event.event_name,
            event_type: event.event_type,
            event_date: event.event_date,
            share_token: event.share_token,
            customer_name: event.customer_name || event.host_name,
            customer_email: event.customer_email || event.host_email,
            customer_phone: event.customer_phone,
          }),
          expires_at: event.expires_at,
        },
      });
    } catch (e) { /* non-fatal */ }

    // Emit gallery.expired for the workflow engine (sibling to the event.expired
    // webhook). Always emitted; deduped per (workflow, event).
    try {
      await require('./workflows').emitWorkflowEvent('gallery.expired', {
        entityType: 'event',
        entityId: event.id,
        payload: {
          eventId: event.id,
          slug: event.slug,
          eventName: event.event_name,
          eventDate: event.event_date,
          expiresAt: event.expires_at,
          customerEmail: event.customer_email || event.host_email || null,
          adminEmail: event.admin_email || null,
        },
      });
    } catch (err) {
      logger.warn('Failed to emit gallery.expired workflow event', { eventId: event.id, error: err.message });
    }

    // Legacy notification — skipped when the gallery_expired built-in flow drives
    // it (the flow's notify_gallery_expired action sends the same emails).
    if (sendLegacyEmails) {
      await sendGalleryExpiredEmails(event);
    }

    // Start archiving process (always — the expiry mechanic, not the email).
    await archiveEvent(event);

    logger.info(`Handled expiration for event ${event.slug}`);
  } catch (error) {
    logger.error(`Error handling expired event ${event.slug}:`, error);
  }
}

module.exports = {
  startExpirationChecker,
  // Reused by the workflow notify_gallery_* actions so the engine path sends the
  // exact same emails as the legacy hourly checker.
  queueExpirationWarning,
  sendGalleryExpiredEmails,
};
