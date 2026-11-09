'use strict';

/**
 * Client booking requests (#2440, part 2).
 *
 * Availability: free slots come from the business hours (migration 114) in
 * the business timezone, minus the minimum lead time, beyond the booking
 * horizon, and minus busy times. Busy = gallery events on their date/time,
 * manual blocks, pending requests whose hold has not run out, and accepted
 * requests. Each busy interval is widened by the buffer.
 *
 * A request holds only the client's answers, the estimate (computed with
 * pricingFactorService, client-visible factors only) and the slot until the
 * hold expires. Accepting it creates the customer (or reuses the one with
 * that email), a project (website inquiry) and a draft quote with the
 * factor lines; nothing in the CRM is written before an admin accepts.
 */

const crypto = require('crypto');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { AppError, ConflictError } = require('../utils/errors');
const { ensureInt } = require('../utils/numericHelpers');
const { formatBoolean } = require('../utils/dbCompat');
const { isTruthyFlag } = require('../utils/lineItemTotals');
const { normaliseSchedule, _internal: tz } = require('../utils/businessHours');
const { toTimestamp } = require('../utils/dateNormalize');
const pricingFactors = require('./pricingFactorService');
const { hasColumnCached } = require('../utils/schemaCache');
const { scheduledTask } = require('./scheduledTask');

const STATUSES = ['awaiting_payment', 'pending', 'accepted', 'declined', 'expired'];
// Deposit states that keep a pending request (and its slot) until decided.
// Money in that the admin still has to decide on: the request holds its
// time, does not expire and is not purged.
// What erasure leaves in place of a client's address.
const ERASED_EMAIL = 'erased@deleted.invalid';
const PAID_DEPOSIT = ['paid', 'review', 'disputed'];
const MAX_RANGE_DAYS = 42;
const DEFAULT_DURATION_MINUTES = 60;
const MIN_DURATION_MINUTES = 15;
const MAX_DURATION_MINUTES = 24 * 60;
// Open requests (pending, hold not run out) one client may hold at once, by
// address and by email. A real client has one or two; a script many.
const MAX_OPEN_PER_CLIENT = 2;
const MAX_OPEN_PER_EMAIL = 2;
// ...and a request counts against the client's two for this long after it was sent.
const CLIENT_WINDOW_MS = 24 * 3600000;
// An accepted request whose quote is still being made keeps its time this
// long; the steps take seconds. A quote deleted later frees the time.
const ACCEPTING_MS = 15 * 60000;
// Declined and expired requests are purged after this many days.
const RETENTION_DAYS = 180;
const LANGUAGES = ['en', 'de', 'fr', 'nl', 'pt', 'ru', 'es', 'sl'];
// One constant key for pg_advisory_xact_lock: request inserts take turns.
const ADVISORY_LOCK_KEY = 24400354;

const SETTINGS_LIMITS = {
  lead_time_hours: [0, 24 * 90],
  max_open_requests: [1, 1000],
  horizon_days: [1, 730],
  slot_step_minutes: [5, 240],
  buffer_minutes: [0, 24 * 60],
  hold_hours: [1, 24 * 30],
};

// SQLite hands timestamps back as epoch numbers (sometimes as numeric
// strings), PostgreSQL as Dates; toTimestamp reads every shape.
const toDate = (v) => (v instanceof Date ? v : new Date(toTimestamp(v)));
const iso = (v) => (v == null ? null : toDate(v).toISOString());
// Booking instants are written and compared as ISO strings: they sort as
// time on SQLite (which keeps whatever shape it is given) and PostgreSQL
// reads them into timestamptz. Mixing a Date (epoch ms on SQLite) with a
// string column would compare number against text.
const ts = (v) => toDate(v).toISOString();

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------

async function getSettings(conn = db) {
  const row = await conn('booking_settings').where({ id: 1 }).first();
  return {
    lead_time_hours: 48, horizon_days: 180, slot_step_minutes: 30, buffer_minutes: 0, hold_hours: 72,
    max_open_requests: 20, intro_text: null,
    ...(row || {}),
  };
}

/**
 * The client a request is counted against: the rateLimitKey (the IP, IPv6
 * by /64) widened to the /56 for IPv6. A single home connection often gets
 * a /56, so counting per /64 would let it fill the studio's total.
 */
function clientScope(clientKey) {
  const m = String(clientKey).match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4})::\/64$/i);
  if (!m) return String(clientKey);
  const fourth = (parseInt(m[4], 16) & 0xff00).toString(16);
  return `${m[1]}:${m[2]}:${m[3]}:${fourth}::/56`.toLowerCase();
}

/** HMAC of the client scope (see clientScope); never the address itself. */
function clientHash(clientKey) {
  if (!clientKey) return null;
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  return crypto.createHmac('sha256', `booking-client:${secret}`).update(clientScope(clientKey)).digest('hex');
}

