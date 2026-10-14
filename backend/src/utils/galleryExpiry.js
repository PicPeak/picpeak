/**
 * A gallery expiry picked as a calendar day (follow-up to issue 1975).
 *
 * A date the admin picks (the settings date field, the create form's day
 * count, a duplicate's window) means the gallery stays open through the END
 * of that day, 23:59:59.999 in the instance time zone. That zone is the one
 * the admin calendar and the scheduled-email business hours already use:
 * business_profile.timezone, else the server process zone (TZ).
 *
 * The column still holds an instant, so every reader that compares it with
 * "now" (the expiry checker, the gallery access checks) is unchanged. Rows
 * written before this keep their old shapes, midnight UTC (the settings
 * form) and the server's local midnight (creation, duplication);
 * expiryCalendarDate() reads both back as the day the admin picked.
 */
const { db } = require('../database/db');
const { toTimestamp } = require('./dateNormalize');
const { parseExpiresAtText } = require('./expiresAtText');
const { _internal: { getZonedParts, zonedWallClockToUtc, addDays } } = require('./businessHours');

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n) => String(n).padStart(2, '0');

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * The instance time zone: business_profile.timezone when set and valid,
 * else the process zone. Pass the transaction when called inside one.
 */
async function getInstanceTimeZone(knex = db) {
  try {
    const row = await knex('business_profile').where({ id: 1 }).first('timezone');
    const tz = String(row?.timezone || '').trim();
    if (tz && isValidTimeZone(tz)) return tz;
  } catch (_) {
    // No business_profile row or column on this schema: the process zone.
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** 'yyyy-MM-dd' → 23:59:59.999 of that day in `tz`, or null for a non-date. */
function endOfDayInZone(ymd, tz) {
  const m = DATE_ONLY.exec(String(ymd));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  // 23:59 exists on every day in every zone (DST moves happen at or after
  // midnight), where the next day's 00:00 may not.
  const end = zonedWallClockToUtc(y, mo, d, 23, 59, tz).getTime() + 59999;
  // Where the clocks go back at midnight (Santiago in April), 23:00-23:59
  // happens twice and the day ends at the later 23:59.
  for (const shift of [3600000, 1800000]) {
    const p = getZonedParts(new Date(end + shift), tz);
    if (p.y === y && p.mo === mo && p.d === d && p.hh === 23 && p.mi === 59) return new Date(end + shift);
  }
  return new Date(end);
}

/** 'yyyy-MM-dd' + n calendar days. */
function addDaysToDate(ymd, n) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const next = addDays(y, mo, d, n);
  return `${next.y}-${pad(next.mo)}-${pad(next.d)}`;
}

/** The calendar day of an instant in `tz`, as 'yyyy-MM-dd'. */
function dateInZone(instant, tz) {
  const p = getZonedParts(instant, tz);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

const isMidnightUtc = (date) => date.toISOString().endsWith('T00:00:00.000Z');

/**
 * The day a stored expiry stands for, as 'yyyy-MM-dd' (null when unreadable).
 * A midnight-UTC instant is what the settings form stored before: its UTC
 * date. Anything else is read in `tz`: an end-of-day row is its own day, and
 * an old creation row (the server's local midnight) is its day as long as
 * the instance zone is the server zone.
 */
function expiryCalendarDate(value, tz) {
  const ms = toTimestamp(value);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return isMidnightUtc(date) ? date.toISOString().slice(0, 10) : dateInZone(date, tz);
}

/**
 * An expiry from the API: a bare 'yyyy-MM-dd' is the end of that day in
 * `tz`; anything else goes through parseExpiresAtText as before.
 */
function parseExpiryInput(value, tz) {
  if (typeof value === 'string' && DATE_ONLY.test(value.trim())) return endOfDayInZone(value.trim(), tz);
  return parseExpiresAtText(value);
}

/**
 * Extend: `days` calendar days later at the same wall-clock time in `tz`, so
 * an end-of-day expiry stays end-of-day across a DST change. An old
 * midnight-UTC row moves in whole UTC days and stays midnight UTC, the shape
 * expiryCalendarDate() recognises.
 */
function extendExpiry(instant, days, tz) {
  const ms = instant.getTime();
  if (isMidnightUtc(instant)) return new Date(ms + days * 86400000);
  const p = getZonedParts(instant, tz);
  const next = addDays(p.y, p.mo, p.d, days);
  // An end-of-day expiry stays the end of the new day: the later 23:59 where
  // that hour repeats, 22:59 where it is skipped (Nuuk in March).
  if (ms === endOfDayInZone(`${p.y}-${pad(p.mo)}-${pad(p.d)}`, tz).getTime()) {
    return endOfDayInZone(`${next.y}-${pad(next.mo)}-${pad(next.d)}`, tz);
  }
  const subMinute = p.ss * 1000 + (((ms % 1000) + 1000) % 1000);
  return new Date(zonedWallClockToUtc(next.y, next.mo, next.d, p.hh, p.mi, tz).getTime() + subMinute);
}

module.exports = {
  getInstanceTimeZone,
  endOfDayInZone,
  addDaysToDate,
  dateInZone,
  expiryCalendarDate,
  parseExpiryInput,
  extendExpiry,
};
