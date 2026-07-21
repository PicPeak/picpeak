/**
 * Reveal scheduler (#838). Runs every minute (the expiration checker's
 * hourly cadence is too coarse for a party reveal) and stamps revealed_at on
 * events whose scheduled reveal_at has passed.
 *
 * The stamp is bookkeeping, not the gate: the gallery routes compute
 * effective visibility from reveal_at at request time, so the reveal happens
 * exactly on schedule even if this job lags. The scheduler makes the state
 * durable, writes the activity log entry, and emits the `gallery.revealed`
 * workflow trigger so hosts can hook a notification email onto it.
 */

const cron = require('node-cron');
const { db, logActivity } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const logger = require('../utils/logger');

async function checkScheduledReveals() {
  try {
    const now = new Date().toISOString();
    const due = await db('events')
      .where('reveal_mode', formatBoolean(true))
      .whereNull('revealed_at')
      .whereNotNull('reveal_at')
      .where('reveal_at', '<=', now)
      .where('is_active', formatBoolean(true))
      .where('is_archived', formatBoolean(false))
      // Drafts aren't guest-reachable — stamping/notifying would burn the
      // reveal before publication and fire workflows for a dead link.
      .where('is_draft', formatBoolean(false));

    for (const event of due) {
      // Conditional update: another worker (multi-replica) may have stamped
      // it between the select and here — exactly one emits the events.
      // Consume the schedule like "Reveal now" does — a stale past
      // reveal_at would otherwise instantly re-open the gate when the
      // gallery is later re-armed without a fresh schedule.
      const stamped = await db('events')
        .where('id', event.id)
        .whereNull('revealed_at')
        .update({ revealed_at: event.reveal_at, reveal_at: null });
      if (stamped !== 1) continue;

      logger.info('Reveal mode: scheduled reveal fired', { eventId: event.id, slug: event.slug });
      await logActivity('gallery_revealed', { scheduled: true, reveal_at: event.reveal_at }, event.id);

      // Best-effort trigger for custom notification flows — never throws
      // into the scheduler and no-ops when nothing subscribes.
      try {
        await require('./workflows').emitWorkflowEvent('gallery.revealed', {
          entityType: 'event',
          entityId: event.id,
          dedupSuffix: String(new Date(event.reveal_at).getTime()),
          payload: {
            eventId: event.id,
            slug: event.slug,
            eventName: event.event_name,
            revealedAt: event.reveal_at,
            scheduled: true,
          },
        });
      } catch (err) {
        logger.warn('Failed to emit gallery.revealed workflow event', { eventId: event.id, error: err.message });
      }
    }
  } catch (error) {
    logger.error('Reveal scheduler pass failed:', error);
  }
}

function startRevealScheduler() {
  cron.schedule('* * * * *', checkScheduledReveals);
  logger.info('Reveal scheduler started');
}

module.exports = { startRevealScheduler, checkScheduledReveals };
