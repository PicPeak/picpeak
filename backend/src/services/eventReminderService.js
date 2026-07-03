/**
 * eventReminderService — pre-event customer reminder emails
 * (migration 143).
 *
 * Sends ONE reminder per event N days before `event_date`. Goal: nudge
 * the customer on prep — space for equipment setup, dress-code notes,
 * access logistics — so the photographer arrives to a workable scene.
 *
 * **Wiring**
 *
 * `runEventReminderPass()` is invoked from the invoice scheduler's
 * hourly cron tick (commit #3 of this feature). Idempotent: every send
 * stamps `events.event_reminder_sent_at`; subsequent ticks skip rows
 * with a non-null timestamp.
 *
 * **Template resolution**
 *
 *   1. `event_reminder_<events.event_type>` — per-type template, if
 *      seeded. Admin manages these via the existing email-template
 *      editor (no schema rule restricts what they can create here;
 *      whatever slug-prefixed templates exist will match).
 *   2. `event_reminder_default` — catch-all, seeded by migration 143.
 *
 * Falls through silently when the catch-all is missing (logs a warn
 * but doesn't throw — the cron must not crash the whole tick because
 * of one stale install).
 *
 * **Override precedence per event**
 *
 *   - `events.event_reminder_disabled = true` → skip
 *   - `events.event_reminder_offset_days` (nullable int) → overrides
 *     the global `crm_event_reminders_days_before`
 *   - `events.event_reminder_body_override` (text) → if set,
 *     replaces the template body verbatim. Subject still comes from
 *     the template. Useful for one-off "the venue has no loading zone,
 *     arrive via the rear door"-style notes.
 *
 * **Recipient**
 *
 * Only the event's primary customer (`events.customer_account_id`).
 * Multi-customer assignments via `event_customer_assignments` are NOT
 * notified — confirmed with maintainer 2026-05-25. Events without a
 * customer_account_id or without an email on file are skipped.
 *
 * **Snapshot semantics**
 *
 * We resolve + send eagerly per tick. The current shape stamps the
 * sent_at timestamp on send — we deliberately do NOT snapshot the
 * resolved body onto the event row at scheduling time, because the
 * candidate window is short (N days before event) and the cron picks
 * the freshest template every pass until the moment of send. If a
 * future "schedule N hours ahead, freeze the body, send later" model
 * is needed, add a snapshot column and resolve at scheduling time.
 */

const { db } = require('../database/db');
const emailProcessor = require('./emailProcessor');
const { formatBoolean } = require('../utils/dbCompat');
const { getAppSetting } = require('../utils/appSettings');
const { hasColumnCached } = require('../utils/schemaCache');
const logger = require('../utils/logger');
const { ensureEventReminderTemplatesSeeded } = require('./eventReminderTemplates');

const DEFAULT_DAYS_BEFORE = 2;
const DEFAULT_TEMPLATE_GROUP = 'event_reminder';
const TEMPLATE_KEY_DEFAULT = 'event_reminder_default';
const TEMPLATE_KEY_PREFIX = 'event_reminder_';

// One-shot guard: the "schema not migrated" warn would otherwise fire
// once per cron tick (≈ hourly) on installs that haven't applied
// migration 143 yet. Log on the first encounter only — subsequent
// ticks no-op silently.
let schemaWarnLogged = false;

/**
 * Resolve the reminder template within a GROUP (template-key prefix). The group
 * is chosen on the flow block (defaults to `event_reminder`); within it the pick
 * is automatic and per-event-type:
 *   `<group>_<eventType>` if a template exists  →  else  `<group>_default`
 * So an exact wedding/birthday/… template wins; otherwise the group's catch-all.
 * emailProcessor handles a missing template row itself, so we only return a key.
 */
