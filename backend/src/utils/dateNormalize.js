/**
 * Coerce any of the shapes a TIMESTAMP column produces across our
 * supported drivers into a single ISO 8601 string the frontend (and
 * any external API consumer) can safely pass to date-fns / new Date.
 *
 * Postgres → Date object (becomes ISO via JSON.stringify anyway, but
 *   pinning the format defends against driver-side surprises).
 * SQLite → integer milliseconds since epoch when a raw `new Date()` was
 *   written through knex (the surface that crashed the admin Users page
 *   in #485 — `parseISO(123456789)` blows up with "e.split is not a
 *   function"). Native installs default to SQLite, so this path matters
 *   every release.
 * Already a string → assume it's a parseable ISO/RFC3339 (Postgres
 *   driver may stringify under JSON serialization mid-pipeline).
 *
 * Returns null/undefined unchanged so an unset value surfaces as
 * "Never" in the UI rather than 1970-01-01T00:00:00Z.
 *
 * Extracted from routes/adminUsers.js (#485) so every route that
 * serializes timestamps can share one contract.
 */
function toIso(value) {
  if (value === null || value === undefined || value === '') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string') {
    // Numeric-as-string ("1778752458666") happens when the SQLite
    // driver stringifies large integers — re-coerce so the frontend
    // doesn't try to parseISO('1778752458666').
    if (/^\d{10,}$/.test(value)) return new Date(Number(value)).toISOString();
    return value;
  }
  return value;
}

// 'YYYY-MM-DD HH:MM[:SS[.sss]]' (or with a 'T') and no zone: SQLite's
// CURRENT_TIMESTAMP shape, which is UTC.
const ZONELESS_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

// Shared comparison boundary for SQLite epoch values and PostgreSQL Dates.
// Invalid input stays NaN so access-control callers can fail closed.
// A zone-less date-time is read as UTC, as SQLite's julianday() and the
// frontend read it; new Date() alone would read it in the server's zone.
function toTimestamp(value) {
  if (value === null || value === undefined || value === '') return NaN;
  try {
    const iso = toIso(value);
    if (typeof iso === 'string' && ZONELESS_DATETIME.test(iso.trim())) {
      return new Date(`${iso.trim().replace(' ', 'T')}Z`).getTime();
    }
    return new Date(iso).getTime();
  } catch (_) {
    return NaN;
  }
}

// A timestamp as the wall-clock time it shows in the server's own zone,
// 'YYYY-MM-DDTHH:MM:SS' with no zone, or null. For photos.captured_at:
// exifr reads the camera's zone-less EXIF time in the server's zone
// (imageProcessor.extractCaptureDate), so formatting the stored instant
// back in that zone returns the camera clock. A browser formatting the
// instant in its own zone would shift it by the difference (issue 1739).
function toServerWallClock(value) {
  const ms = toTimestamp(value);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// photos.captured_at_wall (issue 2305) as 'YYYY-MM-DDTHH:MM:SS', the
// recorded offset dropped: the list shows the camera's own clock. null
// for NULL, '' (read, none) or anything else.
function cameraWallClock(value) {
  const m = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.exec(typeof value === 'string' ? value : '');
  return m ? m[0] : null;
}

/**
 * A value as a Date. A bare "2025-07-16" is that calendar day on this server:
 * read as midnight UTC it would print the day before west of Greenwich. Lives
 * here, not in dateFormatter, because the PDF render worker can't load the db.
 */
function parseCalendarDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map((num) => parseInt(num, 10));
    return new Date(year, month - 1, day);
  }
  return new Date(value);
}

module.exports = { toIso, toTimestamp, toServerWallClock, cameraWallClock, parseCalendarDate };
