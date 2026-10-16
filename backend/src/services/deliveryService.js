/**
 * Two-stage delivery (issue 1562).
 *
 * An event is `complete` (today's behaviour) or `partial`: a first look is
 * out, the rest is coming by `delivery_due_at`. The guest gallery shows the
 * delivered photos, a banner and placeholder tiles while partial. Completing
 * is always a deliberate admin action — never "count reached" or "date
 * passed", either of which would announce an unfinished gallery.
 *
 * `photos.first_look` is stamped at ingest (the keyword folder of an upload or
 * external import) and stays after completion, so the customer can still find
 * the photos they already shared.
 */

const { db, logActivity } = require('../database/db');
const { livePhotos } = require('../utils/photoVisibility');
const logger = require('../utils/logger');
const { getAppSetting } = require('../utils/appSettings');
const { parseBooleanInput } = require('../utils/parsers');
const { whereTimestamp, formatBoolean } = require('../utils/dbCompat');
const { toTimestamp } = require('../utils/dateNormalize');
const { toDateOnly } = require('../utils/dateOnly');
const { getInstanceTimeZone, endOfDayInZone } = require('../utils/galleryExpiry');

const DEFAULT_DELIVERY_DAYS = 7;
const REMINDER_LEAD_HOURS = 24;
const MAX_PLACEHOLDER_TILES = 12;

const isPartial = (event) => event && event.delivery_status === 'partial';

/** Event date + N days (Settings → Event defaults), at noon UTC so the date never shifts by timezone. */
async function defaultDueAt(event, conn = db) {
  const days = Number(await getAppSetting('event_default_delivery_days', DEFAULT_DELIVERY_DAYS, conn)) || DEFAULT_DELIVERY_DAYS;
  // Postgres hands a DATE column back as a Date at the server's local
  // midnight (the day before in UTC east of Greenwich), SQLite as a string.
  const base = toDateOnly(event.event_date) || '';
  const start = /^\d{4}-\d{2}-\d{2}$/.test(base) ? new Date(`${base}T12:00:00Z`) : new Date();
  return new Date(start.getTime() + days * 864e5);
}

/**
 * The end of the promised day, in epoch ms (NaN when unreadable). The stored
 * value is a calendar day at noon UTC (its UTC date is the promised day):
 * "by the 20th" lasts until the 20th is over in the instance time zone, the
 * zone a date-only gallery expiry ends its day in, and the rule the admin
 * screens (deliveryStatus.ts) use too. Without a zone, the UTC day.
 */
function endOfDueDay(value, timeZone = 'UTC') {
  const ms = toTimestamp(value);
  if (!Number.isFinite(ms)) return NaN;
  const end = endOfDayInZone(new Date(ms).toISOString().slice(0, 10), timeZone);
  return end ? end.getTime() : NaN;
}

/**
 * A `delivery_due_at` from the API as the stored ISO string. A bare date, or a
 * date-time without a zone, names a calendar day: stored at noon UTC like the
 * settings form and the default, instead of being read in the server's zone
 * (the day before in UTC east of Greenwich). A full instant is kept as given.
 */