async function resolveTemplateKey(eventType, group = DEFAULT_TEMPLATE_GROUP) {
  const g = String(group || DEFAULT_TEMPLATE_GROUP).replace(/_+$/, ''); // tolerate a trailing "_"
  if (eventType) {
    const perType = `${g}_${eventType}`;
    const exists = await db('email_templates')
      .where({ template_key: perType })
      .first('id');
    if (exists) return perType;
  }
  return `${g}_default`;
}

/**
 * Build the variables payload the template engine substitutes. Keep
 * the keys in sync with the seeded template's `variables` JSON.
 */
function composePayload({ event, recipientEmail, daysBefore, businessName }) {
  // Recipient identity comes from the EVENT row (events.customer_name /
  // host_name), not a customer_accounts join — events store the recipient
  // inline (customer_email / host_email), there is no events.customer_account_id.
  const customerName = event.customer_name
    || event.host_name
    || recipientEmail
    || '';
  // Pass the RAW event_date — emailProcessor.processTemplate runs it through
  // formatDate(value, recipientLanguage). Pre-formatting it (e.g. DD.MM.YYYY)
  // makes the processor's new Date(...) reparse fail → "Invalid Date". Same
  // contract the expiry mailer uses.
  return {
    customer_name: customerName,
    event_name: event.event_name || `Event #${event.id}`,
    event_date: event.event_date || '',
    event_type: event.event_type || '',
    days_before: daysBefore,
    business_name: businessName || '',
  };
}

/**
 * One pass of the reminder loop. Idempotent. Errors on individual
 * events are caught and logged so a single bad row doesn't kill the
 * whole tick.
 *
 * Returns `{ scanned, sent, skipped }` counters for logging.
 */
