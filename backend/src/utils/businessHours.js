/**
 * Business hours + scheduled-email floor (migration 114).
 *
 * Pure, dependency-free time math. picpeak doesn't pull in a date library,
 * so timezone handling leans on Intl.DateTimeFormat, which every supported
 * Node build ships with full IANA data for.
 *
 * The schedule is per-ISO-weekday with any number of opening blocks, so a
 * day can carry a lunch break (e.g. 09:00–12:00 + 13:00–18:00) or differ
 * from its neighbours — the Google-business-hours model. Shape:
 *
 *   { "1": [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "18:00" }],
 *     "2": [...], ..., "6": [], "7": [] }
 *
 * ISO weekday numbering throughout: 1=Mon … 7=Sun. A weekday with no
 * blocks is closed.
 *
 * Snap rule (nearest upcoming block-open; confirmed with the maintainer):
 *   - floor disabled / empty schedule        → unchanged
 *   - instant falls inside any block          → unchanged
 *   - instant before a later block same day   → that block's open
 *     (covers before-first-open AND lunch gaps)
 *   - otherwise                               → first block of the next
 *                                               open day, at its open
 */

/**
 * Wall-clock components of `date` as observed in IANA zone `tz`.
 * Returns { y, mo, d, hh, mi, ss } with mo 1-12, hh 0-23.
 */
function getZonedParts(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  let hh = parseInt(map.hour, 10);
  // Some engines render midnight as "24" under hour12:false; normalise.
  if (hh === 24) hh = 0;
  return {
    y: parseInt(map.year, 10),
    mo: parseInt(map.month, 10),
    d: parseInt(map.day, 10),
    hh,
    mi: parseInt(map.minute, 10),
    ss: parseInt(map.second, 10) || 0,
  };
}

/** ISO weekday (1=Mon … 7=Sun) for a plain calendar date. */
function isoWeekday(y, mo, d) {
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); // 0=Sun … 6=Sat
  return dow === 0 ? 7 : dow;
}

/** Offset (ms) between zone `tz` wall-clock and UTC at instant `utcMs`. */
function tzOffsetMs(utcMs, tz) {
  const p = getZonedParts(new Date(utcMs), tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.hh, p.mi, p.ss);
  return asUtc - utcMs;
}

/**
 * Convert a wall-clock time (interpreted in zone `tz`) to a UTC instant.
 * Two-pass offset resolution so it stays correct across DST boundaries.
 */
function zonedWallClockToUtc(y, mo, d, hh, mi, tz) {
  const naiveUtc = Date.UTC(y, mo - 1, d, hh, mi, 0);
  let result = naiveUtc - tzOffsetMs(naiveUtc, tz);
  result = naiveUtc - tzOffsetMs(result, tz);
  return new Date(result);
}