async function saveSettings(patch) {
  const updates = {};
  for (const [key, [min, max]] of Object.entries(SETTINGS_LIMITS)) {
    if (patch[key] === undefined) continue;
    const n = ensureInt(patch[key]);
    if (n < min || n > max) throw new AppError(`${key} must be between ${min} and ${max}`, 400, 'BOOKING_SETTINGS_INVALID');
    updates[key] = n;
  }
  if (patch.intro_text !== undefined) updates.intro_text = patch.intro_text ? String(patch.intro_text).slice(0, 5000) : null;
  const existing = await db('booking_settings').where({ id: 1 }).first();
  if (existing) await db('booking_settings').where({ id: 1 }).update({ ...updates, updated_at: ts(new Date()) });
  else await db('booking_settings').insert({ id: 1, ...updates, updated_at: ts(new Date()) });
  return getSettings();
}

/** Business hours + timezone. A blank timezone falls back to the server's. */
async function workingHours(conn = db) {
  const profile = await conn('business_profile').where({ id: 1 }).first('business_hours', 'timezone');
  let schedule = null;
  try {
    schedule = profile && profile.business_hours ? normaliseSchedule(JSON.parse(profile.business_hours)) : null;
  } catch {
    schedule = null;
  }
  let zone = (profile && profile.timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    zone = 'UTC';
  }
  return { schedule, timezone: zone };
}

// ---------------------------------------------------------------------
// Services on the booking page
// ---------------------------------------------------------------------

/** Active, bookable catalogue items. */
async function bookableServices() {
  return db('quote_line_item_presets')
    .where({ bookable: formatBoolean(true), is_active: formatBoolean(true) })
    .orderBy('display_order', 'asc').orderBy('id', 'asc');
}

async function bookableService(id) {
  const preset = await db('quote_line_item_presets').where({ id: ensureInt(id) }).first();
  if (!preset || !isTruthyFlag(preset.bookable) || !isTruthyFlag(preset.is_active)) {
    throw new AppError('This service cannot be booked', 404, 'BOOKING_SERVICE_UNAVAILABLE');
  }
  return preset;
}

/**
 * Slot length for a service: the value of its duration factor in hours
 * (e.g. "Session length: 4 h" → 240 min), else its fixed duration.
 */
function durationMinutes(preset, values = {}) {
  const factorId = preset.booking_duration_factor_id;
  if (factorId) {
    const raw = values[factorId] ?? values[String(factorId)];
    const hours = Number(raw);
    if (raw != null && raw !== '' && Number.isFinite(hours) && hours > 0) {
      return Math.min(MAX_DURATION_MINUTES, Math.max(MIN_DURATION_MINUTES, Math.round(hours * 60)));
    }
  }
  const fixed = ensureInt(preset.booking_duration_minutes);
  return fixed >= MIN_DURATION_MINUTES ? Math.min(fixed, MAX_DURATION_MINUTES) : DEFAULT_DURATION_MINUTES;
}

/**
 * The value a number factor starts with when nothing was entered: its
 * default, else its minimum, else the amount the base price includes. The
 * pricing uses the same order (pricingFactorService.resolveValue).
 */