function parseDueAtInput(value) {
  if (!value) return null;
  const text = String(value).trim();
  const zoneless = /^(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.exec(text);
  if (zoneless) return new Date(`${zoneless[1]}T12:00:00.000Z`).toISOString();
  return new Date(text).toISOString();
}

/**
 * A first-look batch arrived (keyword folder). Switches the event to partial
 * unless it was already completed once — a late "FirstLook" upload must never
 * re-open a delivered gallery. Returns true when the state changed.
 *
 * Writes outside any transaction and logs after the update, so a SQLite
 * caller never deadlocks on the global activity write.
 */
/**
 * The columns that put an event into the partial state. One helper for both
 * ways in (a keyword folder, the settings PUT), so both start a fresh promise
 * the same way: reminder stamps cleared, and a default due date when none is
 * given and the stored one is missing or already past. ISO strings, not Dates:
 * node-sqlite3 can store a Date as "[object Object]".
 */
async function enterPartialColumns(event, { dueAtGiven = false } = {}) {
  const columns = {
    delivery_status: 'partial',
    delivery_completed_at: null,
    delivery_reminder_sent_at: null,
    delivery_overdue_notified_at: null,
  };
  if (dueAtGiven) return columns;
  // A promise for today still stands: past only once its day is over.
  const end = endOfDueDay(event.delivery_due_at, await getInstanceTimeZone());
  if (!Number.isFinite(end) || end < Date.now()) {
    columns.delivery_due_at = (await defaultDueAt(event)).toISOString();
    columns.delivery_due_source = 'default';
  }
  return columns;
}

async function markFirstLookArrived(eventId, { actor, source } = {}) {
  const event = await db('events').where('id', eventId).first();
  if (!event || event.delivery_completed_at || isPartial(event)) return false;
  const update = await enterPartialColumns(event);
  const changed = await db('events')
    .where('id', eventId)
    .whereNull('delivery_completed_at')
    .where('delivery_status', 'complete')
    .update(update);
  if (!changed) return false;
  await logActivity('delivery_first_look_started', { eventName: event.event_name, folder: source || null }, eventId, actor || { type: 'system' })
    .catch((err) => logger.warn('delivery: activity log failed', { error: err.message }));
  return true;
}

/** The delivery block of the guest payload, or null for a plain complete gallery. */
function guestDeliveryPayload(event, deliveredCount) {
  const hasState = isPartial(event) || !!event.delivery_completed_at;
  if (!hasState) return null;
  const expected = event.delivery_expected_count == null ? null : Number(event.delivery_expected_count);
  const outstanding = isPartial(event) && expected ? Math.max(0, expected - deliveredCount) : 0;
  return {
    status: isPartial(event) ? 'partial' : 'complete',
    expected_count: expected,
    delivered_count: deliveredCount,
    placeholder_count: Math.min(outstanding, MAX_PLACEHOLDER_TILES),
    due_at: isPartial(event) ? event.delivery_due_at || null : null,
    badge_label: event.delivery_badge_label || null,
  };
}

/**
 * First-look photos that arrived again in the full set. Camera names repeat
 * across folders (Friday/IMG_0001.jpg, Saturday/IMG_0001.jpg), so the name
 * alone proves nothing, and a wrong pair means deleting a unique photo. A
 * pair needs all of:
 *   - the original filename (case-insensitive) occurs exactly once among the
 *     first-look photos and exactly once in the full set: an ambiguous name
 *     is never paired;
 *   - a second key agrees: the same capture time (to the second) when both
 *     have one, otherwise identical width, height and file size.
 * Returns [{ first_look_id, full_id }].
 */
async function findFirstLookDuplicates(eventId, conn = db) {
  const rows = await livePhotos(conn)
    .where('event_id', eventId)
    .select('id', 'first_look', 'original_filename', 'source_filename', 'filename',
      'captured_at', 'width', 'height', 'size_bytes');
  const nameOf = (r) => String(r.source_filename || r.original_filename || r.filename || '').toLowerCase();
  const byName = (list) => {
    const map = new Map();
    list.forEach((r) => {
      const n = nameOf(r);
      if (!n) return;
      map.set(n, [...(map.get(n) || []), r]);
    });
    return map;
  };
  const firstLook = byName(rows.filter((r) => parseBooleanInput(r.first_look, false)));
  const full = byName(rows.filter((r) => !parseBooleanInput(r.first_look, false)));
  const capturedMs = (r) => {
    if (!r.captured_at) return null;
    const ms = r.captured_at instanceof Date ? r.captured_at.getTime() : Date.parse(r.captured_at);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  };
  const sameShot = (a, b) => {
    const ca = capturedMs(a);
    const cb = capturedMs(b);
    if (ca !== null && cb !== null) return ca === cb;
    return a.width != null && a.height != null && a.size_bytes != null
      && Number(a.width) === Number(b.width) && Number(a.height) === Number(b.height)
      && Number(a.size_bytes) === Number(b.size_bytes);
  };
  const pairs = [];
  for (const [name, candidates] of firstLook) {
    const matches = full.get(name) || [];
    if (candidates.length !== 1 || matches.length !== 1) continue;
    if (!sameShot(candidates[0], matches[0])) continue;
    pairs.push({ first_look_id: Number(candidates[0].id), full_id: Number(matches[0].id) });
  }
  return pairs;
}

/**
 * Mark the full gallery as ready. Clears the partial state, moves the badge
 * from first-look duplicates onto their full-set copies (the caller deletes
 * the duplicates through the regular photo delete), and returns what the
 * route needs to notify. Idempotent: a second call on a complete event is a
 * no-op that reports `already: true`.
 */
async function completeDelivery(eventId, { transferBadges = true } = {}) {
  const event = await db('events').where('id', eventId).first();
  if (!event) return null;
  if (!isPartial(event)) return { already: true, event, duplicates: [] };

  const duplicates = await findFirstLookDuplicates(eventId);
  const now = new Date().toISOString();
  // The partial → complete transition is claimed in the UPDATE itself: two
  // clicks (or two admins) racing past the read above must not both mail the
  // customer and fire gallery.completed.
  const claimed = await db.transaction(async (trx) => {
    const changed = await trx('events')
      .where({ id: eventId, delivery_status: 'partial' })
      .update({ delivery_status: 'complete', delivery_completed_at: now });
    if (changed && transferBadges && duplicates.length) {
      await livePhotos(trx).whereIn('id', duplicates.map((d) => d.full_id)).update({ first_look: formatBoolean(true) });
    }
    return changed > 0;
  });
  if (!claimed) return { already: true, event, duplicates: [] };
  return { already: false, event: { ...event, delivery_status: 'complete', delivery_completed_at: now }, duplicates };
}

/**
 * Hourly pass: one reminder per event when the end of the promised day is
 * within REMINDER_LEAD_HOURS, one more once it is overdue. Internal mail to
 * the studio (business profile email, else the event's admin_email).
 */
async function runDeliveryReminderPass({ now = new Date() } = {}) {
  const { queueEmail } = require('./emailProcessor');
  const leadMs = REMINDER_LEAD_HOURS * 3600e3;
  // The promised day ends at most 14 h before the stored instant (a day of
  // a UTC+14 zone, an instant late in its UTC day), so this window holds
  // every promise whose day ends within the lead; the loop decides.
  const soon = new Date(now.getTime() + leadMs + 14 * 3600e3);
  const events = await db('events')
    .where('delivery_status', 'partial')
    .whereNotNull('delivery_due_at')
    // whereTimestamp: the column holds ISO strings, and a Date bind compares
    // as epoch milliseconds on SQLite (issue 1733's expiry bug).
    .modify(whereTimestamp, 'delivery_due_at', '<=', soon)
    .where((q) => q.whereNull('is_archived').orWhere('is_archived', formatBoolean(false)))
    .select('*');
  let sent = 0;
  const timeZone = await getInstanceTimeZone();
  const profile = await db.schema.hasTable('business_profile')
    ? await db('business_profile').first('email')
    : null;
  for (const event of events) {
    // Promised "by the 20th" means the whole 20th: overdue only once that
    // calendar day is over in the instance zone, not at the stored noon.
    const end = endOfDueDay(event.delivery_due_at, timeZone);
    const overdue = Number.isFinite(end) ? end < now.getTime() : new Date(event.delivery_due_at) <= now;
    // Due soon: the promised day ends within the lead, wherever the zone puts
    // that end relative to the stored noon.
    if (!overdue && Number.isFinite(end) && end - now.getTime() > leadMs) continue;
    const column = overdue ? 'delivery_overdue_notified_at' : 'delivery_reminder_sent_at';
    if (event[column]) continue;
    // Nobody to tell: no mail, no "reminded" log line, and no claim either,
    // so an address added later still gets this reminder.
    const to = (profile && profile.email) || event.admin_email;
    if (!to) {
      logger.warn('delivery reminder skipped: no business profile or admin email', { eventId: event.id });
      continue;
    }
    const claimed = await db('events').where('id', event.id).whereNull(column).update({ [column]: now.toISOString() });
    if (!claimed) continue;
    try {
      const delivered = Number((await livePhotos(db).where('event_id', event.id).whereNull('moderation_status').count('id as c').first()).c) || 0;
      const { getAbsoluteFrontendUrl } = require('../utils/frontendUrl');
      const base = await getAbsoluteFrontendUrl(null, { override: process.env.ADMIN_URL });
      await queueEmail(event.id, to, 'delivery_due_reminder', {
        event_name: event.event_name,
        // The promised calendar day (stored at noon UTC) as a bare date: the
        // email formatter reads an instant in the server's zone, which puts
        // noon UTC on the next day east of UTC+12.
        due_date: new Date(toTimestamp(event.delivery_due_at)).toISOString().slice(0, 10),
        delivered_count: delivered,
        expected_count: event.delivery_expected_count || '?',
        admin_link: `${base}/admin/events/${event.id}`,
        overdue: overdue ? 'yes' : '',
        due_soon: overdue ? '' : 'yes',
      });
      await logActivity(overdue ? 'delivery_overdue' : 'delivery_due_soon',
        { eventName: event.event_name, dueAt: event.delivery_due_at }, event.id, { type: 'system' });
      sent += 1;
    } catch (err) {
      // Release the claim so the next hourly pass tries again.
      await db('events').where('id', event.id).update({ [column]: null }).catch(() => {});
      logger.warn('delivery reminder failed', { eventId: event.id, error: err.message });
    }
  }
  return { sent };
}

module.exports = {
  DEFAULT_DELIVERY_DAYS,
  MAX_PLACEHOLDER_TILES,
  isPartial,
  defaultDueAt,
  parseDueAtInput,
  enterPartialColumns,
  markFirstLookArrived,
  guestDeliveryPayload,
  findFirstLookDuplicates,
  completeDelivery,
  runDeliveryReminderPass,
};