/** "HH:MM" → minutes from midnight, or null when malformed. */
function parseHHMM(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** minutes from midnight → "HH:MM" (24h, zero-padded). */
function minutesToHHMM(minutes) {
  const hh = Math.floor(minutes / 60);
  const mi = minutes % 60;
  return `${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/** Add `n` calendar days to a {y,mo,d}, returning the same shape. */
function addDays(y, mo, d, n) {
  const dt = new Date(Date.UTC(y, mo - 1, d + n));
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/**
 * Validate + clean a raw weekly schedule into the canonical storage shape.
 *
 * Accepts the JSON object (or a JSON string), keyed by ISO weekday. Each
 * day's value is an array of blocks; a block may be {start,end} or a
 * [start,end] pair. Invalid blocks (bad HH:MM, end<=start) are dropped;
 * blocks are sorted by start. Days are emitted as string keys "1".."7"
 * with an array value (possibly empty = closed).
 *
 * Returns { "1": [{start,end}], ..., "7": [] } — never throws.
 */
function normaliseSchedule(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch (_) { obj = null; }
  }
  const out = {};
  for (let iso = 1; iso <= 7; iso += 1) out[String(iso)] = [];
  if (!obj || typeof obj !== 'object') return out;

  for (let iso = 1; iso <= 7; iso += 1) {
    const dayRaw = obj[String(iso)] !== undefined ? obj[String(iso)] : obj[iso];
    if (!Array.isArray(dayRaw)) continue;
    const blocks = [];
    for (const b of dayRaw) {
      let startStr;
      let endStr;
      if (Array.isArray(b)) {
        [startStr, endStr] = b;
      } else if (b && typeof b === 'object') {
        startStr = b.start;
        endStr = b.end;
      }
      const startMin = parseHHMM(startStr);
      const endMin = parseHHMM(endStr);
      if (startMin == null || endMin == null || endMin <= startMin) continue;
      blocks.push({ start: minutesToHHMM(startMin), end: minutesToHHMM(endMin), startMin, endMin });
    }
    blocks.sort((a, b) => a.startMin - b.startMin);
    out[String(iso)] = blocks.map((b) => ({ start: b.start, end: b.end }));
  }
  return out;
}

/** True when at least one weekday carries at least one opening block. */
function hasAnyBlocks(schedule) {
  if (!schedule || typeof schedule !== 'object') return false;
  for (let iso = 1; iso <= 7; iso += 1) {
    const day = schedule[String(iso)];
    if (Array.isArray(day) && day.length > 0) return true;
  }
  return false;
}

/** Blocks for an ISO weekday as sorted {startMin,endMin}, parsed fresh. */
function blocksForDay(schedule, iso) {
  const day = schedule[String(iso)];
  if (!Array.isArray(day)) return [];
  const out = [];
  for (const b of day) {
    const startMin = parseHHMM(b && b.start);
    const endMin = parseHHMM(b && b.end);
    if (startMin == null || endMin == null || endMin <= startMin) continue;
    out.push({ startMin, endMin });
  }
  out.sort((a, b) => a.startMin - b.startMin);
  return out;
}

/**
 * Snap a Date to the configured business-hours window.
 *
 * @param {Date} date the requested send instant
 * @param {Object} cfg
 * @param {boolean} cfg.enabled
 * @param {string}  cfg.timezone IANA zone (resolved by caller; never "")
 * @param {Object}  cfg.schedule per-ISO-weekday blocks (see module docs)
 * @returns {Date} the (possibly unchanged) send instant
 */
function snapToBusinessHours(date, cfg) {
  if (!cfg || !cfg.enabled) return date;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return date;
  const { timezone, schedule } = cfg;
  if (!hasAnyBlocks(schedule)) return date; // nothing to snap to

  const p = getZonedParts(date, timezone);
  const iso = isoWeekday(p.y, p.mo, p.d);
  const tMin = p.hh * 60 + p.mi;

  const today = blocksForDay(schedule, iso);
  for (const block of today) {
    // Inside an open block → leave the instant untouched.
    if (tMin >= block.startMin && tMin < block.endMin) return date;
  }
  // Before a later block today (covers before-first-open AND lunch gaps):
  // snap up to the nearest block whose open is still ahead.
  for (const block of today) {
    if (tMin < block.startMin) {
      return zonedWallClockToUtc(
        p.y, p.mo, p.d, Math.floor(block.startMin / 60), block.startMin % 60, timezone
      );
    }
  }

  // After the last block today, or a closed day: walk forward to the first
  // open block of the next open day. Bounded at 14 days as a safety stop;
  // hasAnyBlocks above guarantees the loop terminates well within that.
  let cur = { y: p.y, mo: p.mo, d: p.d };
  for (let i = 1; i <= 14; i += 1) {
    cur = addDays(cur.y, cur.mo, cur.d, 1);
    const dayBlocks = blocksForDay(schedule, isoWeekday(cur.y, cur.mo, cur.d));
    if (dayBlocks.length > 0) {
      const open = dayBlocks[0].startMin;
      return zonedWallClockToUtc(
        cur.y, cur.mo, cur.d, Math.floor(open / 60), open % 60, timezone
      );
    }
  }
  return date;
}

module.exports = {
  snapToBusinessHours,
  parseHHMM,
  minutesToHHMM,
  normaliseSchedule,
  hasAnyBlocks,
  _internal: {
    getZonedParts,
    isoWeekday,
    zonedWallClockToUtc,
    addDays,
    blocksForDay,
  },
};