async function runEventReminderPass() {
  const enabled = await getAppSetting('crm_event_reminders_enabled');
  if (enabled !== true && enabled !== 'true' && enabled !== 1 && enabled !== '1') {
    return { scanned: 0, sent: 0, skipped: 0, disabled: true };
  }

  // Mutual exclusion with the workflow engine: the legacy pass stands down only
  // when the pre_event_email built-in is ENABLED (then the engine sends via the
  // notify_pre_event action). If the flow is disabled, this legacy pass keeps
  // running — so the built-ins can ship disabled without going dark, and
  // disabling a built-in cleanly reverts to the legacy path. Fails closed.
  try {
    if (await require('./workflows').isBuiltinFlowActive('pre_event_email')) {
      return { scanned: 0, sent: 0, skipped: 0, byWorkflow: true };
    }
  } catch (_) { /* workflow subsystem down → keep the legacy pass running */ }

  // Column-existence guards — pre-migration installs return early
  // instead of throwing.
  const hasCols = await hasColumnCached('events', 'event_reminder_sent_at');
  if (!hasCols) {
    if (!schemaWarnLogged) {
      logger.warn('Event reminder pass skipped — schema not yet migrated (run migration 143). Suppressing further warnings until restart.');
      schemaWarnLogged = true;
    }
    return { scanned: 0, sent: 0, skipped: 0 };
  }

  // Self-heal the seeded templates. Idempotent — only inserts missing
  // rows and backfills empty translations, never overwrites edits.
  // Runs once per process (module-level cache); subsequent ticks no-op.
  try {
    await ensureEventReminderTemplatesSeeded(db, logger);
  } catch (err) {
    logger.error('Event reminder template self-heal failed', { message: err.message });
  }

  const globalDaysBefore = Number(await getAppSetting('crm_event_reminders_days_before'));
  const daysBeforeDefault = Number.isFinite(globalDaysBefore) && globalDaysBefore >= 0
    ? globalDaysBefore : DEFAULT_DAYS_BEFORE;

  // Pull the business name once per pass for the payload.
  const profile = await db('business_profile').where({ id: 1 }).first('company_name');
  const businessName = profile?.company_name || '';

  // Candidate set: active events with a date in the future, not yet sent, not
  // disabled per-event. Recipient comes from the event row itself (customer_email
  // / host_email) — events have no customer_account_id. `events.*` so the
  // customer_email column (newer; absent on very old installs) is read safely.
  const now = new Date();
  const rows = await db('events')
    .whereNotNull('events.event_date')
    .where('events.is_active', formatBoolean(true))
    .where('events.is_archived', formatBoolean(false))
    .where('events.event_reminder_disabled', formatBoolean(false))
    .whereNull('events.event_reminder_sent_at')
    .where('events.event_date', '>=', now.toISOString().slice(0, 10))
    .select('events.*');

  let sent = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      // Inline event email, else the assigned customer account(s).
      const recipients = await resolveReminderRecipients(row);
      if (!recipients.length) { skipped += 1; continue; }
      const rawOffset = row.event_reminder_offset_days;
      const offsetDays = (rawOffset != null && rawOffset !== '' && Number.isFinite(Number(rawOffset)))
        ? Number(rawOffset)
        : daysBeforeDefault;
      // Trigger window: NOW >= event_date - offset_days.
      const ed = row.event_date instanceof Date ? row.event_date : new Date(row.event_date);
      const triggerAt = new Date(ed.getTime() - offsetDays * 86_400_000);
      if (now < triggerAt) { skipped += 1; continue; }

      const templateKey = await resolveTemplateKey(row.event_type);
      for (const r of recipients) {
        const payload = composePayload({
          event: row, recipientEmail: r.email, daysBefore: offsetDays, businessName,
        });
        // Per-event body override rides through as a variable the template can branch on.
        if (row.event_reminder_body_override) {
          payload.body_override = row.event_reminder_body_override;
        }
        // Inline → event language; assigned account → customer's preferred language (no eventId).
        await emailProcessor.queueEmail(r.fromEvent ? row.id : null, r.email, templateKey, payload);
      }

      // Stamp sent_at immediately so a same-pass-re-entrancy (or a
      // crash between queueEmail and the update) doesn't double-send
      // on the next tick. The queueEmail call is itself idempotent at
      // the queue level; we belt-and-suspenders here.
      await db('events')
        .where({ id: row.id })
        .update({ event_reminder_sent_at: new Date() });
      sent += 1;
    } catch (err) {
      logger.error('Event reminder send failed', {
        eventId: row.id, err: err.message,
      });
      skipped += 1;
    }
  }

  // Production-quiet: only log when something actually happened
  // (a send or a skipped row inside the trigger window). Empty passes
  // — common when there are no upcoming events — stay silent so the
  // hourly cron doesn't paper the logs.
  if (sent > 0) {
    logger.info('Event reminder pass: sent reminders', {
      scanned: rows.length, sent, skipped,
    });
  } else if (skipped > 0) {
    // skipped > 0 with sent === 0 means at least one event WAS in the
    // window but couldn't be sent (missing email, send error). Log at
    // info so it's visible without being noisy on healthy passes.
    logger.info('Event reminder pass: rows skipped (no-send)', {
      scanned: rows.length, skipped,
    });
  }
  return { scanned: rows.length, sent, skipped };
}

/**
 * Send the pre-event reminder for ONE event — the per-event body of
 * runEventReminderPass, reused by the workflow `notify_pre_event` action so the
 * engine path is byte-identical to the legacy pass (same template resolution,
 * per-event body override, recipient rule and `event_reminder_sent_at` idempotency).
 *
 * Returns { sent, skipped, reason? }. Never throws on a business skip (no email,
 * disabled, already sent, no template-eligible recipient); only DB/queue errors
 * propagate so the caller can surface them.
 */