function numberFactorStart(f) {
  for (const v of [f.default_value, f.min_value, f.included_units]) {
    if (v != null && v !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** `values` with the duration factor filled in from its start value when missing. */
async function withDurationValue(preset, values = {}, conn = db) {
  const factorId = preset.booking_duration_factor_id;
  if (!factorId) return values;
  const raw = values[factorId] ?? values[String(factorId)];
  if (raw != null && raw !== '') return values;
  const factor = await conn('pricing_factors').where({ id: factorId }).first();
  const start = factor ? numberFactorStart(factor) : null;
  return start == null ? values : { ...values, [factorId]: start };
}

/**
 * What the public page shows per service: its description and the factors
 * the client fills in (client-visible ones; the rest take their default).
 */
async function publicCatalogue() {
  const presets = await bookableServices();
  const factorIdsByPreset = await pricingFactors.presetFactorIds(presets.map((p) => p.id));
  const allIds = [...new Set([...factorIdsByPreset.values()].flat())];
  const factorsById = new Map((await pricingFactors.listFactors({ ids: allIds })).map((f) => [f.id, f]));
  return presets.map((p) => {
    const factors = (factorIdsByPreset.get(p.id) || [])
      .map((id) => factorsById.get(id))
      .filter((f) => f && isTruthyFlag(f.client_visible));
    return { preset: p, factors };
  });
}

// ---------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  return String(value).slice(0, 10);
}

function parseLocalDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

const fmtDay = ({ y, mo, d }) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function wallTime(day, hhmm, zone) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  if (!m) return null;
  return tz.zonedWallClockToUtc(day.y, day.mo, day.d, Number(m[1]), Number(m[2]), zone);
}

/**
 * Busy intervals overlapping [from, to), as { start: ms, end: ms }.
 * `excludeRequestId` leaves one request out (re-checking its own slot).
 */
async function busyIntervals(from, to, zone, { excludeRequestId = null, now = new Date(), conn = db } = {}) {
  const busy = [];
  const hasDeposits = await hasColumnCached('booking_requests', 'deposit_status');

  const blocks = await conn('booking_blocks').where('starts_at', '<', ts(to)).andWhere('ends_at', '>', ts(from));
  for (const b of blocks) busy.push({ start: toDate(b.starts_at).getTime(), end: toDate(b.ends_at).getTime() });

  const requests = conn('booking_requests')
    .where('starts_at', '<', ts(to)).andWhere('ends_at', '>', ts(from))
    .andWhere((q) => {
      // An accepted request is busy while its quote is: once the quote is
      // deleted or declined the time is free again, with no step for the admin.
      // Accepting claims the request first and writes quote_id only after the
      // customer, project and quote exist, so a request accepted moments ago
      // with no quote yet is busy too.
      q.where((a) => a.where('status', 'accepted').andWhere((link) => link
        .whereExists((e) => e.select(conn.raw('1')).from('quotes')
          .whereRaw('quotes.id = booking_requests.quote_id').whereNot('quotes.status', 'declined'))
        .orWhere((fresh) => fresh.whereNull('quote_id').andWhere('decided_at', '>', ts(now.getTime() - ACCEPTING_MS)))))
        .orWhere((p) => p.whereIn('status', ['pending', 'awaiting_payment']).andWhere('hold_expires_at', '>', ts(now)));
      // Paid deposits hold past the hold time (see expireStaleHolds). The
      // column lookup is cached before createRequest's transaction opens.
      if (hasDeposits) q.orWhere((p) => p.where('status', 'pending').whereIn('deposit_status', PAID_DEPOSIT));
    });
  if (excludeRequestId) requests.whereNot('id', excludeRequestId);
  for (const r of await requests) busy.push({ start: toDate(r.starts_at).getTime(), end: toDate(r.ends_at).getTime() });

  // Gallery events: a full-day event (the default) blocks its whole day,
  // a timed one its hours. Dates are compared as local days.
  const fromDay = tz.getZonedParts(from, zone);
  const toDay = tz.getZonedParts(to, zone);
  const events = await conn('events')
    .whereBetween('event_date', [fmtDay(tz.addDays(fromDay.y, fromDay.mo, fromDay.d, -1)), fmtDay(tz.addDays(toDay.y, toDay.mo, toDay.d, 1))])
    .where('is_archived', formatBoolean(false))
    .select('event_date', 'event_time_start', 'event_time_end', 'is_full_day');
  for (const e of events) {
    const day = parseLocalDate(dateOnly(e.event_date));
    if (!day) continue;
    const fullDay = e.is_full_day == null ? true : isTruthyFlag(e.is_full_day);
    const start = !fullDay && wallTime(day, e.event_time_start, zone);
    const end = !fullDay && wallTime(day, e.event_time_end, zone);
    if (start && end && end > start) {
      busy.push({ start: start.getTime(), end: end.getTime() });
    } else {
      const next = tz.addDays(day.y, day.mo, day.d, 1);
      busy.push({
        start: tz.zonedWallClockToUtc(day.y, day.mo, day.d, 0, 0, zone).getTime(),
        end: tz.zonedWallClockToUtc(next.y, next.mo, next.d, 0, 0, zone).getTime(),
      });
    }
  }
  return busy;
}

/**
 * Free slots for a service between two local dates (inclusive).
 * @returns {Promise<{timezone: string, durationMinutes: number,
 *   slots: Array<{start: string, end: string}>}>}
 */
async function availableSlots(preset, {
  from, to, values = {}, now = new Date(), excludeRequestId = null, conn = db,
} = {}) {
  const settings = await getSettings(conn);
  const { schedule, timezone } = await workingHours(conn);
  const duration = durationMinutes(preset, await withDurationValue(preset, values, conn));
  const fromDay = parseLocalDate(from);
  const toDay = parseLocalDate(to);
  if (!fromDay || !toDay) throw new AppError('Pick a date range', 400, 'BOOKING_RANGE_INVALID');
  const span = (Date.UTC(toDay.y, toDay.mo - 1, toDay.d) - Date.UTC(fromDay.y, fromDay.mo - 1, fromDay.d)) / 86400000;
  if (span < 0 || span > MAX_RANGE_DAYS) throw new AppError('Pick a shorter date range', 400, 'BOOKING_RANGE_INVALID');
  if (!schedule) return { timezone, durationMinutes: duration, slots: [] };

  const earliest = now.getTime() + settings.lead_time_hours * 3600000;
  const latest = now.getTime() + settings.horizon_days * 86400000;
  const rangeStart = tz.zonedWallClockToUtc(fromDay.y, fromDay.mo, fromDay.d, 0, 0, timezone);
  const after = tz.addDays(toDay.y, toDay.mo, toDay.d, 1);
  const rangeEnd = tz.zonedWallClockToUtc(after.y, after.mo, after.d, 0, 0, timezone);
  const bufferMs = settings.buffer_minutes * 60000;
  const busy = (await busyIntervals(rangeStart, rangeEnd, timezone, { excludeRequestId, now, conn }))
    .map((b) => ({ start: b.start - bufferMs, end: b.end + bufferMs }));

  const slots = [];
  const step = settings.slot_step_minutes;
  for (let i = 0; i <= span; i += 1) {
    const day = tz.addDays(fromDay.y, fromDay.mo, fromDay.d, i);
    for (const block of tz.blocksForDay(schedule, tz.isoWeekday(day.y, day.mo, day.d))) {
      for (let m = block.startMin; m + duration <= block.endMin; m += step) {
        const start = tz.zonedWallClockToUtc(day.y, day.mo, day.d, Math.floor(m / 60), m % 60, timezone).getTime();
        const end = start + duration * 60000;
        if (start < earliest || start > latest) continue;
        if (busy.some((b) => start < b.end && end > b.start)) continue;
        slots.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
      }
    }
  }
  return { timezone, durationMinutes: duration, slots };
}

/** Is `start` (an ISO instant) one of the service's free slots right now? */
async function isSlotFree(preset, start, values, opts = {}) {
  const { timezone } = await workingHours(opts.conn || db);
  const p = tz.getZonedParts(new Date(start), timezone);
  const day = fmtDay(p);
  const { slots, durationMinutes: duration } = await availableSlots(preset, { from: day, to: day, values, ...opts });
  const wanted = new Date(start).getTime();
  return { free: slots.some((s) => new Date(s.start).getTime() === wanted), durationMinutes: duration };
}

// ---------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------

function newReference() {
  // 10 chars of Crockford-ish base32: readable on the phone, not guessable.
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  const bytes = crypto.randomBytes(10);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

// Hourly, so holds run out and old requests are purged while the booking
// pages are not being used, and with the flag off.
const housekeeping = scheduledTask(() => expireStaleHolds(), { schedule: '25 * * * *' });
function startBookingHousekeeping() { housekeeping.start(); }
const stopBookingHousekeeping = () => housekeeping.stop();

/**
 * Pending requests whose hold ran out become `expired`; so do requests whose
 * deposit checkout was never paid (part 3).
 */
async function expireStaleHolds(now = new Date()) {
  const hasDeposits = await hasColumnCached('booking_requests', 'deposit_status');
  const pending = db('booking_requests').where({ status: 'pending' }).andWhere('hold_expires_at', '<=', ts(now));
  // A request whose deposit came in (or is under review) holds its slot
  // until the admin decides: expiring it would free the time and keep the
  // client's money.
  if (hasDeposits) pending.whereNotIn('deposit_status', PAID_DEPOSIT);
  await pending.update({ status: 'expired', updated_at: ts(now) });
  if (hasDeposits) {
    await db('booking_requests').where({ status: 'awaiting_payment' }).andWhere('hold_expires_at', '<=', ts(now))
      .update({ status: 'expired', deposit_status: 'expired', updated_at: ts(now) });
  }
  // Retention: declined and expired requests hold a client's details and
  // never became a customer; they go after RETENTION_DAYS. A deposit that
  // still needs the admin (paid, under review, refund failed) keeps its row.
  const purge = db('booking_requests').whereIn('status', ['declined', 'expired'])
    .andWhere('updated_at', '<', ts(now.getTime() - RETENTION_DAYS * 86400000));
  if (hasDeposits) purge.whereNotIn('deposit_status', [...PAID_DEPOSIT, 'refund_failed']);
  await purge.del();
}

/**
 * Customer erasure: redact the booking requests of the customer (linked, or
 * sent from one of its addresses). Times, service and estimate stay; who the
 * client was goes. Runs inside the erasure's transaction.
 */
async function forgetCustomer(trx, customerId, emails = []) {
  const addresses = [...new Set(emails.filter(Boolean).map((e) => String(e).toLowerCase()))];
  const rows = () => trx('booking_requests').where((q) => {
    q.where('customer_account_id', customerId);
    if (addresses.length) q.orWhereIn(trx.raw('LOWER(email)'), addresses);
  });
  // A postcode entered for a zone factor is the client's address too.
  for (const row of await rows().select('id', 'pricing_factors')) {
    const snapshot = pricingFactors.parseSnapshot(row.pricing_factors);
    if (!snapshot || !snapshot.values) continue;
    let changed = false;
    for (const value of Object.values(snapshot.values)) {
      if (value && typeof value === 'object' && 'postcode' in value) {
        delete value.postcode;
        changed = true;
      }
    }
    if (changed) await trx('booking_requests').where({ id: row.id }).update({ pricing_factors: JSON.stringify(snapshot) });
  }
  // An open request of someone erased cannot be accepted any more. One whose
  // deposit came in stays for the admin to decline, which refunds it.
  const open = rows().whereIn('status', ['pending', 'expired', 'awaiting_payment']);
  // Through `trx`: the cached lookup reads on the global handle, which waits
  // for this transaction on SQLite.
  if (await trx.schema.hasColumn('booking_requests', 'deposit_status')) {
    open.where((q) => q.whereNull('deposit_status').orWhereNotIn('deposit_status', PAID_DEPOSIT));
  }
  await open.update({ status: 'declined', decided_at: ts(new Date()) });
  await rows().update({
    name: 'Erased', email: ERASED_EMAIL, phone: null, company: null, message: null,
    decline_reason: null, client_ip_hash: null, updated_at: ts(new Date()),
  });
}

/**
 * The lock every write that claims a slot takes (new requests, accepting a
 * request whose hold ran out, a late deposit putting an expired request
 * back): a transaction-scoped advisory lock on
 * PostgreSQL, which needs no row to exist; SQLite has one writer.
 */
async function takeRequestLock(trx) {
  if (db.client.config.client === 'pg') await trx.raw('SELECT pg_advisory_xact_lock(?)', [ADVISORY_LOCK_KEY]);
}

/** Run `fn(trx)` in a transaction holding the request lock. */
function withRequestLock(fn) {
  return db.transaction(async (trx) => {
    await takeRequestLock(trx);
    return fn(trx);
  });
}

/**
 * Requests that hold a slot right now: pending or waiting for the deposit
 * with the hold not run out, and (part 3) pending with a paid deposit or one
 * under review, which hold until the admin decides.
 */
function openRequests(conn, now, hasDeposits = true) {
  return conn('booking_requests').where((q) => {
    q.where((p) => p.whereIn('status', ['pending', 'awaiting_payment']).andWhere('hold_expires_at', '>', ts(now)));
    if (hasDeposits) q.orWhere((p) => p.where('status', 'pending').whereIn('deposit_status', PAID_DEPOSIT));
  });
}

/**
 * Caps that keep one client (or a script) from holding the calendar and
 * from using the form to mail third parties: open requests per address
 * hash, per email, and in total. Runs inside the request transaction,
 * after the lock, so concurrent posts cannot all pass the same count.
 */
async function assertMayRequest(conn, { email, ipHash, settings, now, hasDeposits = true }) {
  const count = async (q) => Number((await q.count('* as n').first()).n);
  // Per client, a request counts while it is open and for a day after it
  // was sent: with a short notice period a hold can last only minutes, and
  // a new address per request must not buy a new client mail each time.
  const counted = () => conn('booking_requests').where((q) => q
    .whereIn('id', openRequests(conn, now, hasDeposits).select('id'))
    .orWhere('created_at', '>', ts(now.getTime() - CLIENT_WINDOW_MS)));
  if (ipHash && await count(counted().where({ client_ip_hash: ipHash })) >= MAX_OPEN_PER_CLIENT) {
    throw new AppError('You already have open or recent booking requests. Please wait for the studio to answer them.', 429, 'BOOKING_TOO_MANY_OPEN');
  }
  if (await count(openRequests(conn, now, hasDeposits).whereRaw('LOWER(email) = ?', [email])) >= MAX_OPEN_PER_EMAIL) {
    throw new AppError('You already have open or recent booking requests. Please wait for the studio to answer them.', 429, 'BOOKING_TOO_MANY_OPEN');
  }
  if (await count(openRequests(conn, now, hasDeposits)) >= Number(settings.max_open_requests)) {
    throw new AppError('The studio has too many open requests right now. Please write to them directly.', 429, 'BOOKING_REQUESTS_FULL');
  }
}

/**
 * A client's booking request. The slot is re-checked and the request
 * inserted in one transaction, so two clients racing for the same slot
 * cannot both hold it.
 */
async function createRequest(input, { now = new Date() } = {}) {
  const preset = await bookableService(input.serviceId);
  const values = input.values || {};
  const language = LANGUAGES.includes(input.language) ? input.language : null;
  const estimate = await pricingFactors.priceWithFactors(preset.id, {
    values, language: language || 'en', clientOnly: true,
  });
  const settings = await getSettings();
  const start = new Date(input.start);
  if (Number.isNaN(start.getTime())) throw new AppError('Pick a time', 400, 'BOOKING_SLOT_INVALID');
  const email = String(input.email).trim().toLowerCase().slice(0, 255);
  const ipHash = clientHash(input.clientKey);
  await expireStaleHolds(now);
  // The slot length follows the values the estimate was priced with: a
  // factor the client cannot see keeps its default, whatever was posted.
  const pricedValues = estimate.snapshot.values;
  // Part 3: a deposit, when the service asks for one and Stripe is set up.
  // The slot is then held only for the checkout until the payment is in.
  const deposits = require('./bookingDeposits');
  const hasDeposits = await hasColumnCached('booking_requests', 'deposit_status');
  const depositMinor = hasDeposits ? deposits.depositFor(preset, estimate.totalMinor) : 0;
  const takesDeposit = depositMinor > 0 && await deposits.stripeReady();
  const statusToken = hasDeposits ? deposits.newStatusToken() : null;
  const holdUntil = takesDeposit
    ? now.getTime() + deposits.CHECKOUT_HOLD_MINUTES * 60000
    : now.getTime() + settings.hold_hours * 3600000;

  let repeat = null;
  const insertId = await db.transaction(async (trx) => {
    await takeRequestLock(trx);
    await assertMayRequest(trx, { email, ipHash, settings, now, hasDeposits });
    repeat = await openRequests(trx, now, hasDeposits).whereRaw('LOWER(email) = ?', [email]).first('id');
    // Every read goes through `trx`: SQLite has one connection, and a read
    // on the global handle inside this transaction would wait for itself.
    const { free, durationMinutes: duration } = await isSlotFree(preset, start.toISOString(), pricedValues, { now, conn: trx });
    if (!free) throw new ConflictError('This time is no longer available. Please pick another one.', 'start');
    const inserted = await trx('booking_requests').insert({
      reference: newReference(),
      status: takesDeposit ? 'awaiting_payment' : 'pending',
      preset_id: preset.id,
      service_name: preset.name,
      starts_at: ts(start),
      ends_at: ts(start.getTime() + duration * 60000),
      // The checkout hold or the full hold, never past the slot itself.
      hold_expires_at: ts(Math.min(holdUntil, start.getTime())),
      name: String(input.name).trim().slice(0, 160),
      email,
      phone: input.phone ? String(input.phone).trim().slice(0, 40) : null,
      company: input.company ? String(input.company).trim().slice(0, 160) : null,
      message: input.message ? String(input.message).slice(0, 5000) : null,
      language,
      client_ip_hash: ipHash,
      pricing_factors: JSON.stringify(estimate.snapshot),
      estimate_lines: JSON.stringify(estimate.lines),
      estimate_minor: estimate.totalMinor,
      currency: estimate.currency,
      ...(hasDeposits ? {
        deposit_minor: takesDeposit ? depositMinor : 0,
        deposit_status: takesDeposit ? 'open' : 'none',
        gallery_unlock: deposits.GALLERY_UNLOCK.includes(preset.gallery_unlock) ? preset.gallery_unlock : 'full_payment',
        status_token_hash: deposits.hashToken(statusToken),
      } : {}),
      created_at: ts(now),
      updated_at: ts(now),
    }).returning('id');
    return typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  });
  const request = await db('booking_requests').where({ id: insertId }).first();
  if (takesDeposit) {
    // Mails wait for the payment (bookingDeposits.reconcileSession).
    const checkoutUrl = await deposits.startCheckout(request, statusToken);
    return { request: await db('booking_requests').where({ id: insertId }).first(), checkoutUrl, statusToken };
  }
  // A second open request from the same address: the business is told, the
  // client is not mailed again.
  await require('./bookingNotifications').notifyReceived(request, { mailClient: !repeat }).catch((err) => {
    logger.warn('Could not queue the booking request mails', { requestId: insertId, error: err.message });
  });
  return { request, checkoutUrl: null, statusToken };
}

async function listRequests({ status = null } = {}) {
  await expireStaleHolds();
  const q = db('booking_requests');
  if (status && STATUSES.includes(status)) q.where({ status });
  return q.orderByRaw('CASE WHEN status = \'pending\' THEN 0 ELSE 1 END').orderBy('starts_at', 'asc').limit(500);
}

async function getRequest(id) {
  await expireStaleHolds();
  const row = await db('booking_requests').where({ id }).first();
  if (!row) throw new AppError('Booking request not found', 404);
  return row;
}

function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  if (parts.length < 2) return { first_name: parts[0] || null, last_name: null };
  return { first_name: parts.slice(0, -1).join(' '), last_name: parts[parts.length - 1] };
}

/**
 * The customer for a request's email: the account or contact that has it,
 * else a new passive account. Matched without case (older rows may keep
 * capitals). An email that belongs to more than one customer is not guessed:
 * the admin links the request by hand.
 */
async function customerFor(request, adminId) {
  const email = request.email.toLowerCase();
  const ids = new Set((await db('customer_accounts').whereRaw('LOWER(email) = ?', [email]).pluck('id')).map(Number));
  if (!ids.size && await db.schema.hasTable('customer_contacts')) {
    for (const id of await db('customer_contacts').whereRaw('LOWER(email) = ?', [email]).pluck('customer_account_id')) {
      ids.add(Number(id));
    }
  }
  if (ids.size > 1) {
    throw new AppError('This email belongs to more than one customer. Create the quote for the right one by hand.', 409, 'BOOKING_CUSTOMER_AMBIGUOUS');
  }
  if (ids.size === 1) return { id: [...ids][0], created: false };
  const created = await require('./customerAccountsService').createDirect({
    email,
    prefill: {
      ...splitName(request.name),
      company_name: request.company || null,
      phone: request.phone || null,
      preferred_language: request.language || null,
    },
    createdByAdminId: adminId,
  });
  return { id: created.id, created: true };
}

/** Local date and HH:MM of an instant in the business timezone. */
function localParts(instant, zone) {
  const p = tz.getZonedParts(toDate(instant), zone);
  return { date: fmtDay(p), time: `${String(p.hh).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}` };
}

/** The estimate as quote lines: the service as parent, the priced breakdown below. */
function quoteLines(request) {
  const snapshot = pricingFactors.parseSnapshot(request.pricing_factors);
  let lines = [];
  try { lines = JSON.parse(request.estimate_lines || '[]'); } catch { lines = []; }
  return [
    {
      position: 1,
      parent_position: null,
      description: request.service_name,
      quantity: 1,
      unit_price_minor: 0,
      discount_percent: 0,
      line_kind: 'item',
      catalogue_preset_id: request.preset_id || null,
      pricing_factors: snapshot,
    },
    ...lines.map((l, i) => ({
      position: i + 2,
      parent_position: 1,
      description: l.description,
      quantity: Number(l.quantity) || 1,
      unit_price_minor: Math.round(Number(l.unitPriceMinor) || 0),
      discount_percent: 0,
      line_kind: 'item',
      unit: l.unit || null,
      price_mode: l.priceMode || null,
      rate_source: l.rateSource || null,
    })),
  ];
}

/**
 * Accept: customer (reused by email, else created passive), a project
 * (website inquiry; it turns active as the quote attaches) and a draft quote
 * holding the estimate. The request is claimed
 * first so a double click creates nothing twice; when a step fails the claim
 * is released and the project made here is removed again.
 */
/**
 * Does anything now take the request's time (a block or gallery added since,
 * another held or accepted request)? Notice period and opening hours are not
 * re-checked: the studio may accept what it likes.
 */
async function slotTaken(request, conn = db) {
  const settings = await getSettings(conn);
  const { timezone } = await workingHours(conn);
  const start = toDate(request.starts_at).getTime();
  const end = toDate(request.ends_at).getTime();
  const bufferMs = settings.buffer_minutes * 60000;
  const busy = await busyIntervals(new Date(start - bufferMs), new Date(end + bufferMs), timezone, { excludeRequestId: request.id, conn });
  return busy.some((b) => start < b.end + bufferMs && end > b.start - bufferMs);
}

async function acceptRequest(id, adminId) {
  await expireStaleHolds();
  // A request whose hold ran out can still be accepted while its time is free.
  // The check and the claim share the lock new requests take, so a request
  // for the same time made meanwhile cannot win it too.
  const claimed = await withRequestLock(async (trx) => {
    const current = await trx('booking_requests').where({ id }).first();
    // Erased while its deposit waits for a refund: decline only.
    if (current && current.email === ERASED_EMAIL) {
      throw new AppError('The client of this request was erased. Decline it to refund the deposit.', 409, 'BOOKING_CLIENT_ERASED');
    }
    if (current && ['pending', 'expired'].includes(current.status) && await slotTaken(current, trx)) {
      throw new AppError('Something else now takes this time. Decline the request, or move the quote to another date after accepting a new one.', 409, 'BOOKING_SLOT_TAKEN');
    }
    return trx('booking_requests').where({ id }).whereIn('status', ['pending', 'expired'])
      .update({ status: 'accepted', decided_at: ts(new Date()), decided_by: adminId || null, updated_at: ts(new Date()) });
  });
  if (!claimed) {
    const row = await db('booking_requests').where({ id }).first('status');
    if (!row) throw new AppError('Booking request not found', 404);
    throw new AppError(`This request is ${row.status}`, 409, 'BOOKING_NOT_PENDING');
  }
  const request = await db('booking_requests').where({ id }).first();
  const { timezone } = await workingHours();
  const start = localParts(request.starts_at, timezone);
  const end = localParts(request.ends_at, timezone);
  const hours = Math.round(((toDate(request.ends_at) - toDate(request.starts_at)) / 3600000) * 100) / 100;

  let project = null;
  let customer = null;
  let quoteId = null;
  try {
    customer = await customerFor(request, adminId);
    const projectService = require('./projectService');
    project = await projectService.createProject({
      name: `${request.service_name} · ${request.company || request.name}`,
      customerAccountId: customer.id,
      status: 'inquiry',
      eventDate: start.date,
      source: 'website',
      currency: request.currency,
      notes: request.message || null,
    }, adminId);
    // Created without the project and attached after: createQuote links a
    // project inside its own transaction, where the lineage checks' first
    // column lookups would wait on SQLite's single connection.
    quoteId = await require('./quoteService').createQuote({
      customerAccountId: customer.id,
      currency: request.currency,
      language: request.language || undefined,
      eventName: request.service_name,
      eventDate: start.date,
      eventTimeStart: start.time,
      eventTimeEnd: end.date === start.date ? end.time : undefined,
      expectedDurationHours: hours,
      lineItems: quoteLines(request),
      // Part 3: the deposit is no invoice; the note reminds whoever bills
      // this deal to book it on the invoice (CRM → Bookings).
      internalNotes: request.deposit_status === 'paid'
        ? `Booking ${request.reference}: deposit ${new Intl.NumberFormat('en-GB', { style: 'currency', currency: request.currency || 'CHF' }).format(Number(request.deposit_minor) / 100)} paid by card (Stripe ${request.payment_intent_id || ''}). Book it on the invoice under CRM → Bookings.`
        : undefined,
    }, adminId);
    await projectService.assignQuote(project.id, quoteId, { id: adminId });
    await db('booking_requests').where({ id }).update({
      customer_account_id: customer.id, project_id: project.id, quote_id: quoteId, updated_at: ts(new Date()),
    });
    return db('booking_requests').where({ id }).first();
  } catch (err) {
    if (quoteId) {
      // The draft quote exists: keep the request accepted and pointing at it
      // and at the project made for it, so nothing is created twice and the
      // admin finds both; the link between the two is what failed.
      await db('booking_requests').where({ id }).update({
        customer_account_id: customer.id, project_id: project?.id || null, quote_id: quoteId, updated_at: ts(new Date()),
      });
      logger.warn('Booking request accepted, but the quote could not be linked to its project', {
        requestId: id, quoteId, error: err.message,
      });
      return db('booking_requests').where({ id }).first();
    }
    await db('booking_requests').where({ id }).update({
      status: 'pending', decided_at: null, decided_by: null, updated_at: ts(new Date()),
    });
    // The project made here holds nothing yet; remove it the way every
    // project delete goes (the audited history records it).
    if (project) {
      await require('./projectService').deleteProject(project.id, { id: adminId }).catch((cleanupErr) => {
        logger.warn('Could not remove the project of a failed booking accept', { requestId: id, projectId: project.id, error: cleanupErr.message });
      });
    }
    throw err;
  }
}

async function declineRequest(id, adminId, reason) {
  await expireStaleHolds();
  const updated = await db('booking_requests').where({ id }).whereIn('status', ['pending', 'expired'])
    .update({
      status: 'declined',
      decided_at: ts(new Date()),
      decided_by: adminId || null,
      decline_reason: reason ? String(reason).slice(0, 2000) : null,
      updated_at: ts(new Date()),
    });
  if (!updated) {
    const row = await db('booking_requests').where({ id }).first('status');
    if (!row) throw new AppError('Booking request not found', 404);
    throw new AppError(`This request is ${row.status}`, 409, 'BOOKING_NOT_PENDING');
  }
  let request = await db('booking_requests').where({ id }).first();
  if (request.deposit_status === 'paid' || request.deposit_status === 'review') {
    await require('./bookingDeposits').refundDeposit(request);
    request = await db('booking_requests').where({ id }).first();
  }
  await require('./bookingNotifications').notifyDeclined(request).catch((err) => {
    logger.warn('Could not queue the booking decline mail', { requestId: id, error: err.message });
  });
  return request;
}

// ---------------------------------------------------------------------
// Manual blocks
// ---------------------------------------------------------------------

async function listBlocks({ from = null } = {}) {
  const q = db('booking_blocks').orderBy('starts_at', 'asc');
  if (from) q.where('ends_at', '>', ts(from));
  return q.limit(500);
}

async function createBlock({ startsAt, endsAt, note }, adminId) {
  const start = toDate(startsAt);
  const end = toDate(endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new AppError('The block must end after it starts', 400, 'BOOKING_BLOCK_INVALID');
  }
  const inserted = await db('booking_blocks').insert({
    starts_at: ts(start), ends_at: ts(end), note: note ? String(note).slice(0, 255) : null,
    created_by: adminId || null, created_at: ts(new Date()),
  }).returning('id');
  const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  return db('booking_blocks').where({ id }).first();
}

async function deleteBlock(id) {
  const removed = await db('booking_blocks').where({ id }).del();
  if (!removed) throw new AppError('Block not found', 404);
}

module.exports = {
  STATUSES,
  LANGUAGES,
  iso,
  forgetCustomer,
  ERASED_EMAIL,
  withRequestLock,
  slotTaken,
  startBookingHousekeeping,
  stopBookingHousekeeping,
  numberFactorStart,
  withDurationValue,
  getSettings,
  saveSettings,
  workingHours,
  publicCatalogue,
  bookableService,
  durationMinutes,
  availableSlots,
  isSlotFree,
  createRequest,
  listRequests,
  getRequest,
  acceptRequest,
  declineRequest,
  expireStaleHolds,
  listBlocks,
  createBlock,
  deleteBlock,
  quoteLines,
};