async function sendReminderForEvent(eventId, { templateGroup = null } = {}) {
  const hasCols = await hasColumnCached('events', 'event_reminder_sent_at');
  if (!hasCols) return { sent: 0, skipped: 1, reason: 'schema_not_migrated' };

  // Self-heal templates (idempotent, process-cached) — same as the pass.
  try { await ensureEventReminderTemplatesSeeded(db, logger); } catch (err) {
    logger.error('Event reminder template self-heal failed', { message: err.message });
  }

  // Recipient comes from the event row (customer_email / host_email) — events
  // have no customer_account_id. `events.*` reads customer_email safely even on
  // installs predating that column.
  const row = await db('events').where('id', eventId).select('events.*').first();

  if (!row) return { sent: 0, skipped: 1, reason: 'not_found' };
  if (row.event_reminder_disabled) return { sent: 0, skipped: 1, reason: 'disabled' };
  if (row.event_reminder_sent_at) return { sent: 0, skipped: 1, reason: 'already_sent' };
  if (row.is_active === false || row.is_active === 0 || row.is_archived === true || row.is_archived === 1) {
    return { sent: 0, skipped: 1, reason: 'inactive' };
  }

  // Recipient resolution:
  //  - inline event email (customer_email / host_email) → send there, language
  //    follows the event (eventId passed);
  //  - else fall back to the assigned customer account(s) (event_customer_assignments)
  //    → send to each registered customer, honouring THEIR preferred_language
  //    (queued without eventId so the resolver uses the customer, not the event).
  // The gallery-ready mail deliberately doesn't fall back to accounts, but a
  // pre-event reminder should still reach an assigned customer.
  const recipients = await resolveReminderRecipients(row);
  if (!recipients.length) return { sent: 0, skipped: 1, reason: 'no_recipient' };

  const globalDaysBefore = Number(await getAppSetting('crm_event_reminders_days_before'));
  const daysBeforeDefault = Number.isFinite(globalDaysBefore) && globalDaysBefore >= 0
    ? globalDaysBefore : DEFAULT_DAYS_BEFORE;
  const rawOffset = row.event_reminder_offset_days;
  const offsetDays = (rawOffset != null && rawOffset !== '' && Number.isFinite(Number(rawOffset)))
    ? Number(rawOffset) : daysBeforeDefault;

  const profile = await db('business_profile').where({ id: 1 }).first('company_name');
  const businessName = profile?.company_name || '';

  // The flow block chooses the template GROUP (blank → the default group); the
  // exact template is still auto-picked by event type within that group.
  const templateKey = await resolveTemplateKey(row.event_type, templateGroup || DEFAULT_TEMPLATE_GROUP);

  let sent = 0;
  for (const r of recipients) {
    const payload = composePayload({ event: row, recipientEmail: r.email, daysBefore: offsetDays, businessName });
    if (row.event_reminder_body_override) payload.body_override = row.event_reminder_body_override;
    // Inline → pass eventId (event language). Assigned account → no eventId so
    // the resolver picks the customer's preferred_language.
    await emailProcessor.queueEmail(r.fromEvent ? row.id : null, r.email, templateKey, payload);
    sent += 1;
  }
  await db('events').where({ id: row.id }).update({ event_reminder_sent_at: new Date() });
  return { sent, skipped: 0, offsetDays };
}

/**
 * Who receives the pre-event reminder for an event: the inline event email if
 * present, otherwise the active assigned customer account(s). `fromEvent` flags
 * which language path to use (event vs customer).
 */
async function resolveReminderRecipients(eventRow) {
  const inline = eventRow.customer_email || eventRow.host_email;
  if (inline) return [{ email: inline, fromEvent: true }];

  const assigned = await db('event_customer_assignments as a')
    .join('customer_accounts as c', 'c.id', 'a.customer_account_id')
    .where('a.event_id', eventRow.id)
    .where('c.is_active', formatBoolean(true))
    .whereNotNull('c.email')
    .select('c.email');
  // De-dup emails defensively (a customer assigned twice, etc.).
  const seen = new Set();
  const out = [];
  for (const a of assigned) {
    const e = String(a.email).toLowerCase();
    if (!seen.has(e)) { seen.add(e); out.push({ email: a.email, fromEvent: false }); }
  }
  return out;
}

module.exports = {
  runEventReminderPass,
  sendReminderForEvent,
  // exported for tests
  _internal: {
    resolveTemplateKey,
    composePayload,
  },
};
